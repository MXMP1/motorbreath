import * as THREE from 'three';

// Лес: два InstancedMesh (стволы + кроны) — весь лес в двух draw call.
// Удар по дереву запускает затухающее покачивание кроны; матрицы обновляются,
// только пока есть активные качания, иначе — ноль работы на кадр.
export class Trees {
  constructor(list, cfg) {
    this.list = list;
    this.cfg = cfg;
    this.sway = new Map(); // index -> { power, phase }
    this.time = 0;

    const n = Math.max(1, list.length);

    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.2, 1.6, 5);
    trunkGeo.translate(0, 0.8, 0);
    const crownGeo = new THREE.ConeGeometry(1.05, 2.3, 6);
    crownGeo.translate(0, 2.55, 0); // крона сидит на верхушке ствола

    const trunkMat = new THREE.MeshLambertMaterial({ color: cfg.palette.trunk, flatShading: true });
    const crownMat = new THREE.MeshLambertMaterial({ color: cfg.palette.foliage, flatShading: true });

    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
    this.crowns = new THREE.InstancedMesh(crownGeo, crownMat, n);
    this.crowns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // переиспользуемые временные объекты — ноль аллокаций в игровом цикле
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._axis = new THREE.Vector3();
    this._color = new THREE.Color();

    list.forEach((t, i) => {
      this._q.setFromAxisAngle(this._up, t.rot);
      this._p.set(t.x, t.y, t.z);
      this._s.set(t.s, t.s, t.s);
      this._m.compose(this._p, this._q, this._s);
      this.trunks.setMatrixAt(i, this._m);
      this.crowns.setMatrixAt(i, this._m);

      this._color.set(cfg.palette.foliage).multiplyScalar(t.tint);
      this.crowns.setColorAt(i, this._color);
    });

    this.trunks.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
    if (this.crowns.instanceColor) this.crowns.instanceColor.needsUpdate = true;
  }

  addTo(scene) {
    scene.add(this.trunks);
    scene.add(this.crowns);
  }

  // Индекс ближайшего дерева к точке удара, или -1.
  findNearest(x, y, z, radius) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      const dy = y - (t.y + 1.4 * t.s);
      if (Math.abs(dy) > 2.6 * t.s) continue;
      const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
      if (d2 < radius * radius && d2 < bestD) { best = i; bestD = d2; }
    }
    return best;
  }

  hit(index) {
    const t = this.list[index];
    if (!t) return false;
    this.sway.set(index, { power: 1, phase: Math.random() * Math.PI * 2 });
    return true;
  }

  // Обновление покачивания. Возвращает число качающихся деревьев (для HUD).
  update(dt) {
    if (this.sway.size === 0) return 0;
    this.time += dt;

    for (const [i, s] of [...this.sway]) {
      s.power *= Math.exp(-2.6 * dt);
      if (s.power < 0.01) { this.sway.delete(i); continue; }

      const t = this.list[i];
      const angle = Math.sin(this.time * 17 + s.phase) * 0.12 * s.power;
      // ось наклона — «локальный X» дерева после поворота вокруг Y
      this._axis.set(Math.cos(t.rot), 0, -Math.sin(t.rot));
      this._q1.setFromAxisAngle(this._up, t.rot);
      this._q2.setFromAxisAngle(this._axis, angle);
      this._q.multiplyQuaternions(this._q2, this._q1);
      this._p.set(t.x, t.y, t.z);
      this._s.set(t.s, t.s, t.s);
      this._m.compose(this._p, this._q, this._s);
      this.crowns.setMatrixAt(i, this._m);
    }

    this.crowns.instanceMatrix.needsUpdate = true;
    return this.sway.size;
  }
}
