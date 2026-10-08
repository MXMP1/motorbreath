import * as THREE from 'three';
import { mulberry32, makeFbm2D } from '../core/noise.js';

// Меш рельефа из аналитического heightmap.
// Цвет вершин по высоте (трава -> земля -> камень -> снег) + flat shading — low-poly вид.
export function createTerrain(heightmap, cfg) {
  const size = cfg.world.size;
  const seg = 128; // сетка 128x128: крупные треугольники отлично сочетаются с пиксель-стилем

  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
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
  return mesh;
}
