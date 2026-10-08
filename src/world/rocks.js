import * as THREE from 'three';

// Камни: весь разброс (валуны и мелочь) — один InstancedMesh, один draw call.
// Форма — низкополигональный додекаэдр; разнообразие даёт неоднородный масштаб,
// наклон и оттенок. Крупным камням расстановка выдаёт AABB-коллайдеры (rockColliders).
export class Rocks {
  constructor(list, cfg) {
    const n = Math.max(1, list.length);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshLambertMaterial({ color: cfg.palette.rock, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);

    // переиспользуемые временные объекты — ноль аллокаций при сборке больших списков
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    list.forEach((r, i) => {
      this._e.set(r.rx, r.ry, r.rz);
      this._q.setFromEuler(this._e);
      this._p.set(r.x, r.y, r.z);
      this._s.set(r.sx, r.sy, r.sz);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);

      this._c.set(cfg.palette.rock).multiplyScalar(r.tint);
      this.mesh.setColorAt(i, this._c);
    });

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
