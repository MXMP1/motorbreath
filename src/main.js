import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { CONFIG } from './config.js';
import { buildLayout, rockColliders, binColliders, makeCityLift } from './world/placement.js';
import { createTerrain } from './world/terrain.js';
import { createPavement } from './world/pavement.js';
import { Trees } from './world/trees.js';
import { createBuildings } from './world/buildings.js';
import { Rocks } from './world/rocks.js';
import { Bushes } from './world/bushes.js';
import { Signs } from './world/signs.js';
import { Bins } from './world/bins.js';
import { TrashBags, pushBagsByBins } from './world/bags.js';
import { Dummies } from './world/dummies.js';
import { Player } from './player/player.js';
import { Viewmodel } from './player/viewmodel.js';
import { Impacts } from './world/impacts.js';
import { Input } from './core/input.js';
import { Hud } from './core/hud.js';

// ---------- рендерер: честный low-res ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); // пиксели — это пиксели

const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.palette.sky);
scene.fog = new THREE.Fog(CONFIG.palette.fog, CONFIG.render.fogNear, CONFIG.render.fogFar);

const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, CONFIG.camera.near, CONFIG.camera.far);
camera.rotation.order = 'YXZ'; // обязательный порядок осей для FPS-обзора

scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x4a4a3f, 1.0));
const sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
sun.position.set(60, 100, 35);
scene.add(sun);

// ---------- управление ----------
const controls = new PointerLockControls(camera, canvas);
controls.pointerSpeed = CONFIG.player.sens / 0.002;

const hint = document.getElementById('hint');
document.addEventListener('click', () => { if (!controls.isLocked) controls.lock(); });
controls.addEventListener('lock', () => hint.classList.add('hidden'));
controls.addEventListener('unlock', () => hint.classList.remove('hidden'));

const input = new Input(controls);
const hud = new Hud();

// ---------- низкое разрешение ----------
let resIndex = CONFIG.render.defaultRes;
let aspect = 1;

