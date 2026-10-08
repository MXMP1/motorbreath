import * as THREE from 'three';
import { mulberry32, makeFbm2D } from '../core/noise.js';

// Земля мира: рельеф и городское покрытие. Оба меша повторяют аналитический
// heightmap и слегка приподняты, чтобы покрытие не воевало с землёй за пиксели.

// Меш рельефа из аналитического heightmap.
// Цвет вершин по высоте (трава -> земля -> камень -> снег) + flat shading — low-poly вид.
export function createTerrain(heightmap, cfg) {
  const { sizeX, sizeZ } = cfg.world;
  const segX = 104; // ~3.5 м клетка: крупные треугольники отлично сочетаются с пиксель-стилем
  const segZ = 220;

  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ);
  geo.rotateX(-Math.PI / 2);

  const jitter = makeFbm2D(mulberry32((cfg.seed ^ 0x51ed270b) >>> 0), 3, 2, 0.5);
  const cGrass = new THREE.Color(cfg.palette.grass);
  const cDirt = new THREE.Color(cfg.palette.dirt);
  const cRock = new THREE.Color(cfg.palette.rock);
  const cPeak = new THREE.Color(cfg.palette.peak);
  const tmp = new THREE.Color();
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = heightmap.heightAt(x, z);
    pos.setY(i, y);

    const n = jitter(x * 0.08, z * 0.08);
    if (y < 6) {
      tmp.copy(cGrass).lerp(cDirt, clamp01((n - 0.45) * 1.6));
    } else if (y < 18) {
      tmp.copy(cDirt).lerp(cRock, clamp01((y - 6) / 12 + (n - 0.5) * 0.6));
    } else {
      tmp.copy(cRock).lerp(cPeak, clamp01((y - 18) / 28 + (n - 0.5) * 0.5));
    }
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true; // земля принимает тени от костра лагеря
  return mesh;
}

// Городское покрытие: асфальтовая плита на всю городскую зону и светлые
// «тротуары» под домами.
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
