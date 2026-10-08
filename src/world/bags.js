import * as THREE from 'three';
import { mergeGeometries } from './merge.js';
import { Props } from './props.js';

// Мусорные мешки: лёгкие — их можно пинать палкой и сдувать выстрелом.
// Физика тела — в общем классе Props (как у баков): гравитация, пол, отскок,
// трение и сон. Спящая куча бесплатна: работает только разбуженное.
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

// Будим спящие мешки, по которым проехал проснувшийся бак
// (зовётся каждый шаг после world.bins.update).
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