function applyResolution() {
  aspect = window.innerWidth / window.innerHeight;
  const h = CONFIG.render.resHeights[resIndex];
  const w = Math.max(2, Math.round(h * aspect));
  renderer.setSize(w, h, false); // рисуем в маленький буфер, CSS растягивает
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', applyResolution);
applyResolution();

// ---------- мир ----------
let world = null;
let seed = CONFIG.seed;

function disposeWorld() {
  if (!world) return;
  const parts = [
    world.terrain, world.pavement.group, world.buildings.group,
    world.dummies.group, world.trees.trunks, world.trees.crowns,
    world.rocks.mesh, world.bushes.mesh, world.signs.group, world.bins.mesh, world.bags.mesh,
  ];
  for (const part of parts) {
    scene.remove(part);
    part.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }
  world = null;
}

function rebuildWorld(newSeed) {
  disposeWorld();
  seed = newSeed;
  const cfg = { ...CONFIG, seed };

  const layout = buildLayout(cfg);
  const terrain = createTerrain(layout.heightmap, cfg);
  scene.add(terrain);

  const pavement = createPavement(layout.heightmap, layout.buildings, cfg);
  scene.add(pavement.group);

  const buildings = createBuildings(layout.buildings, cfg);
  scene.add(buildings.group);

  const trees = new Trees(layout.trees, cfg);
  trees.addTo(scene);

  const rocks = new Rocks(layout.rocks, cfg);
  scene.add(rocks.mesh);

  const bushes = new Bushes(layout.bushes, cfg);
  scene.add(bushes.mesh);

  const binCols = binColliders(layout.bins, cfg); // коллайдеры баков: физика двигает их вместе с баками
  world = {
    heightmap: layout.heightmap,
    // дома + валуны + баки: сквозь них не пройти
    colliders: buildings.colliders.concat(rockColliders(layout.rocks), binCols),
    size: CONFIG.world.size,
    cityLift: makeCityLift(cfg, layout.buildings), // высота покрытия в городе (нужна физике мешков)
    terrain,
    pavement,
    buildings,
    trees,
    rocks,
    bushes,
    dummies: null,
  };
  world.signs = new Signs(layout.signs, cfg);
  scene.add(world.signs.group);
  world.bins = new Bins(layout.bins, cfg, world, binCols);
  scene.add(world.bins.mesh);
  world.bags = new TrashBags(layout.bags, CONFIG, world);
  scene.add(world.bags.mesh);
  world.dummies = new Dummies(layout.dummies, CONFIG, world);
  scene.add(world.dummies.group);
  return world;
}

rebuildWorld(seed);

// ---------- игрок, предметы в руках, попадания ----------
const player = new Player(camera, CONFIG, world);
const viewmodel = new Viewmodel(CONFIG);
const impacts = new Impacts(CONFIG);
scene.add(impacts.group);

// Кик камеры при выстреле/ударе: добавляем смещение питча, потом компенсируем его же
// при затухании, чтобы суммарно камера не «уехала».
let pitchKick = 0;
let appliedKick = 0;

const tmpDir = new THREE.Vector3();
const tmpFlat = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
raycaster.far = CONFIG.pistol.range;

// Удар палкой: сфера по лучу взгляда — деревья качаются, манекены отлетают.
function stickHit() {
  camera.getWorldDirection(tmpDir);
  const cx = camera.position.x + tmpDir.x * CONFIG.stick.reach;
  const cy = camera.position.y + tmpDir.y * CONFIG.stick.reach;
  const cz = camera.position.z + tmpDir.z * CONFIG.stick.reach;

  // горизонтальное направление удара — общее для манекенов и мешков
  tmpFlat.set(tmpDir.x, 0, tmpDir.z);
  if (tmpFlat.lengthSq() < 1e-6) tmpFlat.set(0, 0, -1);
  tmpFlat.normalize();

  const treeIndex = world.trees.findNearest(cx, cy, cz, CONFIG.stick.hitRadius);
  if (treeIndex >= 0) world.trees.hit(treeIndex);
  const bushIndex = world.bushes.findNearest(cx, cy, cz, CONFIG.stick.hitRadius);
  if (bushIndex >= 0) world.bushes.hit(bushIndex);

  for (let i = 0; i < world.dummies.units.length; i++) {
    const u = world.dummies.units[i];
    const dx = u.pos.x - cx;
    const dy = u.pos.y + 0.9 - cy;
    const dz = u.pos.z - cz;
    if (dx * dx + dy * dy + dz * dz < 1.35 * 1.35) {
      world.dummies.hit(i, tmpFlat, CONFIG.stick);
    }
  }

  // мешки лёгкие — разлетаются от замаха
  for (let i = 0; i < world.bags.units.length; i++) {
    const u = world.bags.units[i];
    const dx = u.pos.x - cx;
    const dy = u.pos.y + 0.35 - cy;
    const dz = u.pos.z - cz;
    if (dx * dx + dy * dy + dz * dz < 1.25 * 1.25) {
      world.bags.hit(i, tmpFlat, CONFIG.street.bagImpulse);
    }
  }

  // баки тяжёлые — от замаха лишь сдвигаются
  for (let i = 0; i < world.bins.units.length; i++) {
    const u = world.bins.units[i];
    const dx = u.pos.x - cx;
    const dy = u.pos.y + 0.5 - cy;
    const dz = u.pos.z - cz;
    if (dx * dx + dy * dy + dz * dz < 1.2 * 1.2) {
      world.bins.hit(i, tmpFlat, CONFIG.street.binImpulse);
    }
  }

  pitchKick = CONFIG.stick.pitchKick;
}

// Выстрел из пистолета: хитсякан по мешам мира, искры в точке попадания,
// импульс манекену, покачивание дереву.
function shoot() {
  camera.getWorldDirection(tmpDir);
  raycaster.set(camera.position, tmpDir);
  const hits = raycaster.intersectObjects(
    [world.terrain, world.pavement.group, world.buildings.group,
     world.trees.trunks, world.trees.crowns, world.rocks.mesh, world.bushes.mesh,
     world.bins.mesh, world.signs.group, world.bags.mesh, world.dummies.group],
    true,
  );
  if (hits.length === 0) return;
  const hit = hits[0];

  // попали в манекен? поднимаемся по родителям до группы с индексом
  let dummyIdx = -1;
  let node = hit.object;
  while (node) {
    if (typeof node.userData.dummyIndex === 'number') { dummyIdx = node.userData.dummyIndex; break; }
    if (node === world.dummies.group) break;
    node = node.parent;
  }

  // горизонтальное направление выстрела — общее для манекенов и мешков
  tmpFlat.set(tmpDir.x, 0, tmpDir.z);
  if (tmpFlat.lengthSq() < 1e-6) tmpFlat.set(0, 0, -1);
  tmpFlat.normalize();

  if (dummyIdx >= 0) {
    world.dummies.hit(dummyIdx, tmpFlat, CONFIG.pistol.impact);
  } else if ((hit.object === world.trees.trunks || hit.object === world.trees.crowns) && hit.instanceId !== undefined) {
    world.trees.hit(hit.instanceId);
  } else if (hit.object === world.bushes.mesh && hit.instanceId !== undefined) {
    world.bushes.hit(hit.instanceId);
  } else if (hit.object === world.bags.mesh && hit.instanceId !== undefined) {
    world.bags.hit(hit.instanceId, tmpFlat, CONFIG.street.bagImpulse);
  } else if (hit.object === world.bins.mesh && hit.instanceId !== undefined) {
    world.bins.hit(hit.instanceId, tmpFlat, CONFIG.street.binImpulse);
  }

  impacts.spawn(hit.point, tmpDir);
  pitchKick = CONFIG.pistol.pitchKick;
}

// Колесо мыши: следующий/предыдущий непустой слот.
function cycleItem(step) {
  const slots = CONFIG.hands.slots;
  const cur = slots.indexOf(viewmodel.currentId);
  for (let i = 1; i <= slots.length; i++) {
    const idx = ((cur + step * i) % slots.length + slots.length) % slots.length;
    const id = slots[idx];
    if (id && viewmodel.select(id)) return;
  }
}

viewmodel.get('stick').onHitAt = stickHit;
viewmodel.get('pistol').onFireAt = shoot;
viewmodel.select(CONFIG.hands.slots[0]); // в руках палка

// ---------- игровой цикл: фиксированный шаг физики 120 Гц ----------
const STEP = 1 / 120;
let acc = 0;
const clock = new THREE.Clock();
const sizeVec = new THREE.Vector2();

function step(dt) {
  player.update(dt, input);
  world.dummies.update(dt);
  world.bins.update(dt);
  pushBagsByBins(world.bags, world.bins, CONFIG.street.bagPush); // проехал ли бак по мешку
  world.bags.update(dt);

  for (const code of input.consumePressed()) {
    if (code === 'KeyV') {
      resIndex = (resIndex + 1) % CONFIG.render.resHeights.length;
      applyResolution();
    } else if (code === 'F3') {
      hud.toggle();
    } else if (code === 'KeyR') {
      world.dummies.resetAll();
      world.bins.resetAll();
      world.bags.resetAll();
    } else if (code === 'KeyG') {
      rebuildWorld(seed + 1);
      player.setWorld(world);
    } else if (code.startsWith('Digit')) {
      // слоты 1..9,0 — как в классических шутерах
      const n = code === 'Digit0' ? 9 : Number(code.slice(5)) - 1;
      const id = CONFIG.hands.slots[n];
      if (id) viewmodel.select(id);
    } else if (code === 'WheelDown') {
      cycleItem(1);
    } else if (code === 'WheelUp') {
      cycleItem(-1);
    }
  }

  if (input.consumeAttack()) viewmodel.startPrimary();
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, clock.getDelta());

  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 8) { step(STEP); acc -= STEP; guard++; }
  if (guard === 8) acc = 0; // не копим долг физики, если вкладка лагала

  // визуальный слой — по реальному времени кадра
  viewmodel.update(dt, { speed: player.hSpeed, onGround: player.onGround });
  impacts.update(dt);
  const swaying = world.trees.update(dt) + world.bushes.update(dt);

  pitchKick *= Math.exp(-10 * dt);
  if (pitchKick < 1e-5) pitchKick = 0;
  camera.rotation.x += pitchKick - appliedKick;
  appliedKick = pitchKick;

  renderer.getSize(sizeVec);
  hud.update(dt, {
    pos: player.pos,
    speed: player.hSpeed,
    state: player.state,
    res: `${sizeVec.x}x${sizeVec.y}`,
    seed,
    item: viewmodel.current ? viewmodel.current.label : '—',
    slot: viewmodel.currentId ? CONFIG.hands.slots.indexOf(viewmodel.currentId) + 1 : 0,
    awake: world.dummies.awakeCount,
    bins: world.bins.awakeCount,
    bags: world.bags.awakeCount,
    swaying,
    sparks: impacts.activeCount,
  });

  viewmodel.render(renderer, scene, camera, aspect);
}

frame();
