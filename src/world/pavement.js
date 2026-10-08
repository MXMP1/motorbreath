import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';

// Городское покрытие: асфальтовая плита на всю городскую зону и светлые
// «тротуары» под домами. Меши повторяют рельеф — вершины сэмплят heightmap и
// приподняты на пару сантиметров, чтобы покрытие не воевало с землёй за пиксели.
export function createPavement(heightmap, buildings, cfg) {
  const c = cfg.city;
  const group = new THREE.Group();
  const rng = mulberry32((cfg.seed ^ 0x7f4a7c15) >>> 0);

  // --- асфальт: одна плита по всей зоне
  const w = c.halfW * 2;
  const d = c.halfD * 2;
  const geo = new THREE.PlaneGeometry(w, d, Math.round(w / c.gridStep), Math.round(d / c.gridStep));
  geo.rotateX(-Math.PI / 2);
  geo.translate(c.cx, 0, c.cz);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(cfg.palette.asphalt);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, heightmap.heightAt(x, z) + c.asphaltLift);
    tmp.copy(base).multiplyScalar(0.92 + rng() * 0.16); // пиксельная «крошка» асфальта
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const asphalt = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  asphalt.name = 'asphalt';
  group.add(asphalt);

  // --- тротуары: светлые площадки чуть шире каждого дома
  const sideMat = new THREE.MeshLambertMaterial({ color: cfg.palette.sidewalk, flatShading: true });
  for (const b of buildings) {
    const sw = b.w + c.sidewalkPad * 2;
    const sd = b.d + c.sidewalkPad * 2;
    const sg = new THREE.PlaneGeometry(
      sw, sd,
      Math.max(2, Math.round(sw / 1.5)),
      Math.max(2, Math.round(sd / 1.5)),
    );
    sg.rotateX(-Math.PI / 2);
    sg.translate(b.x, 0, b.z);
    const sp = sg.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      sp.setY(i, heightmap.heightAt(sp.getX(i), sp.getZ(i)) + c.sidewalkLift);
    }
    sg.computeVertexNormals();
    const mesh = new THREE.Mesh(sg, sideMat);
    mesh.name = 'sidewalk';
    group.add(mesh);
  }

  return { group };
}
