import * as THREE from 'three';
import { mergeGeometries } from '../core/merge.js';

// Растительность и камни: instanced-декор, весь вид — один-два draw call.
// От удара (палка или пуля) предмет дрожит и затухает; матрицы обновляются,
// только пока есть активные качания, иначе — ноль работы на кадр.

const UP = new THREE.Vector3(0, 1, 0);

// База качающегося декора: список расстановки, карта активных качаний, поиск
// ближайшего к точке удара и общий цикл `update`. Подкласс создаёт меши и
// переопределяет `_writeSway`/`_flushSway` — куда писать матрицу.
//   decay — затухание дрожи, 1/с;   freq — частота, рад/с;   amp — амплитуда, рад;
//   hitY  — высота точки удара в долях масштаба;  hitH — полувысота зоны удара в долях масштаба.
class Swaying {
  constructor(list, sway) {
    this.list = list;
    this.decay = sway.decay;
    this.freq = sway.freq;
    this.amp = sway.amp;
    this.hitY = sway.hitY;
    this.hitH = sway.hitH;
    this.sway = new Map(); // index -> { power, phase }
    this.time = 0;

    // переиспользуемые временные объекты — ноль аллокаций в игровом цикле
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  get swayCount() { return this.sway.size; }

  // Индекс ближайшего предмета к точке удара, или -1.
  findNearest(x, y, z, radius) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const it = this.list[i];
      const dy = y - (it.y + this.hitY * it.s);
      if (Math.abs(dy) > this.hitH * it.s) continue;
      const d2 = (it.x - x) ** 2 + (it.z - z) ** 2;
      if (d2 < radius * radius && d2 < bestD) { best = i; bestD = d2; }
    }
    return best;
  }

  hit(index) {
    if (!this.list[index]) return false;
    this.sway.set(index, { power: 1, phase: Math.random() * Math.PI * 2 });
    return true;
  }

  // Обновление дрожи. Возвращает число качающихся предметов (для HUD).
  update(dt) {
    if (this.sway.size === 0) return 0;
    this.time += dt;

    for (const [i, s] of [...this.sway]) {
      s.power *= Math.exp(-this.decay * dt);
      if (s.power < 0.01) { this.sway.delete(i); continue; }

      const it = this.list[i];
      const angle = Math.sin(this.time * this.freq + s.phase) * this.amp * s.power;
      // ось наклона — «локальный X» предмета после поворота вокруг Y
      this._axis.set(Math.cos(it.rot), 0, -Math.sin(it.rot));
      this._q1.setFromAxisAngle(UP, it.rot);
      this._q2.setFromAxisAngle(this._axis, angle);
      this._q.multiplyQuaternions(this._q2, this._q1);
      this._p.set(it.x, it.y, it.z);
      this._s.set(it.s, it.s, it.s);
      this._m.compose(this._p, this._q, this._s);
      this._writeSway(i, this._m);
    }

    this._flushSway();
    return this.sway.size;
  }

  _writeSway(i, m) {}
  _flushSway() {}
}

// Лес: два InstancedMesh (стволы + кроны) — весь лес в двух draw call.
// Качается только крона: ствол держится прямо.
export class Trees extends Swaying {
  constructor(list, cfg) {
    super(list, { decay: 2.6, freq: 17, amp: 0.12, hitY: 1.4, hitH: 2.6 });
    this.cfg = cfg;

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

    list.forEach((t, i) => {
      this._q.setFromAxisAngle(UP, t.rot);
      this._p.set(t.x, t.y, t.z);
      this._s.set(t.s, t.s, t.s);
      this._m.compose(this._p, this._q, this._s);
      this.trunks.setMatrixAt(i, this._m);
      this.crowns.setMatrixAt(i, this._m);

      this._c.set(cfg.palette.foliage).multiplyScalar(t.tint);
      this.crowns.setColorAt(i, this._c);
    });

    this.trunks.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
    if (this.crowns.instanceColor) this.crowns.instanceColor.needsUpdate = true;
  }

  addTo(scene) {
    scene.add(this.trunks);
    scene.add(this.crowns);
  }

  _writeSway(i, m) { this.crowns.setMatrixAt(i, m); }
  _flushSway() { this.crowns.instanceMatrix.needsUpdate = true; }
}

// Кусты: три слитых «шара» — одна геометрия, весь кустарник в одном InstancedMesh.
export class Bushes extends Swaying {
  constructor(list, cfg) {
    super(list, { decay: 3.4, freq: 21, amp: 0.16, hitY: 0.45, hitH: 1.1 });
    this.cfg = cfg;

    const n = Math.max(1, list.length);
    const geo = makeBushGeometry();
    const mat = new THREE.MeshLambertMaterial({ color: cfg.palette.bush, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

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

  _writeSway(i, m) { this.mesh.setMatrixAt(i, m); }
  _flushSway() { this.mesh.instanceMatrix.needsUpdate = true; }
}

// Камни: весь разброс (валуны и мелочь) — один InstancedMesh, один draw call.
// Форма — низкополигональный додекаэдр; разнообразие даёт неоднородный масштаб,
// наклон и оттенок. Крупным камням расстановка выдаёт AABB-коллайдеры (rockColliders).
// Не качается: камень жёсткий, по нему бьют — он и так коллайдер.
export class Rocks {
  constructor(list, cfg) {
    const n = Math.max(1, list.length);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshLambertMaterial({ color: cfg.palette.rock, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);

    // переиспользуемые временные объекты — ноль аллокаций при сборке больших списков
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();

    list.forEach((r, i) => {
      e.set(r.rx, r.ry, r.rz);
      q.setFromEuler(e);
      p.set(r.x, r.y, r.z);
      s.set(r.sx, r.sy, r.sz);
      m.compose(p, q, s);
      this.mesh.setMatrixAt(i, m);

      c.set(cfg.palette.rock).multiplyScalar(r.tint);
      this.mesh.setColorAt(i, c);
    });

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

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
