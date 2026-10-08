// Headless-проверка игры: мир, расстановка, коллизии и симуляция игрока — без браузера.
// Запуск: npm test   (node test/headless.js)
// Печатает ok/FAIL по каждому пункту; код выхода 1, если есть провалы.
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { buildLayout, rockColliders, binColliders, makeCityLift } from '../src/world/placement.js';
import { createPavement } from '../src/world/pavement.js';
import { Rocks } from '../src/world/rocks.js';
import { Bushes } from '../src/world/bushes.js';
import { Bins } from '../src/world/bins.js';
import { TrashBags, pushBagsByBins } from '../src/world/bags.js';
import { createHeightmap } from '../src/world/heightmap.js';
import { resolveCircleAabb, groundHeightAt } from '../src/core/collide.js';
import { Player } from '../src/player/player.js';
import { Viewmodel } from '../src/player/viewmodel.js';
import { Impacts } from '../src/world/impacts.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(` FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

const cfg = { ...CONFIG, seed: CONFIG.seed };
const layout = buildLayout(cfg);
const hm = layout.heightmap;

// ---------- A. Рельеф ----------
console.log('\nA. Рельеф');
const hm2 = createHeightmap(cfg.world);
const pts = [[0, 0], [10, 5], [-30, 20], [60, -40], [100, 100], [170, 0], [-200, 150], [0, 210]];
check('сид детерминирован', pts.every(([x, z]) => hm.heightAt(x, z) === hm2.heightAt(x, z)));

const hm3 = createHeightmap({ ...cfg.world, seed: cfg.seed + 1 });
check('другой сид — другой рельеф', pts.some(([x, z]) => Math.abs(hm.heightAt(x, z) - hm3.heightAt(x, z)) > 0.5));

let centreMax = 0;
for (let x = -30; x <= 30; x += 5) {
  for (let z = -30; z <= 30; z += 5) centreMax = Math.max(centreMax, Math.abs(hm.heightAt(x, z)));
}
check('центр ровный (|h| < 2.5 м)', centreMax < 2.5, `max=${centreMax.toFixed(2)}`);

const ringR = cfg.world.size / 2 - 20; // кольцо у самого края карты — там уже хребет
const ringHeights = [];
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  ringHeights.push(hm.heightAt(Math.cos(a) * ringR, Math.sin(a) * ringR));
}
const avgRing = ringHeights.reduce((s, v) => s + v, 0) / ringHeights.length;
check('горы по краю высокие (средн. > 25 м)', avgRing > 25, `avg=${avgRing.toFixed(1)}`);
check('хребет хотя бы где-то > 45 м', Math.max(...ringHeights) > 45, `max=${Math.max(...ringHeights).toFixed(1)}`);

// ---------- B. Расстановка ----------
console.log('\nB. Расстановка мира');
check('домов достаточно', layout.buildings.length >= 10, `=${layout.buildings.length}`);

let overlap = false;
for (let i = 0; i < layout.buildings.length; i++) {
  for (let j = i + 1; j < layout.buildings.length; j++) {
    const a = layout.buildings[i];
    const b = layout.buildings[j];
    if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2) overlap = true;
  }
}
check('дома не пересекаются', !overlap);
check('дома на ровных участках', layout.buildings.every((b) => hm.slopeAt(b.x, b.z) < 0.3));
check('деревьев >= 400', layout.trees.length >= 400, `=${layout.trees.length}`);

const inBuilding = (x, z, margin = 0) => layout.buildings.some((b) =>
  Math.abs(x - b.x) < b.w / 2 + margin && Math.abs(z - b.z) < b.d / 2 + margin);
check('деревья не в домах', layout.trees.every((t) => !inBuilding(t.x, t.z, 1.5)));
check('деревья в границах', layout.trees.every((t) => Math.abs(t.x) < cfg.world.size / 2 && Math.abs(t.z) < cfg.world.size / 2));
check('манекены на земле и не в домах', layout.dummies.length === cfg.layout.dummies &&
  layout.dummies.every((d) => !inBuilding(d.x, d.z, 1) && d.y === hm.heightAt(d.x, d.z)));

// ---------- C. Коллизии ----------
console.log('\nC. Коллизии');
const box = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, minY: 0, maxY: 3 };

