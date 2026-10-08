import * as THREE from 'three';
import { resolveCircleAabb } from '../core/collide.js';

// Общая физика уличных предметов: лёгкие мешки и тяжёлые баки крутит один цикл.
// Тело простое: гравитация, пол (рельеф + городское покрытие + крыши коробок),
// отскок, трение и сон. Пока предмет спит — он бесплатен: матрицы обновляются
// только для разбуженных. Вращение — кватернион из угловой скорости.
// Вид задаёт phys-набор подкласса:
//   radius    — радиус круга для коллизий (он же запас при поиске пола),
//   friction  — трение о землю, 1/с (больше — «тяжелее» скольжение),
//   spinDecay — затухание вращения, 1/с,
//   wallRest / landRest — сколько скорости сохраняется при ударе о стену и отскоке,
//   restY / restSpin — упругость по вертикали и остаток вращения при отскоке,
//   upright   — тяжёлый вид не кувыркается: вращение только вокруг вертикальной оси.
const UP = new THREE.Vector3(0, 1, 0);

export class Props {
  constructor(mesh, list, cfg, world, phys, env) {
    this.cfg = cfg;
    this.world = world; // { heightmap, size, cityLift? }
    this.phys = phys;
    this.env = env || world.colliders; // окружение для коллизий и пола
    this.units = [];
    this.mesh = mesh;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // переиспользуемые временные объекты — ноль аллокаций в игровом цикле
    this._m = new THREE.Matrix4();
    this._e = new THREE.Euler();
    this._dq = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    list.forEach((it, i) => {
      const ground = this.groundBelow(it.x, it.z, it.y + 1);
      const u = {
        pos: new THREE.Vector3(it.x, ground, it.z),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        quat: new THREE.Quaternion().setFromEuler(this._e.set(it.rx || 0, it.ry || 0, it.rz || 0)),
        s: it.s !== undefined ? it.s : 1,
        tint: it.tint !== undefined ? it.tint : 1,
        home: { x: it.x, z: it.z, rx: it.rx || 0, ry: it.ry || 0, rz: it.rz || 0 },
        awake: false,
      };
      this.units.push(u);
      this._composeUnit(u, i);
    });

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get awakeCount() {
    let n = 0;
    for (const u of this.units) if (u.awake) n++;
    return n;
  }

  // Пинок/выстрел: dir — горизонтальное направление, imp — конфиг импульса.
  hit(i, dir, imp) {
    const u = this.units[i];
    if (!u) return false;
    u.awake = true;
    u.vel.x += dir.x * imp.knockback;
    u.vel.z += dir.z * imp.knockback;
    u.vel.y += imp.knockUp * (0.6 + Math.random() * 0.6);
    if (this.phys.upright) {
      u.spin.set(0, (Math.random() - 0.5) * imp.spin, 0); // тяжёлый: только поворот
    } else {
      u.spin.set(
        (Math.random() - 0.5) * imp.spin,
        (Math.random() - 0.5) * imp.spin,
        (Math.random() - 0.5) * imp.spin,
      );
    }
    return true;
  }

  update(dt) {
    const limX = this.world.sizeX / 2 - 2;
    const limZ = this.world.sizeZ / 2 - 2;
    const phys = this.phys;
    let dirty = false;

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.awake) continue;
      dirty = true;

      u.vel.y -= this.cfg.player.gravity * dt;
      u.pos.x += u.vel.x * dt;
      u.pos.z += u.vel.z * dt;
      u.pos.y += u.vel.y * dt;

      // дома, валуны, баки (без коллайдеров собственного вида)
      const res = resolveCircleAabb(u.pos.x, u.pos.z, phys.radius, u.pos.y, 0.6, this.env);
      if (res.hit) {
        u.pos.x = res.x;
        u.pos.z = res.z;
        u.vel.x *= -phys.wallRest;
        u.vel.z *= -phys.wallRest;
      }

      // границы мира
      u.pos.x = Math.max(-limX, Math.min(limX, u.pos.x));
      u.pos.z = Math.max(-limZ, Math.min(limZ, u.pos.z));

      // пол: рельеф + городское покрытие + крыши коробок
      const ground = this.groundBelow(u.pos.x, u.pos.z, u.pos.y);
      let grounded = false;
      if (u.pos.y <= ground) {
        u.pos.y = ground;
        grounded = true;
        if (u.vel.y < -1.5) {
          u.vel.y = -u.vel.y * phys.restY; // отскок
          u.vel.x *= phys.landRest;
          u.vel.z *= phys.landRest;
          u.spin.multiplyScalar(phys.restSpin);
        } else {
          u.vel.y = 0;
          const f = Math.exp(-phys.friction * dt); // трение
          u.vel.x *= f;
          u.vel.z *= f;
          u.spin.multiplyScalar(Math.exp(-phys.spinDecay * dt));
        }
      }

      // вращение: quat' = dq(ω·dt) * quat
      const w = u.spin.length();
      if (w > 1e-4) {
        if (phys.upright) {
          this._dq.setFromAxisAngle(UP, u.spin.y * dt);
        } else {
          this._axis.copy(u.spin).multiplyScalar(1 / w);
          this._dq.setFromAxisAngle(this._axis, w * dt);
        }
        u.quat.premultiply(this._dq);
      }

      // засыпание
      if (grounded && u.vel.lengthSq() < 0.05 && u.spin.lengthSq() < 0.05) {
        u.awake = false;
        u.vel.set(0, 0, 0);
        u.spin.set(0, 0, 0);
      }

      this._composeUnit(u, i);
      this.onUnitMoved(i, u);
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
    return dirty;
  }

  // Хук подкласса: бак синхронизирует свой AABB-коллайдер.
  onUnitMoved(i, u) {}

  _composeUnit(u, i) {
    this._p.copy(u.pos);
    this._s.set(u.s, u.s, u.s);
    this._m.compose(this._p, u.quat, this._s);
    this.mesh.setMatrixAt(i, this._m);
  }

  groundBelow(x, z, feetY) {
    let g = this.world.heightmap.heightAt(x, z);
    if (this.world.cityLift) g += this.world.cityLift(x, z);
    const pad = this.phys.radius;
    for (const b of this.env) {
      if (x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad) {
        if (b.maxY > g && b.maxY <= feetY + 0.4) g = b.maxY;
      }
    }
    return g;
  }

  // Вернуть всё на исходные места (клавиша R).
  resetAll() {
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const h = u.home;
      u.pos.set(h.x, this.groundBelow(h.x, h.z, this.groundBelow(h.x, h.z, 1e9) + 1), h.z);
      u.vel.set(0, 0, 0);
      u.spin.set(0, 0, 0);
      u.quat.setFromEuler(this._e.set(h.rx, h.ry, h.rz));
      u.awake = false;
      this._composeUnit(u, i);
      this.onUnitMoved(i, u);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
