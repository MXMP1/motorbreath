import * as THREE from 'three';

// Слияние простых геометрий в одну (только позиции + пересчёт гранёных нормалей).
// Нужен для instanced-декора: куст, бак, мешок — каждый склеен из нескольких кусков.
export function mergeGeometries(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  let off = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, off);
    off += g.attributes.position.array.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