let r = resolveCircleAabb(0, 0, 0.4, 0, 1.8, [box]);
check('центр в коробке — выталкивает наружу', r.hit && (Math.abs(r.x) >= 1.4 - 1e-6 || Math.abs(r.z) >= 1.4 - 1e-6));

r = resolveCircleAabb(1.3, 0, 0.4, 0, 1.8, [box]);
check('пересечение с гранью — выталкивает', r.hit && Math.abs(r.x - 1.4) < 1e-6, `x=${r.x}`);

r = resolveCircleAabb(3, 3, 0.4, 0, 1.8, [box]);
check('вне коробки — не трогает', !r.hit);

r = resolveCircleAabb(1.2, 0, 0.4, 3.5, 1.8, [box]);
check('стоя сверху — не выталкивает', !r.hit);

check('стоя на крыше — пол = крыша', groundHeightAt(0, 0, -5, [box], 3.01, 0.55) === 3);
check('высокий уступ не ступенька', groundHeightAt(0, 0, -5, [box], 2.0, 0.55) === -5);

// ---------- D. Симуляция игрока (чистый Node, без DOM) ----------
console.log('\nD. Симуляция игрока');
const camera = new THREE.PerspectiveCamera(74, 1, 0.1, 400);
camera.rotation.order = 'YXZ';
const openWorld = { heightmap: hm, colliders: [], size: cfg.world.size };
const player = new Player(camera, CONFIG, openWorld);

const keys = { forward: true, back: false, left: false, right: false, sprint: false, crouch: false, jump: false };
const stepN = (n, dt = 1 / 120) => { for (let i = 0; i < n; i++) player.update(dt, keys); };

player.respawn();
stepN(360); // 3 секунды шагом вперёд (-z)
check('идёт вперёд (z < -15)', player.pos.z < -15, `z=${player.pos.z.toFixed(2)}`);
check('скорость ≈ walkSpeed', Math.abs(player.hSpeed - CONFIG.player.walkSpeed) < 0.3, `v=${player.hSpeed.toFixed(2)}`);
check('ноги на рельефе', Math.abs(player.pos.y - hm.heightAt(player.pos.x, player.pos.z)) < 0.01);
check('координаты конечны', Number.isFinite(player.pos.x) && Number.isFinite(player.pos.y) && Number.isFinite(player.pos.z));

keys.sprint = true;
stepN(240); // 2 секунды бегом
check('бег ≈ sprintSpeed', Math.abs(player.hSpeed - CONFIG.player.sprintSpeed) < 0.3, `v=${player.hSpeed.toFixed(2)}`);
keys.sprint = false;

keys.crouch = true;
stepN(240); // 2 секунды в приседе
check('присед ≈ crouchSpeed', Math.abs(player.hSpeed - CONFIG.player.crouchSpeed) < 0.3, `v=${player.hSpeed.toFixed(2)}`);
check('присед опускает глаза', player.eye < CONFIG.player.crouchEyeHeight + 0.15, `eye=${player.eye.toFixed(2)}`);
keys.crouch = false;

// прыжок: держим 1 тик и смотрим максимальную высоту
player.setWorld(openWorld); // респавн на ровном центре
const groundY = player.pos.y;
keys.forward = false;
keys.jump = true;
stepN(1);
keys.jump = false;
let peak = player.pos.y;
for (let i = 0; i < 240; i++) { player.update(1 / 120, keys); peak = Math.max(peak, player.pos.y); }
check('прыжок поднимает больше 0.8 м', peak - groundY > 0.8, `peak=+${(peak - groundY).toFixed(2)}`);
check('после прыжка снова на земле', player.onGround && Math.abs(player.pos.y - groundY) < 0.05);

// стена: коробка прямо по курсу
const wall = { minX: -5, maxX: 5, minZ: -14, maxZ: -10, minY: -2, maxY: 6 };
const wallWorld = { heightmap: hm, colliders: [wall], size: cfg.world.size };
player.setWorld(wallWorld);
keys.forward = true;
stepN(360);
check('упирается в стену дома', Math.abs(player.pos.z - (-9.6)) < 0.06, `z=${player.pos.z.toFixed(3)}`);
check('не залезает на дом', player.pos.y < 3, `y=${player.pos.y.toFixed(2)}`);

