import * as THREE from 'three';
import { resolveCircleAabb } from '../core/collide.js';

// Манекены — учебные цели для палки. Стоят вокруг спавна; при ударе получают импульс
// и живут по простой физике (гравитация, отскок от земли, трение), потом засыпают.
export class Dummies {
  constructor(list, cfg, world) {
    this.cfg = cfg;
    this.world = world; // { heightmap, colliders, size }
    this.group = new THREE.Group();
    this.units = [];

    const bodyMat = new THREE.MeshLambertMaterial({ color: cfg.palette.dummy, flatShading: true });
    const limbMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(cfg.palette.dummy).multiplyScalar(0.72),
      flatShading: true,
    });

    for (const d of list) {
      const g = new THREE.Group();
      g.userData.dummyIndex = this.units.length; // хитсякану нужно знать, в кого попали
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.95, 0.32), bodyMat);
      body.position.y = 1.05;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), limbMat);
      head.position.y = 1.72;
      const legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.75, 0.16), limbMat);
      legL.position.set(-0.14, 0.375, 0);
      const legR = legL.clone();
      legR.position.x = 0.14;
      g.add(body, head, legL, legR);
      g.position.set(d.x, d.y, d.z);
      g.rotation.y = d.rot;
      this.group.add(g);

      this.units.push({
        obj: g,
        pos: new THREE.Vector3(d.x, d.y, d.z), // точка на земле под манекеном
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        home: { x: d.x, z: d.z, rot: d.rot },
        awake: false,
      });
    }
  }

  get awakeCount() {
    let n = 0;
    for (const u of this.units) if (u.awake) n++;
    return n;
  }

  hit(i, dir, stickCfg) {
    const u = this.units[i];
    u.awake = true;
    u.vel.x += dir.x * stickCfg.knockback;
    u.vel.z += dir.z * stickCfg.knockback;
    u.vel.y = Math.max(u.vel.y, 0) + stickCfg.knockUp;
    u.spin.x += (Math.random() - 0.5) * stickCfg.spin;
    u.spin.y += (Math.random() - 0.5) * stickCfg.spin;
    u.spin.z += (Math.random() - 0.5) * stickCfg.spin;
  }

  update(dt) {
    const lim = this.world.size / 2 - 2;
    for (const u of this.units) {
      if (!u.awake) continue;

      u.vel.y -= this.cfg.player.gravity * dt;
      u.pos.x += u.vel.x * dt;
      u.pos.z += u.vel.z * dt;
      u.pos.y += u.vel.y * dt;

      // дома
      const res = resolveCircleAabb(u.pos.x, u.pos.z, 0.35, u.pos.y, 1.8, this.world.colliders);
      if (res.hit) {
        u.pos.x = res.x;
        u.pos.z = res.z;
        u.vel.x *= -0.35;
        u.vel.z *= -0.35;
      }

      // границы мира
      u.pos.x = Math.max(-lim, Math.min(lim, u.pos.x));
      u.pos.z = Math.max(-lim, Math.min(lim, u.pos.z));

      // земля
      const ground = this.groundBelow(u.pos.x, u.pos.z, u.pos.y);
      if (u.pos.y <= ground) {
        u.pos.y = ground;
        if (u.vel.y < -1.5) {
          u.vel.y = -u.vel.y * 0.3; // отскок
          u.vel.x *= 0.7;
          u.vel.z *= 0.7;
          u.spin.multiplyScalar(0.7);
        } else {
          u.vel.y = 0;
          const f = Math.exp(-6 * dt); // трение
          u.vel.x *= f;
          u.vel.z *= f;
          u.spin.multiplyScalar(Math.exp(-4 * dt));
        }
      }

      // вращение и перенос в меш
      u.obj.rotation.x += u.spin.x * dt;
      u.obj.rotation.y += u.spin.y * dt;
      u.obj.rotation.z += u.spin.z * dt;
      u.obj.position.copy(u.pos);

      // засыпание
      if (u.vel.lengthSq() < 0.05 && u.spin.lengthSq() < 0.05 && u.pos.y <= ground + 0.01) {
        u.awake = false;
        u.vel.set(0, 0, 0);
        u.spin.set(0, 0, 0);
      }
    }
  }

  groundBelow(x, z, feetY) {
    let g = this.world.heightmap.heightAt(x, z);
    for (const b of this.world.colliders) {
      if (x >= b.minX - 0.3 && x <= b.maxX + 0.3 && z >= b.minZ - 0.3 && z <= b.maxZ + 0.3) {
        if (b.maxY > g && b.maxY <= feetY + 0.4) g = b.maxY;
      }
    }
    return g;
  }

  // Вернуть всех на исходные позиции (клавиша R).
  resetAll() {
    for (const u of this.units) {
      u.pos.set(u.home.x, this.world.heightmap.heightAt(u.home.x, u.home.z), u.home.z);
      u.vel.set(0, 0, 0);
      u.spin.set(0, 0, 0);
      u.obj.position.copy(u.pos);
      u.obj.rotation.set(0, u.home.rot, 0);
      u.awake = false;
    }
  }
}
