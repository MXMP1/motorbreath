import * as THREE from 'three';

// Искры от попаданий: пул маленьких кубиков, у каждого скорость и жизнь.
// Пул фиксированный — ноль аллокаций в бою.
export class Impacts {
  constructor(cfg) {
    this.cfg = cfg.impacts;
    this.group = new THREE.Group();
    this.units = [];
    this.next = 0;

    const geo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd27a });

    for (let i = 0; i < this.cfg.pool; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.units.push({ mesh, vel: new THREE.Vector3(), life: 0 });
    }
  }

  // Сноп искр в точке попадания; dir — направление выстрела (искры летят назад).
  spawn(point, dir) {
    const c = this.cfg;
    for (let i = 0; i < c.sparks; i++) {
      const u = this.units[this.next];
      this.next = (this.next + 1) % this.units.length;

      u.life = c.life * (0.6 + 0.4 * Math.random());
      u.mesh.visible = true;
      u.mesh.scale.setScalar(1);
      u.mesh.position.set(
        point.x + (Math.random() - 0.5) * 0.06,
        point.y + (Math.random() - 0.5) * 0.06,
        point.z + (Math.random() - 0.5) * 0.06,
      );
      u.vel.set(
        -dir.x * c.speed * (0.5 + Math.random()) + (Math.random() - 0.5) * 2,
        Math.random() * 2,
        -dir.z * c.speed * (0.5 + Math.random()) + (Math.random() - 0.5) * 2,
      );
    }
  }

  get activeCount() {
    let n = 0;
    for (const u of this.units) if (u.life > 0) n++;
    return n;
  }

  update(dt) {
    for (const u of this.units) {
      if (u.life <= 0) continue;
      u.life -= dt;
      if (u.life <= 0) {
        u.mesh.visible = false;
        continue;
      }
      u.vel.y -= this.cfg.gravity * dt;
      u.mesh.position.addScaledVector(u.vel, dt);
      const s = Math.max(0.3, u.life / this.cfg.life);
      u.mesh.scale.setScalar(s);
    }
  }
}