// не выходит за границы мира даже за 30 секунд хода в одну сторону
player.setWorld(openWorld);
camera.rotation.y = -Math.PI / 2; // взгляд на +x, в сторону гор
stepN(3600);
check('не покидает границы мира', Math.hypot(player.pos.x, player.pos.z) <= cfg.world.size / 2 - 2.5,
  `r=${Math.hypot(player.pos.x, player.pos.z).toFixed(1)}`);
check('высота в разумных пределах', player.pos.y < 80 && Number.isFinite(player.pos.y), `y=${player.pos.y.toFixed(1)}`);

// ---------- E. Предметы в руках и стрельба ----------
console.log('\nE. Предметы в руках');
const vm = new Viewmodel(CONFIG);
const viewStub = { speed: 0, onGround: true };
check('палка и пистолет зарегистрированы', vm.has('stick') && vm.has('pistol'));
check('без выбранного предмета ЛКМ игнорируется', vm.startPrimary() === false);
check('первый выбор мгновенный', vm.select('stick') === true && vm.currentId === 'stick');
vm.update(1 / 120, viewStub);
check('повторный выбор того же — no-op', vm.select('stick') === false);

vm.select('pistol');
check('смена предмета началась', vm.pendingId === 'pistol');
check('во время смены ЛКМ игнорируется', vm.startPrimary() === false);
for (let i = 0; i < 60; i++) vm.update(1 / 120, viewStub);
check('смена завершилась за switchTime', vm.currentId === 'pistol' && vm.pendingId === null);

// полуавтоматический огонь: клик каждый тик в течение 2 секунд
const pistol = vm.get('pistol');
const shotTicks = [];
let tick = 0;
pistol.onFireAt = () => shotTicks.push(tick);
for (tick = 0; tick < 240; tick++) { vm.startPrimary(); vm.update(1 / 120, viewStub); }
const gaps = shotTicks.slice(1).map((t, i) => t - shotTicks[i]);
const minGap = gaps.length ? Math.min(...gaps) : Infinity;
check('выстрелов за 2 с ≈ 2 / cooldown', shotTicks.length >= 8 && shotTicks.length <= 9, `shots=${shotTicks.length}`);
check('интервал не меньше cooldown', minGap >= CONFIG.pistol.fireCooldown * 120 - 1.01, `minGap=${minGap} тиков`);

