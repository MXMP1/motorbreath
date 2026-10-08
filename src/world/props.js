import * as THREE from 'three';
import { resolveCircleAabb } from '../core/collide.js';
import { mergeGeometries } from '../core/merge.js';

// Уличный мусор: общая физика предметов и два вида — лёгкие мешки и тяжёлые баки.
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
    this.world = world; // { heightmap, sizeX, sizeZ, cityLift? }
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

// ---------- мусорные мешки ----------

// Лёгкий вид: слабое трение, высокий отскок, свободное кувыркание.
const BAG_PHYS = {
  radius: 0.3,
  friction: 5,
  spinDecay: 3.5,
  wallRest: 0.35,
  landRest: 0.7,
  restY: 0.3,
  restSpin: 0.6,
  upright: false,
};

// Мусорные мешки: лёгкие — их можно пинать палкой и сдувать выстрелом.
// Спящая куча бесплатна: работает только разбуженное.
export class TrashBags extends Props {
  constructor(list, cfg, world) {
    super(makeBagMesh(list, cfg), list, cfg, world, BAG_PHYS);
    for (let i = 0; i < this.units.length; i++) {
      this._c.set(cfg.palette.bag).multiplyScalar(this.units[i].tint);
      this.mesh.setColorAt(i, this._c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// Будим спящие мешки, по которым проехал проснувшийся бак
// (зовётся каждый шаг после bins.update).
export function pushBagsByBins(bags, bins, push) {
  for (const b of bins.units) {
    if (!b.awake) continue;
    for (let j = 0; j < bags.units.length; j++) {
      const v = bags.units[j];
      if (v.awake) continue;
      const dx = v.pos.x - b.pos.x;
      const dz = v.pos.z - b.pos.z;
      const r = 0.75; // бак вплотную к мешку
      if (dx * dx + dz * dz > r * r) continue;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      bags.hit(j, { x: dx / d, z: dz / d }, push);
    }
  }
}

function makeBagMesh(list, cfg) {
  const n = Math.max(1, list.length);
  const geo = makeBagGeometry();
  const mat = new THREE.MeshLambertMaterial({ color: cfg.palette.bag, flatShading: true });
  return new THREE.InstancedMesh(geo, mat, n);
}

// Пухлый кулёк с хвостиком-завязкой; основание мешка — на y=0.
function makeBagGeometry() {
  const blob = new THREE.IcosahedronGeometry(0.3, 0);
  blob.scale(1, 0.82, 1);
  blob.translate(0, 0.245, 0);

  const tail = new THREE.CylinderGeometry(0.028, 0.1, 0.16, 5);
  tail.translate(0, 0.55, 0);

  const knot = new THREE.BoxGeometry(0.075, 0.05, 0.05);
  knot.translate(0, 0.645, 0);

  return mergeGeometries([blob, tail, knot]);
}

// ---------- мусорные баки ----------

// Тяжёлый вид: сильное трение, слабый отскок, вращение только вокруг вертикали.
const BIN_PHYS = {
  radius: 0.36,
  friction: 7.5,
  spinDecay: 6,
  wallRest: 0.2,
  landRest: 0.45,
  restY: 0.12,
  restSpin: 0.35,
  upright: true,
};

// Мусорные баки: корпус + крышка одной слитой геометрией, весь ряд — один InstancedMesh.
// Баки тоже с физикой, но тяжёлые: от пинка/пули еле сдвигаются и не кувыркаются.
// Сквозь них нельзя пройти: AABB-коллайдер едет за баком (его читают игрок, NPC и мешки).
export class Bins extends Props {
  constructor(list, cfg, world, cols) {
    // своё окружение — без коллайдеров баков: бак не толкает сам себя
    const env = cols && cols.length ? world.colliders.filter((c) => !cols.includes(c)) : world.colliders;
    super(makeBinMesh(list, cfg), list, cfg, world, BIN_PHYS, env);

    this.cols = cols || null;
    if (this.cols && this.cols.length) {
      const c = this.cols[0];
      this._hx = (c.maxX - c.minX) / 2; // половинки AABB — при сдвиге едут за баком
      this._hz = (c.maxZ - c.minZ) / 2;
    }

    for (let i = 0; i < this.units.length; i++) {
      this._c.set(cfg.palette.bin).multiplyScalar(this.units[i].tint);
      this.mesh.setColorAt(i, this._c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  onUnitMoved(i, u) {
    if (!this.cols) return;
    const c = this.cols[i];
    if (!c) return;
    c.minX = u.pos.x - this._hx;
    c.maxX = u.pos.x + this._hx;
    c.minZ = u.pos.z - this._hz;
    c.maxZ = u.pos.z + this._hz;
  }
}

function makeBinMesh(list, cfg) {
  const n = Math.max(1, list.length);
  const geo = makeBinGeometry(cfg);
  const mat = new THREE.MeshLambertMaterial({ color: cfg.palette.bin, flatShading: true });
  return new THREE.InstancedMesh(geo, mat, n);
}

// Корпус с крышкой-козырьком; основание бака — на y=0.
function makeBinGeometry(cfg) {
  const h = cfg.street.binHeight;

  const body = new THREE.BoxGeometry(0.55, h - 0.12, 0.46);
  body.translate(0, (h - 0.12) / 2, 0);

  const lid = new THREE.BoxGeometry(0.62, 0.12, 0.54);
  lid.translate(0, h - 0.06, 0);

  return mergeGeometries([body, lid]);
}
