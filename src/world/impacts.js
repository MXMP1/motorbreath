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

    // Кровь при попадании по NPC: тот же пул-механизм, но красная и мельче —
    // попадание по врагу читается мгновенно.
    this.blood = [];
    this.bloodNext = 0;
    const bloodGeo = new THREE.BoxGeometry(0.045, 0.045, 0.045);
    const bloodMat = new THREE.MeshBasicMaterial({ color: cfg.palette.blood });
    for (let i = 0; i < this.cfg.bloodPool; i++) {
      const mesh = new THREE.Mesh(bloodGeo, bloodMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.blood.push({ mesh, vel: new THREE.Vector3(), life: 0 });
    }
    this.pools = [this.units, this.blood]; // update гоняет обе одинаково

    // Яркие вспышки выстрелов NPC: светящийся кристалл, самого яркого цвета в палитре.
    // Материал без освещения — в тумане боя видно, откуда стреляют.
    this.flashes = [];
    this.flashNext = 0;
    const flashGeo = new THREE.OctahedronGeometry(this.cfg.flashSize / 2);
    const flashMat = new THREE.MeshBasicMaterial({ color: cfg.palette.flash });
    for (let i = 0; i < this.cfg.flashPool; i++) {
      const mesh = new THREE.Mesh(flashGeo, flashMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.flashes.push({ mesh, t: 0 });
    }

    // Трассеры: тонкие полупрозрачные следы пуль. Геометрия — единичный отрезок
    // вдоль +z от начала координат, меш растягивается масштабом до дальности выстрела.
    this.tracers = [];
    this.tracerNext = 0;
    const tracerGeo = new THREE.BoxGeometry(this.cfg.tracerSize, this.cfg.tracerSize, 1);
    tracerGeo.translate(0, 0, 0.5);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: cfg.palette.tracer, transparent: true, opacity: 0.45, depthWrite: false,
    });
    for (let i = 0; i < this.cfg.tracerPool; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, t: 0 });
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

  // Брызги крови в точке попадания по NPC: летят назад и вниз, живут коротко.
  spawnBlood(point, dir) {
    const c = this.cfg;
    for (let i = 0; i < c.bloodSparks; i++) {
      const u = this.blood[this.bloodNext];
      this.bloodNext = (this.bloodNext + 1) % this.blood.length;

      u.life = c.bloodLife * (0.6 + 0.4 * Math.random());
      u.mesh.visible = true;
      u.mesh.scale.setScalar(1);
      u.mesh.position.set(
        point.x + (Math.random() - 0.5) * 0.1,
        point.y + (Math.random() - 0.5) * 0.1,
        point.z + (Math.random() - 0.5) * 0.1,
      );
      u.vel.set(
        -dir.x * c.speed * 0.7 * (0.4 + Math.random()) + (Math.random() - 0.5) * 1.6,
        Math.random() * 1.5,
        -dir.z * c.speed * 0.7 * (0.4 + Math.random()) + (Math.random() - 0.5) * 1.6,
      );
    }
  }

  get activeCount() {
    let n = 0;
    for (const u of this.units) if (u.life > 0) n++;
    return n;
  }

  get bloodCount() {
    let n = 0;
    for (const u of this.blood) if (u.life > 0) n++;
    return n;
  }

  get flashCount() {
    let n = 0;
    for (const f of this.flashes) if (f.t > 0) n++;
    return n;
  }

  get tracerCount() {
    let n = 0;
    for (const t of this.tracers) if (t.t > 0) n++;
    return n;
  }

  // Вспышка выстрела в точке ствола: короткий яркий кристалл.
  flash(pos) {
    const f = this.flashes[this.flashNext];
    this.flashNext = (this.flashNext + 1) % this.flashes.length;
    f.t = this.cfg.flashLife;
    f.mesh.visible = true;
    f.mesh.position.copy(pos);
    f.mesh.scale.setScalar(1.6); // вспыхивает большим — и сжимается за flashLife
  }

  // След пули от ствола до точки: попадание — обрывается в игроке, промах — летит мимо.
  tracer(from, to) {
    const f = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % this.tracers.length;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    f.mesh.position.copy(from);
    f.mesh.lookAt(to.x, to.y, to.z); // у мешей локальное +z смотрит в цель
    f.mesh.scale.set(1, 1, dist);
    f.mesh.visible = true;
    f.t = this.cfg.tracerLife;
  }

  update(dt) {
    for (const pool of this.pools) {
      for (const u of pool) {
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
    for (const f of this.flashes) {
      if (f.t <= 0) continue;
      f.t -= dt;
      if (f.t <= 0) {
        f.mesh.visible = false;
        continue;
      }
      const k = f.t / this.cfg.flashLife;
      f.mesh.scale.setScalar(0.5 + 1.1 * k); // гаснет и сжимается
    }
    for (const t of this.tracers) {
      if (t.t <= 0) continue;
      t.t -= dt;
      if (t.t <= 0) t.mesh.visible = false;
    }
  }
}