// искры от попаданий
const imp = new Impacts(CONFIG);
check('пул искр создан и спит', imp.group.children.length === CONFIG.impacts.pool && imp.activeCount === 0);
imp.spawn(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
check('попадание рождает искры', imp.activeCount === CONFIG.impacts.sparks, `active=${imp.activeCount}`);
for (let i = 0; i < 120; i++) imp.update(1 / 120);
check('искры догорают за life', imp.activeCount === 0);

// ---------- F. Городская зона, зелень и камни ----------
console.log('\nF. Городская зона, зелень и улица');
const cityZone = layout.city;
const cityMargin = cfg.city.margin;
const strictlyInCity = (x, z, m = 0) =>
  x > cityZone.minX - m && x < cityZone.maxX + m && z > cityZone.minZ - m && z < cityZone.maxZ + m;

check('дома целиком внутри городской зоны', layout.buildings.length > 0 && layout.buildings.every((b) =>
  b.x - b.w / 2 >= cityZone.minX - 1e-6 && b.x + b.w / 2 <= cityZone.maxX + 1e-6 &&
  b.z - b.d / 2 >= cityZone.minZ - 1e-6 && b.z + b.d / 2 <= cityZone.maxZ + 1e-6));
check('лес не заходит в город', layout.trees.every((t) => !strictlyInCity(t.x, t.z, cityMargin)));

check('кустов достаточно', layout.bushes.length >= 220, `=${layout.bushes.length}`);
check('кусты в зелёной зоне', layout.bushes.every((b) => !strictlyInCity(b.x, b.z, cityMargin)));
check('кусты на земле и не в домах', layout.bushes.every((b) =>
  b.y === hm.heightAt(b.x, b.z) && !inBuilding(b.x, b.z, 1)));

const bigRocks = layout.rocks.filter((r0) => r0.big);
const smallRocks = layout.rocks.filter((r0) => !r0.big);
check('валунов достаточно', bigRocks.length >= 100, `=${bigRocks.length}`);
check('мелких камней достаточно', smallRocks.length >= 220, `=${smallRocks.length}`);
check('камни не в городе', layout.rocks.every((r0) => !strictlyInCity(r0.x, r0.z, cityMargin)));
check('камни сидят в земле', layout.rocks.every((r0) => {
  const g = hm.heightAt(r0.x, r0.z);
  return r0.y <= g + 1e-6 && r0.y > g - 1.2;
}));
const rcols = rockColliders(layout.rocks);
check('у каждого валуна есть коллайдер', rcols.length === bigRocks.length);
if (rcols.length > 0) {
  const rc = rcols[0];
  const rr = resolveCircleAabb((rc.minX + rc.maxX) / 2, (rc.minZ + rc.maxZ) / 2, 0.4, rc.minY + 0.5, 1.8, [rc]);
  check('игрок выталкивается из валуна', rr.hit);
}

const pave = createPavement(layout.heightmap, layout.buildings, cfg);
check('асфальт + тротуар под каждый дом', pave.group.children.length === 1 + layout.buildings.length);
const asphaltMesh = pave.group.children[0];
asphaltMesh.geometry.computeBoundingBox();
const abox = asphaltMesh.geometry.boundingBox;
check('асфальт накрывает все дома', layout.buildings.every((b) =>
  b.x > abox.min.x && b.x < abox.max.x && b.z > abox.min.z && b.z < abox.max.z));

const rocksView = new Rocks(layout.rocks, cfg);
const bushesView = new Bushes(layout.bushes, cfg);
check('камни одним instanced-мешем', rocksView.mesh.count === layout.rocks.length);
check('кусты одним instanced-мешем', bushesView.mesh.count === layout.bushes.length);

// уличная обстановка: знаки, баки, мешки
const cityLift = makeCityLift(cfg, layout.buildings);
check('знаков достаточно', layout.signs.length >= 6, `=${layout.signs.length}`);
check('знаки стоят на покрытии в городе', layout.signs.every((s) =>
  strictlyInCity(s.x, s.z) && !inBuilding(s.x, s.z, 1) &&
  Math.abs(s.y - (hm.heightAt(s.x, s.z) + cityLift(s.x, s.z))) < 1e-6));

// знак стоит у края «дороги» — отступ от ближайшей оси улицы близок к signEdge
const plotW = (cityZone.maxX - cityZone.minX) / 4;
const plotD = (cityZone.maxZ - cityZone.minZ) / 3;
const nearestLine = (v, min, step, n) => {
  let best = Infinity;
  for (let i = 1; i <= n; i++) best = Math.min(best, Math.abs(v - (min + i * step)));
  return best;
};
check('знаки у края дороги, не по её центру', layout.signs.every((s) => {
  const d = Math.min(nearestLine(s.x, cityZone.minX, plotW, 3), nearestLine(s.z, cityZone.minZ, plotD, 2));
  return Math.abs(d - cfg.street.signEdge) < 0.6;
}));

check('баков достаточно', layout.bins.length >= 8, `=${layout.bins.length}`);
check('баки у домов, на покрытии', layout.bins.every((b) =>
  strictlyInCity(b.x, b.z) && !inBuilding(b.x, b.z, 0.5) &&
  Math.abs(b.y - (hm.heightAt(b.x, b.z) + cityLift(b.x, b.z))) < 1e-6));
const bcols = binColliders(layout.bins, cfg);
check('у каждого бака есть коллайдер', bcols.length === layout.bins.length);
if (bcols.length > 0) {
  const bc = bcols[0];
  const rr = resolveCircleAabb((bc.minX + bc.maxX) / 2, (bc.minZ + bc.maxZ) / 2, 0.4, bc.minY + 0.5, 1.8, [bc]);
  check('игрок выталкивается из бака', rr.hit);
}

check('мешков достаточно', layout.bags.length >= 25, `=${layout.bags.length}`);
check('мешки в городе, на покрытии', layout.bags.every((bg) =>
  strictlyInCity(bg.x, bg.z) && !inBuilding(bg.x, bg.z, 0.45) &&
  Math.abs(bg.y - (hm.heightAt(bg.x, bg.z) + cityLift(bg.x, bg.z))) < 1e-6));

// кусты дрожат от удара и постепенно затухают
bushesView.hit(0);
check('куст начинает дрожать', bushesView.update(1 / 60) === 1);
for (let i = 0; i < 300; i++) bushesView.update(1 / 60);
check('дрожь куста затухает', bushesView.swayCount === 0);

// физика мешков: пинок, полёт, засыпание, сброс по R
const bagWorld = { heightmap: hm, colliders: [], size: cfg.world.size, cityLift };
const bagsView = new TrashBags(layout.bags, CONFIG, bagWorld);
check('мешки одним instanced-мешем', bagsView.mesh.count === layout.bags.length);
check('мешки спят на старте', bagsView.awakeCount === 0);

const bagStart = bagsView.units[0].pos.clone();
bagsView.hit(0, { x: 1, z: 0 }, CONFIG.street.bagImpulse);
check('пинок будит мешок', bagsView.awakeCount === 1);
let bagSettled = false;
for (let i = 0; i < 900 && !bagSettled; i++) { bagsView.update(1 / 60); bagSettled = bagsView.awakeCount === 0; }
const bagEnd = bagsView.units[0].pos;
const bagDist = bagEnd.distanceTo(bagStart);
check('мешок отлетает от пинка', bagDist > 1.5, `d=${bagDist.toFixed(2)}`);
check('мешок засыпает на земле', bagSettled &&
  Math.abs(bagEnd.y - bagsView.groundBelow(bagEnd.x, bagEnd.z, bagEnd.y)) < 0.05);

bagsView.resetAll();
check('R возвращает мешки на места', bagsView.units[0].pos.distanceTo(bagStart) < 0.05);

// физика баков: тяжёлые — двигаются, но заметно меньше мешков; коллайдер едет за баком
const propWorld = { heightmap: hm, colliders: [], size: cfg.world.size, cityLift };
const binsView = new Bins(layout.bins, cfg, propWorld, bcols);
check('баки одним instanced-мешем', binsView.mesh.count === layout.bins.length);
check('баки спят на старте', binsView.awakeCount === 0);

const binStart = binsView.units[0].pos.clone();
binsView.hit(0, { x: 1, z: 0 }, CONFIG.street.binImpulse);
check('пинок будит бак', binsView.awakeCount === 1);
let binSettled = false;
for (let i = 0; i < 900 && !binSettled; i++) { binsView.update(1 / 60); binSettled = binsView.awakeCount === 0; }
const binDist = binsView.units[0].pos.distanceTo(binStart);
check('бак сдвигается от пинка', binSettled && binDist > 0.15, `d=${binDist.toFixed(2)}`);
check('бак тяжелее мешка', binDist < bagDist * 0.5, `bin=${binDist.toFixed(2)} bag=${bagDist.toFixed(2)}`);
const bc0 = bcols[0];
check('коллайдер бака едет за баком',
  Math.abs((bc0.minX + bc0.maxX) / 2 - binsView.units[0].pos.x) < 0.01 &&
  Math.abs((bc0.minZ + bc0.maxZ) / 2 - binsView.units[0].pos.z) < 0.01);

// бак, проехав по лежащему мешку, будит его лёгким толчком
const soloBag = new TrashBags([{
  x: layout.bins[0].x + 0.7, z: layout.bins[0].z, y: layout.bins[0].y,
  s: 0.8, ry: 0, rx: 0.1, rz: 0, tint: 1,
}], CONFIG, propWorld);
const soloStart = soloBag.units[0].pos.clone();
binsView.resetAll();
binsView.hit(0, { x: 1, z: 0 }, CONFIG.street.binImpulse);
let soloMoved = false;
for (let i = 0; i < 900; i++) {
  binsView.update(1 / 60);
  pushBagsByBins(soloBag, binsView, CONFIG.street.bagPush);
  soloBag.update(1 / 60);
  if (soloBag.units[0].pos.distanceTo(soloStart) > 0.2) soloMoved = true;
}
check('бак столкнул мешок', soloMoved && soloBag.awakeCount === 0);

binsView.resetAll();
check('R возвращает баки на места', binsView.units[0].pos.distanceTo(binStart) < 0.05);

// ---------- Итог ----------
console.log(`\nИтог: ${pass} ok, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
