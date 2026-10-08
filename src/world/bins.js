import * as THREE from 'three';
import { mergeGeometries } from './merge.js';
import { Props } from './props.js';

// Мусорные баки: корпус + крышка одной слитой геометрией, весь ряд — один InstancedMesh.
// Баки тоже с физикой, но тяжёлые: от пинка/пули еле сдвигаются и не кувыркаются —
// вращение только вокруг вертикальной оси. Сквозь них нельзя пройти: AABB-коллайдер
// едет за баком (его читают игрок, манекены и мешки).
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
