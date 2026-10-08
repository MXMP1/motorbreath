import * as THREE from 'three';
import { mergeGeometries } from './merge.js';

// Кусты: три слитых «шара» — одна геометрия, весь кустарник в одном InstancedMesh.
// От удара (палка или пуля) куст дрожит и затухает, как деревья, только мельче:
// матрицы обновляются лишь пока есть активные качания.
export class Bushes {
  constructor(list, cfg) {
    this.list = list;
    this.cfg = cfg;
    this.sway = new Map(); // index -> { power, phase }
    this.time = 0;

    const n = Math.max(1, list.length);
    const geo = makeBushGeometry();
    const mat = new THREE.MeshLambertMaterial({ color: cfg.palette.bush, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // переиспользуемые временные объекты — ноль аллокаций в игровом цикле
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._axis = new THREE.Vector3();

    list.forEach((b, i) => {
      this._q.setFromAxisAngle(UP, b.rot);
      this._p.set(b.x, b.y, b.z);
      this._s.set(b.s, b.s, b.s);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);

      this._c.set(cfg.palette.bush).multiplyScalar(b.tint);
      this.mesh.setColorAt(i, this._c);
    });

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  get swayCount() { return this.sway.size; }

  // Индекс ближайшего куста к точке удара, или -1.
  findNearest(x, y, z, radius) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const b = this.list[i];
      const dy = y - (b.y + 0.45 * b.s);
      if (Math.abs(dy) > 1.1 * b.s) continue;
      const d2 = (b.x - x) ** 2 + (b.z - z) ** 2;
      if (d2 < radius * radius && d2 < bestD) { best = i; bestD = d2; }
    }
    return best;
  }

  hit(index) {
    const b = this.list[index];
    if (!b) return false;
    this.sway.set(index, { power: 1, phase: Math.random() * Math.PI * 2 });
    return true;
  }

  // Обновление дрожи. Возвращает число качающихся кустов (для HUD).
  update(dt) {
    if (this.sway.size === 0) return 0;
    this.time += dt;

    for (const [i, s] of [...this.sway]) {
      s.power *= Math.exp(-3.4 * dt);
      if (s.power < 0.01) { this.sway.delete(i); continue; }

      const b = this.list[i];
      const angle = Math.sin(this.time * 21 + s.phase) * 0.16 * s.power;
      // ось наклона — «локальный X» куста после поворота вокруг Y
      this._axis.set(Math.cos(b.rot), 0, -Math.sin(b.rot));
      this._q1.setFromAxisAngle(UP, b.rot);
      this._q2.setFromAxisAngle(this._axis, angle);
      this._q.multiplyQuaternions(this._q2, this._q1);
      this._p.set(b.x, b.y, b.z);
      this._s.set(b.s, b.s, b.s);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    return this.sway.size;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

// Три приплюснутых икосаэдра, слитых в буфер позиций; основание куста — на y=0.
function makeBushGeometry() {
  const blobs = [
    [0, 0, 0, 0.75],
    [0.5, 0.18, 0.15, 0.5],
    [-0.42, 0.12, -0.2, 0.45],
  ];
  const parts = blobs.map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, 0.8, 1);
    g.translate(x, y, z);
    return g;
  });
  const geo = mergeGeometries(parts);
  geo.translate(0, 0.55, 0); // сажаем основание куста на землю
  return geo;
}
