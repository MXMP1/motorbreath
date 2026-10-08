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
import { Npcs, buildCovers } from '../src/world/npc.js';
import { Camp } from '../src/world/camp.js';
import { Motorcycle } from '../src/world/bike.js';
import { createHeightmap } from '../src/world/heightmap.js';
import { resolveCircleAabb, groundHeightAt } from '../src/core/collide.js';
import { Player, hurtKick } from '../src/player/player.js';
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

// край карты — длинный коридор: хребет проверяем у всех четырёх стен
const ringX = cfg.world.sizeX / 2 - 20; // вдоль длинной стороны: до гор ~100 м
const ringZ = cfg.world.sizeZ / 2 - 20; // по торцам: ~110 м и больше
const ringHeights = [];
for (let i = 0; i < 8; i++) {
  const t = -130 + (260 * i) / 7;
  ringHeights.push(hm.heightAt(ringX, t), hm.heightAt(-ringX, t));
}
for (let i = 0; i < 6; i++) {
  const t = -100 + (200 * i) / 5;
  ringHeights.push(hm.heightAt(t, ringZ), hm.heightAt(t, -ringZ));
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
check('деревья в границах', layout.trees.every((t) => Math.abs(t.x) < cfg.world.sizeX / 2 && Math.abs(t.z) < cfg.world.sizeZ / 2));
check('нпс достаточно и все в городе', layout.npcs.length === cfg.layout.npcs && layout.npcs.every((n) =>
  n.x > layout.city.minX && n.x < layout.city.maxX && n.z > layout.city.minZ && n.z < layout.city.maxZ));
const npcLift = makeCityLift(cfg, layout.buildings);
check('нпс на покрытии, не в домах', layout.npcs.every((n) =>
  !inBuilding(n.x, n.z, 1) && Math.abs(n.y - (hm.heightAt(n.x, n.z) + npcLift(n.x, n.z))) < 1e-6));
check('нпс делятся на палочников и стрелков', layout.npcs.filter((n) => n.weapon === 'stick').length >= 6 &&
  layout.npcs.filter((n) => n.weapon === 'pistol').length >= 6);
const campClear = (x, z) => Math.hypot(x - cfg.camp.x, z - cfg.camp.z) >= cfg.camp.clearing - 1e-6;
check('поляна лагеря чиста: без леса, кустов и камней',
  layout.trees.every((t) => campClear(t.x, t.z)) &&
  layout.bushes.every((b) => campClear(b.x, b.z)) &&
  layout.rocks.every((r0) => campClear(r0.x, r0.z)));

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
const openWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ };
const player = new Player(camera, CONFIG, openWorld);

const keys = { forward: true, back: false, left: false, right: false, sprint: false, crouch: false, jump: false };
const stepN = (n, dt = 1 / 120) => { for (let i = 0; i < n; i++) player.update(dt, keys); };

player.respawn();
const campSpawnX = CONFIG.camp.x + CONFIG.camp.spawnDx;
const campSpawnZ = CONFIG.camp.z + CONFIG.camp.spawnDz;
check('спавн игрока в лагере', Math.abs(player.pos.x - campSpawnX) < 0.01 && Math.abs(player.pos.z - campSpawnZ) < 0.01,
  `x=${player.pos.x.toFixed(1)} z=${player.pos.z.toFixed(1)}`);
const startZ = player.pos.z;
camera.rotation.y = Math.PI; // шагаем из лагеря на север: впереди — открытый коридор
stepN(360); // 3 секунды шагом вперёд (+z)
check('идёт вперёд (> 15 м за 3 с)', player.pos.z > startZ + 15, `dz=${(player.pos.z - startZ).toFixed(1)}`);
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
player.spawn = { x: 0, z: 0 }; // прыжок и стена гоняются на ровном центре карты
player.setWorld(openWorld);
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
const wallWorld = { heightmap: hm, colliders: [wall], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ };
player.setWorld(wallWorld);
camera.rotation.y = 0; // взгляд снова на -z: стена прямо по курсу
keys.forward = true;
stepN(360);
check('упирается в стену дома', Math.abs(player.pos.z - (-9.6)) < 0.06, `z=${player.pos.z.toFixed(3)}`);
check('не залезает на дом', player.pos.y < 3, `y=${player.pos.y.toFixed(2)}`);

// не выходит за границы мира даже за 30 секунд хода в одну сторону
player.setWorld(openWorld);
camera.rotation.y = -Math.PI / 2; // взгляд на +x, в сторону гор
stepN(3600);
check('не покидает границы мира',
  Math.abs(player.pos.x) <= cfg.world.sizeX / 2 - 2.5 && Math.abs(player.pos.z) <= cfg.world.sizeZ / 2 - 2.5,
  `x=${player.pos.x.toFixed(1)} z=${player.pos.z.toFixed(1)}`);
check('высота в разумных пределах', player.pos.y < 80 && Number.isFinite(player.pos.y), `y=${player.pos.y.toFixed(1)}`);

// урон от NPC: hp падает и регенерирует; смерть возвращает на спавн
keys.forward = false;
player.damage(30);
check('урон снимает hp', Math.abs(player.hp - 70) < 1e-6, `hp=${player.hp}`);
stepN(840); // 7 с: 5 с паузы регена + 2 с восстановления
check('hp восстанавливается после паузы', player.hp > 70, `hp=${player.hp.toFixed(1)}`);
player.spawn = { x: campSpawnX, z: campSpawnZ }; // возвращаем лагерный спавн
player.damage(999);
check('смерть — респавн в лагере с полным hp', player.hp === CONFIG.player.maxHp &&
  Math.abs(player.pos.x - campSpawnX) < 0.01 && Math.abs(player.pos.z - campSpawnZ) < 0.01,
  `x=${player.pos.x.toFixed(1)} z=${player.pos.z.toFixed(1)}`);

// качение камеры: сторона удара задаёт знаки рывков (взгляд — на -z)
const kRight = hurtKick(player.pos.x + 1, player.pos.z, player.pos.x, player.pos.z, 0, -1, CONFIG.player.hurt);
const kBack = hurtKick(player.pos.x, player.pos.z + 1, player.pos.x, player.pos.z, 0, -1, CONFIG.player.hurt);
const kFront = hurtKick(player.pos.x, player.pos.z - 1, player.pos.x, player.pos.z, 0, -1, CONFIG.player.hurt);
check('удар справа качнёт камеру влево с креном', kRight.yaw > 0 && kRight.roll > 0 && kRight.pitch === 0);
check('удар сзади качнёт камеру вниз', kBack.pitch < 0);
check('удар спереди качнёт камеру вверх', kFront.pitch > 0);

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

// ПКМ-прицел: пистолет встаёт по центру экрана и возвращается обратно
const viewAim = { speed: 0, onGround: true, aim: true };
for (let i = 0; i < 120; i++) vm.update(1 / 120, viewAim);
check('ПКМ поднимает пистолет в прицел (по центру)', Math.abs(pistol.group.position.x) < 0.02 &&
  Math.abs(pistol.group.position.y + 0.16) < 0.02,
  `x=${pistol.group.position.x.toFixed(2)} y=${pistol.group.position.y.toFixed(2)}`);
for (let i = 0; i < 240; i++) vm.update(1 / 120, viewStub);
check('без ПКМ пистолет возвращается в руку', Math.abs(pistol.group.position.x - 0.28) < 0.02,
  `x=${pistol.group.position.x.toFixed(2)}`);

// ПКМ на палке: зум-бинокль — обзор поджимается сильнее пистолетного, палка уходит из кадра
check('зум палки сильнее пистолетного прицела (бинокль)', CONFIG.stick.aimFov < CONFIG.pistol.aimFov,
  `stick=${CONFIG.stick.aimFov} pistol=${CONFIG.pistol.aimFov}`);
vm.select('stick');
for (let i = 0; i < 60; i++) vm.update(1 / 120, viewStub); // смена предмета доигрывается
const stickItem = vm.get('stick');
check('палка выбрана после смены', vm.currentId === 'stick' && vm.pendingId === null);
for (let i = 0; i < 120; i++) vm.update(1 / 120, viewAim);
check('ПКМ опускает палку вниз из кадра (бинокль)', stickItem.group.position.y < -0.8,
  `y=${stickItem.group.position.y.toFixed(2)}`);
for (let i = 0; i < 240; i++) vm.update(1 / 120, viewStub);
check('без ПКМ палка возвращается в руку', Math.abs(stickItem.group.position.y + 0.52) < 0.02,
  `y=${stickItem.group.position.y.toFixed(2)}`);

// искры от попаданий
const imp = new Impacts(CONFIG);
check('пул искр, вспышек и следов создан и спит',
  imp.group.children.length === CONFIG.impacts.pool + CONFIG.impacts.bloodPool +
    CONFIG.impacts.flashPool + CONFIG.impacts.tracerPool &&
  imp.activeCount === 0);
imp.spawn(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
check('попадание рождает искры', imp.activeCount === CONFIG.impacts.sparks, `active=${imp.activeCount}`);
for (let i = 0; i < 120; i++) imp.update(1 / 120);
check('искры догорают за life', imp.activeCount === 0);

// кровь при попадании по NPC: красные брызги живут коротко
check('кровавые брызги спят на старте', imp.bloodCount === 0);
imp.spawnBlood(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
check('попадание по NPC рождает кровь', imp.bloodCount === CONFIG.impacts.bloodSparks, `blood=${imp.bloodCount}`);
for (let i = 0; i < 120; i++) imp.update(1 / 120);
check('брызги догорают за bloodLife', imp.bloodCount === 0);

// вспышки выстрелов NPC: ярко вспыхивают и гаснут быстро
check('вспышки спят на старте', imp.flashCount === 0);
imp.flash(new THREE.Vector3(0, 1.5, 0));
check('выстрел NPC рождает яркую вспышку', imp.flashCount === 1);
for (let i = 0; i < Math.ceil(CONFIG.impacts.flashLife * 120) + 2; i++) imp.update(1 / 120);
check('вспышка гаснет за flashLife', imp.flashCount === 0);

// следы пуль: мелькают и гаснут быстро
check('следы пуль спят на старте', imp.tracerCount === 0);
imp.tracer(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 1.5, -10));
check('выстрел оставляет след от ствола', imp.tracerCount === 1);
for (let i = 0; i < Math.ceil(CONFIG.impacts.tracerLife * 120) + 2; i++) imp.update(1 / 120);
check('след гаснет за tracerLife', imp.tracerCount === 0);

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
const bagWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift };
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
const propWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift };
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

// ---------- G. NPC: зоны контакта ----------
console.log('\nG. NPC');
const covers = buildCovers(cfg, layout);
check('укрытия собраны в грид (дома, валуны, стволы)', covers.grid.size > 0 && covers.city !== null);

const npcWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null };
const emptyCovers = { grid: new Map(), cell: 8, city: null };
const mkHooks = () => {
  const ev = { dmg: [], shots: 0, tracers: 0 };
  return {
    ev,
    hooks: {
      playerDamage: (d) => ev.dmg.push(d),
      muzzle: () => { ev.shots++; },
      tracer: () => { ev.tracers++; },
    },
  };
};

// игрок далеко: NPC не замечают его
const far = mkHooks();
const crowd = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
  { x: 0, z: 10, y: 0, rot: Math.PI, weapon: 'pistol', home: { x: 0, z: 10 } }, // лицом к игроку: конус
], CONFIG, npcWorld, emptyCovers);
check('NPC живут одним набором instanced-мешей (корпус, контуры, оружие, лица)',
  crowd.parts.length === 7 && crowd.body.count === 2 && crowd.bodyShell.count === 2 && crowd.faces.count === 2);
const farPlayer = new THREE.Vector3(0, 0, 60);
for (let i = 0; i < 600; i++) crowd.update(1 / 60, farPlayer, far.hooks);
check('зона вне видимости: игрока игнорируют', crowd.alertCount === 0 && far.ev.dmg.length === 0 && far.ev.shots === 0);

// контакт: палочник дожимает и бьёт, стрелок пристреливается
const fight = mkHooks();
const nearPlayer = new THREE.Vector3(0, 0, 5);
let prevShots = 0;
let maxPerSec = 0;
for (let i = 0; i < 1200; i++) {
  crowd.update(1 / 60, nearPlayer, fight.hooks);
  if (i % 60 === 59) {
    maxPerSec = Math.max(maxPerSec, fight.ev.shots - prevShots); // пик выстрелов за секунду
    prevShots = fight.ev.shots;
  }
}
check('контакт: NPC перешли в агрессию', crowd.alertCount === 2);
check('палочник бьёт палкой', fight.ev.dmg.includes(CONFIG.npc.attackDamage), `hits=${fight.ev.dmg.length}`);
check('стрелок стреляет по игроку', fight.ev.shots > 0 && fight.ev.dmg.includes(CONFIG.npc.shotDamage));
check('стреляет очередями 2+ выстрела подряд', maxPerSec >= 2, `max=${maxPerSec}/с`);
check('каждый выстрел оставляет след пули', fight.ev.tracers === fight.ev.shots, `t=${fight.ev.tracers}/${fight.ev.shots}`);

// игрок ушёл из вида: ищут его у последнего места контакта
nearPlayer.set(0, 0, 80);
for (let i = 0; i < 60; i++) crowd.update(1 / 60, nearPlayer, fight.hooks); // дать заметить пропажу
const hitsBefore = fight.ev.dmg.length;
for (let i = 0; i < 1800; i++) crowd.update(1 / 60, nearPlayer, fight.hooks);
const stickUnit = crowd.units[0];
const distToSeen = Math.hypot(stickUnit.pos.x, stickUnit.pos.z - 5);
check('после потери из вида ищут игрока в месте находки', crowd.alertCount === 2 && distToSeen < 14,
  `d=${distToSeen.toFixed(1)}`);
check('вне видимости новых атак нет', fight.ev.dmg.length === hitsBefore);

// стена между стрелком и игроком: ни обнаружения, ни выстрелов
const wallCovers = buildCovers(cfg, { buildings: [{ x: 10, z: 0, w: 8, d: 12 }], rocks: [], trees: [], city: null });
const sneak = mkHooks();
const gunner = new Npcs([
  { x: 0, z: 0, y: 0, rot: Math.PI / 2, weapon: 'pistol', home: { x: 0, z: 0 } }, // смотрит на стену
], CONFIG, npcWorld, wallCovers);
const hiddenPlayer = new THREE.Vector3(20, 0, 0);
for (let i = 0; i < 1200; i++) gunner.update(1 / 60, hiddenPlayer, sneak.hooks);
check('стена скрывает игрока от NPC', gunner.alertCount === 0 && sneak.ev.shots === 0 && sneak.ev.dmg.length === 0);

// игрок спрятался за домом во время боя: стрелок обходит угол и ведёт огонь
const peekCovers = buildCovers(cfg, { buildings: [{ x: 5, z: 0, w: 3, d: 4 }], rocks: [], trees: [], city: null });
const peeka = mkHooks();
const hider = new Npcs([
  { x: 0, z: 3.5, y: 0, rot: Math.PI / 2, weapon: 'pistol', home: { x: 0, z: 3.5 } }, // смотрит в сторону игрока
], CONFIG, npcWorld, peekCovers);
const peekPlayer = new THREE.Vector3(9, 0, 3.5);
for (let i = 0; i < 60; i++) hider.update(1 / 60, peekPlayer, peeka.hooks); // заметил игрока
peekPlayer.set(9, 0, 0); // игрок спрятался за домом
let peekMinCover = Infinity;
for (let i = 0; i < 3600; i++) {
  hider.update(1 / 60, peekPlayer, peeka.hooks);
  const u = hider.units[0];
  if (u.cover) peekMinCover = Math.min(peekMinCover, Math.hypot(u.cover.x - u.pos.x, u.cover.z - u.pos.z));
}
check('выглядывает из-за укрытия и ведёт огонь', peeka.ev.shots >= 8 && peeka.ev.dmg.includes(CONFIG.npc.shotDamage),
  `shots=${peeka.ev.shots} dmg=${peeka.ev.dmg.length}`);
check('отстрелялся — прячется назад за укрытие', peekMinCover < 1.2, `minD=${peekMinCover.toFixed(2)}`);

// на дистанции стрелки мажут: игрок держит 20 м, часть пуль летит мимо
const afar = mkHooks();
const sniper = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'pistol', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const farTarget = new THREE.Vector3(0, 0, 20);
for (let i = 0; i < 3600; i++) {
  farTarget.set(sniper.units[0].pos.x, 0, sniper.units[0].pos.z + 20); // игрок держит дистанцию
  sniper.update(1 / 60, farTarget, afar.hooks);
}
const farHits = afar.ev.dmg.filter((d) => d === CONFIG.npc.shotDamage).length;
check('на дистанции бывают промахи', afar.ev.shots > farHits && farHits > 0,
  `shots=${afar.ev.shots} hits=${farHits}`);
check('промахи тоже оставляют следы', afar.ev.tracers === afar.ev.shots, `t=${afar.ev.tracers}/${afar.ev.shots}`);

// палочник не застревает на баках: «щупальце» видит бак и обходит его
const binWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null,
  bins: { units: [{ pos: new THREE.Vector3(0, 0, 5) }] } };
const detour = mkHooks();
const walker = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, binWorld, emptyCovers);
const walkTarget = new THREE.Vector3(0, 0, 10);
for (let i = 0; i < 900; i++) walker.update(1 / 60, walkTarget, detour.hooks);
const wu = walker.units[0];
const wd = Math.hypot(wu.pos.x, wu.pos.z - 10);
check('палочник обходит мусорный бак', wu.pos.z > 5 && wd < 3.5,
  `z=${wu.pos.z.toFixed(1)} d=${wd.toFixed(1)}`);

// свист пули рядом: услышавший и его соседи идут искать место выстрела
const alarm = mkHooks();
const squad = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },    // пуля прошла рядом
  { x: 4, z: 0, y: 0, rot: 0, weapon: 'pistol', home: { x: 4, z: 0 } },   // сосед по группе
  { x: 40, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 40, z: 0 } },  // далеко: не слышит
  { x: 0, z: 25, y: 0, rot: 0, weapon: 'pistol', home: { x: 0, z: 25 } }, // не на пути пули
], CONFIG, npcWorld, emptyCovers);
const shotFrom = { x: -10, y: hm.heightAt(0, 0) + 1, z: 0 };
squad.alertShot(shotFrom, { x: 1, y: 0, z: 0 }, 30);
check('пуля рядом: услышавший и сосед подняты, дальние спокойны', squad.alertCount === 2,
  `alert=${squad.alertCount}`);
check('место выстрела запомнено', squad.units[0].lastKnown !== null && Math.abs(squad.units[0].lastKnown.x + 10) < 1e-6);
const alarmPlayer = new THREE.Vector3(0, 0, 200);
let minAlarmD = Infinity;
for (let i = 0; i < 600; i++) {
  squad.update(1 / 60, alarmPlayer, alarm.hooks);
  minAlarmD = Math.min(minAlarmD, Math.hypot(squad.units[0].pos.x + 10, squad.units[0].pos.z));
}
check('услышавшие выстрел дошли до его места', minAlarmD < 1.5, `minD=${minAlarmD.toFixed(2)}`);
check('место выстрела стало районом поиска', squad.units[0].searchCenter !== null);

// выстрел далеко ото всех: тревоги нет
const deaf = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
deaf.alertShot({ x: 100, y: 20, z: 100 }, { x: 0, y: 0, z: 1 }, 20);
check('далёкий выстрел никого не поднимает', deaf.alertCount === 0);

// громкий выстрел: слышно в большом радиусе — все в круге идут к месту выстрела
const noise = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },    // в 10 м от выстрела
  { x: 0, z: 24, y: 0, rot: 0, weapon: 'pistol', home: { x: 0, z: 24 } },  // в 14 м: тоже слышит
  { x: 0, z: 46, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 46 } },   // 36 м: глухой
], CONFIG, npcWorld, emptyCovers);
noise.alertNoise({ x: 0, y: hm.heightAt(0, 0) + 1, z: 10 }, CONFIG.pistol.noiseRadius);
check('громкий выстрел поднимает всю округу в радиусе шума', noise.alertCount === 2, `alert=${noise.alertCount}`);
check('за радиусом шума выстрела не слышно', !noise.units[2].aware);

// присед: игрока замечают со значительно меньшей дистанции — стелс
const crouchHard = mkHooks();
const crouchSpotter = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const crouchFar = new THREE.Vector3(0, 0, 24); // 24 м: < полного зрения 28, > приседного
for (let i = 0; i < 600; i++) crouchSpotter.update(1 / 60, crouchFar, crouchHard.hooks);
check('стоящего игрока видят с 24 м', crouchSpotter.alertCount === 1, `alert=${crouchSpotter.alertCount}`);
const crouchSoft = mkHooks();
const crouchHider = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
for (let i = 0; i < 600; i++) crouchHider.update(1 / 60, crouchFar, crouchSoft.hooks, { crouch: true });
check('присевшего с 24 м не замечают (стелс)', crouchHider.alertCount === 0, `alert=${crouchHider.alertCount}`);
const crouchNear = mkHooks();
const crouchWatcher = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
for (let i = 0; i < 600; i++) crouchWatcher.update(1 / 60, new THREE.Vector3(0, 0, 8), crouchNear.hooks, { crouch: true });
check('в упор присевшего всё равно видят', crouchWatcher.alertCount === 1, `alert=${crouchWatcher.alertCount}`);

// фронт/тыл: спереди видят далеко, за спиной слепы — конус зрения (окно для палки в спину)
const sight = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const su = sight.units[0];
sight._think(su, new THREE.Vector3(0, 0, 20), CONFIG.npc.visionRange);
check('спереди NPC видит игрока с 20 м', su.sees === true);
sight._think(su, new THREE.Vector3(0, 0, -20), CONFIG.npc.visionRange);
check('за спиной с 20 м NPC не видит (front/back)', su.sees === false);
sight._think(su, new THREE.Vector3(0, 0, -6), CONFIG.npc.visionRange);
check('за спиной даже в упор (6 м) NPC слеп: видит только конус', su.sees === false);

// конус обзора уже прежних 180°: фланг в 60° виден, глубже 70° — уже тыл
const coneTry = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const cnu = coneTry.units[0];
coneTry._think(cnu, new THREE.Vector3(Math.sin(Math.PI / 3) * 20, 0, Math.cos(Math.PI / 3) * 20), CONFIG.npc.visionRange);
check('внутри конуса (60° от носа) NPC видит игрока с 20 м', cnu.sees === true);
const off80 = (80 * Math.PI) / 180;
coneTry._think(cnu, new THREE.Vector3(Math.sin(off80) * 20, 0, Math.cos(off80) * 20), CONFIG.npc.visionRange);
check('за фланком конуса (80°, вне 140°) NPC слеп на 20 м', cnu.sees === false);

// разворот: лицом к игроку — только пока видим; потерял — смотрит по ходу
const facing = new Npcs([
  { x: 0, z: 0, y: 0, rot: Math.PI, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const fu = facing.units[0];
fu.aware = true;   // контакт уже был
fu.sees = false;   // но игрок пропал из вида
fu.target = { x: 0, z: 10 }; // идёт на север
const eastPlayer = new THREE.Vector3(10, 0, 0);
for (let i = 0; i < 90; i++) facing._move(fu, 1 / 60, eastPlayer);
check('потеряв игрока, NPC смотрит по ходу движения, а не на него', Math.abs(fu.yaw) < 0.01, `yaw=${fu.yaw.toFixed(2)}`);
fu.pos.set(0, 0, 0);
fu.pauseT = 999; // стоим: цель не выбирается
fu.target = null;
fu.sees = true;
for (let i = 0; i < 90; i++) facing._move(fu, 1 / 60, eastPlayer);
check('видя игрока, NPC доворачивается на него', Math.abs(fu.yaw - Math.PI / 2) < 1e-6, `yaw=${fu.yaw.toFixed(3)}`);

// спокойный патруль доворачивается медленно (в бою — быстро)
const slow = new Npcs([
  { x: 0, z: 0, y: 0, rot: Math.PI, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const slu = slow.units[0];
slu.target = { x: 0, z: 10 }; // разворот на север: ровно π
for (let i = 0; i < 24; i++) slow._move(slu, 1 / 60, eastPlayer);
check('спокойный патруль поворачивается медленно', Math.abs(Math.PI - slu.yaw - CONFIG.npc.patrolTurnSpeed * 0.4) < 0.02,
  `Δ=${(Math.PI - slu.yaw).toFixed(2)}`);
for (let i = 0; i < 60; i++) slow._move(slu, 1 / 60, eastPlayer);
check('патруль всё же доворачивается до цели', Math.abs(slu.yaw) < 1e-6, `yaw=${slu.yaw.toFixed(3)}`);

// статисты: стоят на месте, сканируют головой; тревоги на них действуют
const stander = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 }, static: true },
], CONFIG, npcWorld, emptyCovers);
const stu = stander.units[0];
const standHooks = mkHooks();
const farOff = new THREE.Vector3(0, 0, 999);
let maxGaze = 0;
let minGaze = 0;
for (let i = 0; i < 600; i++) {
  stander.update(1 / 60, farOff, standHooks.hooks);
  maxGaze = Math.max(maxGaze, stu.gaze);
  minGaze = Math.min(minGaze, stu.gaze);
}
check('статист не патрулирует: стоит как вкопанный', stu.pos.x === 0 && stu.pos.z === 0);
check('голова статиста сканирует влево-вправо по амплитуде', maxGaze > 0.6 && minGaze < -0.6 &&
  maxGaze <= (CONFIG.npc.sweepAngle * Math.PI) / 180 + 1e-9, `max=${maxGaze.toFixed(2)} min=${minGaze.toFixed(2)}`);
stu.gaze = Math.PI / 4; // голова повёрнута: сектор обзора ушёл вбок
stander._think(stu, new THREE.Vector3(20, 0, 0), CONFIG.npc.visionRange);
check('сканирующая голова двигает сектор: игрок сбоку виден', stu.sees === true);
stu.gaze = 0;
stander._think(stu, new THREE.Vector3(20, 0, 0), CONFIG.npc.visionRange);
check('без подворота головы тот же игрок вне конуса', stu.sees === false);
stander.alertShot({ x: -10, y: stu.pos.y + 1, z: 0 }, { x: 1, y: 0, z: 0 }, 30);
check('тревога поднимает статиста', stu.aware === true);
let maxFromHome = 0;
for (let i = 0; i < 300; i++) {
  stander.update(1 / 60, farOff, standHooks.hooks);
  maxFromHome = Math.max(maxFromHome, Math.hypot(stu.pos.x, stu.pos.z));
}
check('поднятый статист идёт к месту тревоги', maxFromHome > 5, `max=${maxFromHome.toFixed(1)}`);

// отладочные зоны зрения по F3: зелёный веер конуса, каждый луч гаснет о стены, как свет
sight.setDebug(true);
const far999 = new THREE.Vector3(0, 0, 999);
for (let i = 0; i < 3; i++) sight.update(1 / 60, far999, mkHooks().hooks);
check('F3: зелёный веер зрения включён', sight.debugOn && sight.debugFront.visible &&
  sight.debugFront.count === CONFIG.npc.visionSlices);
check('веер зрения не попадает в хитсякан (вне parts)', !sight.parts.includes(sight.debugFront) && sight.debug.length === 1);
const dm = new THREE.Matrix4();
const dpos = new THREE.Vector3();
const dquat = new THREE.Quaternion();
const dsc = new THREE.Vector3();
let fanMin = Infinity;
let fanMax = 0;
for (let s = 0; s < sight.debugFront.count; s++) {
  sight.debugFront.getMatrixAt(s, dm);
  dm.decompose(dpos, dquat, dsc);
  fanMin = Math.min(fanMin, dsc.x);
  fanMax = Math.max(fanMax, dsc.x);
}
check('чистое поле: каждый луч веера — полный радиус зрения',
  Math.abs(fanMin - CONFIG.npc.visionRange) < 1e-4 && Math.abs(fanMax - CONFIG.npc.visionRange) < 1e-4,
  `min=${fanMin.toFixed(1)} max=${fanMax.toFixed(1)}`);
for (let i = 0; i < 3; i++) sight.update(1 / 60, far999, mkHooks().hooks, { crouch: true });
sight.debugFront.getMatrixAt(0, dm);
dm.decompose(dpos, dquat, dsc);
check('отладка: присед ужимает зону в реальном времени', Math.abs(dsc.x - CONFIG.npc.visionRange * CONFIG.npc.crouchVision) < 1e-4,
  `s=${dsc.x.toFixed(1)}`);
sight.setDebug(false);
check('F3 выключен: веер зрения скрыт', !sight.debugFront.visible && !sight.debugOn);

// стена режет зелёный веер: лучи гаснут о дом, как свет — центр обрезан, края целы
const fanCovers = buildCovers(cfg, { buildings: [{ x: 0, z: 10, w: 8, d: 4 }], rocks: [], trees: [], city: null });
const fanSeer = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, fanCovers);
fanSeer.setDebug(true);
for (let i = 0; i < 3; i++) fanSeer.update(1 / 60, far999, mkHooks().hooks);
let wallMin = Infinity;
let wallMax = 0;
for (let s = 0; s < fanSeer.debugFront.count; s++) {
  fanSeer.debugFront.getMatrixAt(s, dm);
  dm.decompose(dpos, dquat, dsc);
  wallMin = Math.min(wallMin, dsc.x);
  wallMax = Math.max(wallMax, dsc.x);
}
check('лучи веера гаснут о стену: центр обрезан, края целы', wallMin < 9 && wallMax > CONFIG.npc.visionRange - 0.1,
  `min=${wallMin.toFixed(1)} max=${wallMax.toFixed(1)}`);

// новый выстрел перенацеливает уже разбуженную группу (а не только спящих)
const squad2 = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
  { x: 4, z: 0, y: 0, rot: 0, weapon: 'pistol', home: { x: 4, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
squad2.alertShot({ x: -10, y: hm.heightAt(0, 0) + 1, z: 0 }, { x: 1, y: 0, z: 0 }, 30);
const shotNew = { x: 0, y: hm.heightAt(0, 0) + 1, z: 10 };
squad2.alertShot(shotNew, { x: 0, y: 0, z: -1 }, 20);
check('новый выстрел обновляет зону поиска группы',
  Math.abs(squad2.units[0].lastKnown.z - 10) < 1e-6 && Math.abs(squad2.units[1].lastKnown.z - 10) < 1e-6,
  `z0=${squad2.units[0].lastKnown.z} z1=${squad2.units[1].lastKnown.z}`);
// воющего (видит игрока) выстрел мимо цели не отвлекает
squad2.units[0].sees = true;
squad2.units[0].lastKnown = { x: 7, z: 7 };
squad2.alertShot({ x: -30, y: hm.heightAt(0, 0) + 1, z: 0 }, { x: 1, y: 0, z: 0 }, 60);
check('воюющего NPC выстрел мимо не отвлекает',
  squad2.units[0].lastKnown.x === 7 && squad2.units[0].lastKnown.z === 7);

// после поиска угрозы патруль широкий: обходят район находки, а не пятачок
const wide = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
wide.units[0].aware = true;
wide.units[0].searchCenter = { x: 0, z: 0 };
let maxPatrol = 0;
for (let i = 0; i < 3600; i++) {
  wide.update(1 / 60, alarmPlayer, alarm.hooks);
  maxPatrol = Math.max(maxPatrol, Math.hypot(wide.units[0].pos.x, wide.units[0].pos.z));
}
check('патруль после поиска ходит шире прежнего', maxPatrol > CONFIG.npc.patrolRadius + 2 &&
  maxPatrol < CONFIG.npc.searchPatrolRadius + 2, `max=${maxPatrol.toFixed(1)}`);

// смерть и воскрешение по R
const duel = mkHooks();
const lone = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const duelPlayer = new THREE.Vector3(0, 0, 2.6);
for (let i = 0; i < 240; i++) lone.update(1 / 60, duelPlayer, duel.hooks);
check('палочник бьёт в упор', duel.ev.dmg.length > 0, `hits=${duel.ev.dmg.length}`);
const duelHits = duel.ev.dmg.length;
lone.hit(0, { x: 0, z: 1 }, { damage: 999, knockback: 2 }, duelPlayer);
check('смертельный удар валит NPC', lone.aliveCount === 0);
for (let i = 0; i < 240; i++) lone.update(1 / 60, duelPlayer, duel.hooks);
check('мёртвый NPC не атакует', duel.ev.dmg.length === duelHits);
lone.resetAll();
check('R возвращает NPC в строй', lone.aliveCount === 1 && lone.units[0].hp === CONFIG.npc.hp);

// зоны урона: тело — три пули, голова — хэдшот; палка в спину валит одним ударом
const zones = new Npcs([
  { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
], CONFIG, npcWorld, emptyCovers);
const shootFrom = new THREE.Vector3(0, 1.65, 3);
const bodyPoint = new THREE.Vector3(0, 1.1, 0.16); // грудь
const headPoint = new THREE.Vector3(0, 1.68, 0.16); // голова
const BULLET = { damage: CONFIG.pistol.damage, headDamage: CONFIG.pistol.headDamage, knockback: 0 };
zones.hit(0, { x: 0, z: -1 }, BULLET, shootFrom, bodyPoint);
check('пуля в тело снимает треть здоровья', zones.units[0].hp === CONFIG.npc.hp - CONFIG.pistol.damage,
  `hp=${zones.units[0].hp}`);
zones.hit(0, { x: 0, z: -1 }, BULLET, shootFrom, bodyPoint);
zones.hit(0, { x: 0, z: -1 }, BULLET, shootFrom, bodyPoint);
check('три пули в тело роняют NPC', zones.aliveCount === 0);
zones.resetAll();
zones.hit(0, { x: 0, z: -1 }, BULLET, shootFrom, headPoint);
check('пуля в голову — хэдшот с одного раза', zones.aliveCount === 0);
zones.resetAll();
const STICK = { damage: CONFIG.stick.damage, backstabMult: CONFIG.stick.backstabMult, knockback: 0 };
zones.hit(0, { x: 0, z: 1 }, STICK, new THREE.Vector3(0, 1.65, -2)); // NPC смотрит в +z, игрок сзади
check('удар палкой в спину валит одним ударом', zones.aliveCount === 0);
zones.resetAll();
zones.hit(0, { x: 0, z: -1 }, STICK, shootFrom); // игрок спереди: обычный урон
check('удар палкой спереди не ваншот', zones.units[0].hp === CONFIG.npc.hp - CONFIG.stick.damage,
  `hp=${zones.units[0].hp}`);

// городские NPC: спокойны на старте и патрулируют только в городе
const npcsView = new Npcs(layout.npcs, CONFIG, { ...npcWorld, cityLift }, covers);
check('городские NPC спокойны на старте', npcsView.aliveCount === cfg.layout.npcs && npcsView.alertCount === 0);
for (let i = 0; i < 600; i++) npcsView.update(1 / 60, new THREE.Vector3(0, 0, 0), far.hooks);
check('патруль не выходит из города', npcsView.units.every((u) =>
  u.pos.x > cityZone.minX - 1 && u.pos.x < cityZone.maxX + 1 &&
  u.pos.z > cityZone.minZ - 1 && u.pos.z < cityZone.maxZ + 1));

// ---------- H. Лагерь ----------
console.log('\nH. Лагерь');
const camp = new Camp(CONFIG, { heightmap: hm, cityLift: null });
check('лагерь собран: постройки и шесть дружелюбных',
  camp.group.children.length > 10 && camp.friends.length === 6 && camp.colliders.length >= 6);
check('лица друзей и поза пассажира: девять мешей, меш — в общем наборе',
  camp.parts.length === 9 && camp.faces.count === 6);
const tentWallTry = resolveCircleAabb(camp.tent.x - camp.tent.half + 0.25, camp.tent.z,
  0.4, camp.tent.gy + 0.5, 1.8, camp.colliders);
check('стена палатки не пропускает сквозь себя', tentWallTry.hit);
const tentDoorTry = resolveCircleAabb(camp.tent.x, camp.tent.z + camp.tent.depth / 2 - 0.3,
  0.4, camp.tent.gy + 0.5, 1.8, camp.colliders);
check('вход в палатку открыт — внутрь можно зайти', !tentDoorTry.hit);
const fTent = camp.friends[4];
const fTentTry = resolveCircleAabb(fTent.x, fTent.z, 0.25, fTent.y, 1.2, camp.colliders);
check('друг за столом в палатке стоит свободно', !fTentTry.hit);
const spawnTry = resolveCircleAabb(CONFIG.camp.x + CONFIG.camp.spawnDx, CONFIG.camp.z + CONFIG.camp.spawnDz,
  0.4, hm.heightAt(CONFIG.camp.x + CONFIG.camp.spawnDx, CONFIG.camp.z + CONFIG.camp.spawnDz), 1.8, camp.colliders);
check('спавн игрока не торчит в постройках', !spawnTry.hit);

// костёр: пламя живёт, свет мерцает, тени — по кнобу fireShadows
check('костёр горит: пламя из трёх кубиков и яркий свет на 21 м',
  camp.flame.children.length === 3 && camp.fireLight.intensity >= 5 && camp.fireLight.distance >= 21);
check('тени костра — минимальная карта, по кнобу fireShadows',
  camp.fireLight.castShadow === CONFIG.camp.fireShadows && camp.fireLight.shadow.mapSize.x === 256);
const fireI0 = camp.fireLight.intensity;
const fireY0 = camp.flame.position.y;
const awayVec = new THREE.Vector3(999, 0, 999);
for (let i = 0; i < 30; i++) camp.update(1 / 60, awayVec);
check('пламя дрожит, свет мерцает во времени',
  camp.fireLight.intensity !== fireI0 && camp.flame.position.y !== fireY0,
  `I=${camp.fireLight.intensity.toFixed(2)}`);

// городской друг: центр города, не в доме, стоит на покрытии
const campCity = new Camp(CONFIG, { heightmap: hm, cityLift });
const fCity = campCity.friends[5];
check('городской друг стоит в центре города и не в доме',
  Math.abs(fCity.x - cfg.city.cx) < 1e-6 && Math.abs(fCity.z - cfg.city.cz) < 1e-6 &&
  !inBuilding(fCity.x, fCity.z, 1),
  `x=${fCity.x.toFixed(1)} z=${fCity.z.toFixed(1)}`);
check('городской друг стоит на покрытии города',
  Math.abs(fCity.y - (hm.heightAt(fCity.x, fCity.z) + cityLift(fCity.x, fCity.z))) < 1e-6);

// спутник: E — зовём за собой; повторный E — «жди здесь», стоит на месте
check('E у стоящего друга включает спутника', campCity.interact(fCity) === true && fCity.mode === 'follow');
check('у сидящего друга взаимодействия нет', campCity.interact(campCity.friends[1]) === false &&
  campCity.friends[1].mode === 'stay');
check('friendOf: тело стоящего и голова — друзья, тело сидящего — нет',
  campCity.friendOf(campCity.standBody, 0) === campCity.friends[3] &&
  campCity.friendOf(campCity.standShell, 1) === campCity.friends[5] &&
  campCity.friendOf(campCity.head, 2) === campCity.friends[2] &&
  campCity.friendOf(campCity.faces, 5) === campCity.friends[5] &&
  campCity.friendOf(campCity.sitBody, 0) === null);
const followTo = new THREE.Vector3(fCity.x + 20, 0, fCity.z);
for (let i = 0; i < 600; i++) campCity.update(1 / 60, followTo);
const followD = Math.hypot(followTo.x - fCity.x, followTo.z - fCity.z);
check('спутник догоняет игрока и держит дистанцию', followD < CONFIG.camp.followStop + 0.6,
  `d=${followD.toFixed(1)}`);
check('E при спутнике — «жди здесь»', campCity.interact(fCity) === true && fCity.mode === 'stay');
const waitX = fCity.x;
const waitZ = fCity.z;
followTo.set(fCity.x + 40, 0, fCity.z);
for (let i = 0; i < 300; i++) campCity.update(1 / 60, followTo);
check('в режиме ожидания друг стоит на месте',
  Math.abs(fCity.x - waitX) < 1e-6 && Math.abs(fCity.z - waitZ) < 1e-6);

// палатка в гриде укрытий: сквозь неё враждебные не видят игрока
const tentCovers = buildCovers(cfg, { buildings: [], rocks: [], trees: [], city: null }, camp.coverBoxes);
const tentGuard = new Npcs([
  { x: camp.tent.x, z: camp.tent.z - 6, y: 0, rot: 0, weapon: 'stick', home: { x: camp.tent.x, z: camp.tent.z - 6 } },
], CONFIG, npcWorld, tentCovers);
check('палатка блокирует линию взгляда NPC (как дом)',
  !tentGuard._los(camp.tent.x, camp.tent.z - 6, camp.tent.x, camp.tent.z + 6));
check('рядом с палаткой линия взгляда свободна',
  tentGuard._los(camp.tent.x + 8, camp.tent.z - 6, camp.tent.x + 8, camp.tent.z + 6));

const f0 = camp.friends[0];
const nearCamp = new THREE.Vector3(f0.x + 3, 0, f0.z + 3);
for (let i = 0; i < 300; i++) camp.update(1 / 60, nearCamp);
check('головы дружелюбных поворачиваются на близкого игрока', Math.abs(f0.headYaw) > 0.5,
  `yaw=${f0.headYaw.toFixed(2)}`);
const farCamp = new THREE.Vector3(f0.x + 100, 0, f0.z);
for (let i = 0; i < 300; i++) camp.update(1 / 60, farCamp);
check('игрок ушёл — головы возвращаются к костру', Math.abs(f0.headYaw) < 0.08,
  `yaw=${f0.headYaw.toFixed(2)}`);

// ---------- I. Мотоцикл ----------
console.log('\nI. Мотоцикл');
const bikeWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null };
const bike = new Motorcycle(CONFIG, bikeWorld);
check('мотоцикл стоит у лагеря носом к городу (курс вдоль дороги)',
  Math.abs(bike.pos.x - (CONFIG.camp.x + CONFIG.bike.dx)) < 1e-9 &&
  Math.abs(bike.pos.z - (CONFIG.camp.z + CONFIG.bike.dz)) < 1e-9 && Math.abs(bike.yaw - CONFIG.bike.yaw) < 1e-9);
check('корпус мотоцикла — коллайдер: в железе не пройдёшь', bikeWorld.colliders.length === 1 &&
  bikeWorld.colliders[0] === bike.collider);
const pedTry = resolveCircleAabb(bike.pos.x - 0.8, bike.pos.z, 0.4, bike.pos.y, 1.8, [bike.collider]);
check('пешеход выталкивается из стоящего мотоцикла',
  pedTry.hit && Math.abs(pedTry.x - (bike.pos.x - CONFIG.bike.radius - 0.4)) < 1e-6, `x=${pedTry.x.toFixed(2)}`);
const bikeSpawnClear = resolveCircleAabb(bike.pos.x, bike.pos.z, CONFIG.bike.radius, bike.pos.y, 1.05, camp.colliders);
check('стоянка мотоцикла не пересекает постройки лагеря', !bikeSpawnClear.hit);

const gas = { forward: true, back: false, left: false, right: false };
bike.mount();
// автокоробка: со старта рвёт на первой, к 2 с — вторая, к 5 с — четвёртая на 24 м/с
for (let i = 0; i < 30; i++) bike.update(1 / 60, gas);
check('старт: первая передача, разгон в пол',
  bike.gear === 0 && bike.speed > 4 && bike.speed < 6, `g=${bike.gear} v=${bike.speed.toFixed(1)}`);
for (let i = 0; i < 90; i++) bike.update(1 / 60, gas);
check('к 2 с автокоробка щёлкнула на вторую', bike.gear === 2 && bike.speed > 11 && bike.speed < 17,
  `g=${bike.gear} v=${bike.speed.toFixed(1)}`);
for (let i = 0; i < 180; i++) bike.update(1 / 60, gas);
check('к 5 с — четвёртая: вдвое быстрее спринта', bike.gear === 3 &&
  Math.abs(bike.speed - CONFIG.bike.gears[3]) < 1e-9 && CONFIG.bike.gears[3] >= CONFIG.player.sprintSpeed * 2 &&
  bike.pos.z - bike.home.z > 40, `g=${bike.gear} v=${bike.speed.toFixed(1)} s=${(bike.pos.z - bike.home.z).toFixed(1)}`);

// фара (L): выкл → ближний → дальний → выкл; пятно бьёт дальше и ярче
check('фара выключена по умолчанию', bike.lightMode === 0 && !bike.lampLight.visible);
bike.toggleLight();
check('L: ближний свет — тусклее и короче', bike.lightMode === 1 && bike.lampLight.visible &&
  bike.lampLight.intensity === CONFIG.bike.lightLow && bike.lampLight.distance === CONFIG.bike.lightLowDist);
bike.toggleLight();
check('L: дальний свет — ярче и дальше', bike.lightMode === 2 &&
  bike.lampLight.intensity === CONFIG.bike.lightHigh && bike.lampLight.distance === CONFIG.bike.lightHighDist);
bike.toggleLight();
check('L по кругу: снова выключено', bike.lightMode === 0 && !bike.lampLight.visible);

const yawBefore = bike.yaw;
const turnRight = { forward: true, back: false, left: false, right: true };
for (let i = 0; i < 60; i++) bike.update(1 / 60, turnRight);
check('руль вправо уводит курс вправо, корпус кренится',
  bike.yaw < yawBefore - 0.5 && bike.group.rotation.z > 0.2,
  `Δ=${(bike.yaw - yawBefore).toFixed(2)} lean=${bike.group.rotation.z.toFixed(2)}`);

const wallBox = { minX: -20, maxX: 20, minZ: -180, maxZ: -168, minY: -10, maxY: 30 };
const ramWorld = { heightmap: hm, colliders: [wallBox], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null };
const ram = new Motorcycle(CONFIG, ramWorld);
ram.mount();
for (let i = 0; i < 300; i++) ram.update(1 / 60, gas);
check('стена поперёк дороги останавливает мотоцикл', Math.abs(ram.pos.z - (-180 - CONFIG.bike.radius)) < 0.01 && ram.speed < 1,
  `z=${ram.pos.z.toFixed(2)} v=${ram.speed.toFixed(2)}`);
ram.dismount();
for (let i = 0; i < 60; i++) ram.update(1 / 60, null);
check('без водителя мотоцикл не едет', !ram.mounted && ram.speed === 0);
ram.reset();
check('R возвращает мотоцикл на стоянку', Math.abs(ram.pos.x - ram.home.x) < 1e-9 && Math.abs(ram.pos.z - ram.home.z) < 1e-9);

// ---------- J. Пассажир: спутник садится на мотоцикл ----------
console.log('\nJ. Пассажир');
const passWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null };
const passBike = new Motorcycle(CONFIG, passWorld);
const passCamp = new Camp(CONFIG, { heightmap: hm, cityLift: null });
const companion = passCamp.friends[3]; // стоящий у вешалок — его и зовём за собой
check('спутник позван за собой (E)', passCamp.interact(companion) === true && companion.mode === 'follow');
const passPlayer = new THREE.Vector3(passBike.pos.x, 0, passBike.pos.z); // игрок стоит у седла
for (let i = 0; i < 120; i++) passCamp.update(1 / 60, passPlayer); // без игрока в седле мотоцикл не едет
check('без игрока в седле спутник идёт пешком', companion.ride === false && companion.mode === 'follow');
passBike.mount();
for (let i = 0; i < 120; i++) passCamp.update(1 / 60, passPlayer, passBike);
check('игрок сел — спутник садится пассажиром', companion.ride === true);
check('пассажир сидит в седле за спиной игрока',
  Math.abs(companion.x - (passBike.pos.x + Math.sin(passBike.yaw) * -0.42)) < 1e-9 &&
  Math.abs(companion.z - (passBike.pos.z + Math.cos(passBike.yaw) * -0.42)) < 1e-9 &&
  Math.abs(companion.y - (passBike.pos.y + 0.87)) < 1e-9 &&
  Math.abs(companion.yaw - passBike.yaw) < 1e-9);
for (let i = 0; i < 120; i++) { // едем вдвоём вдоль дороги
  passBike.update(1 / 60, gas);
  passCamp.update(1 / 60, passPlayer, passBike);
}
check('в пути пассажир держится седла и кренится с мотоциклом',
  companion.ride === true &&
  Math.abs(companion.x - (passBike.pos.x + Math.sin(passBike.yaw) * -0.42)) < 1e-9 &&
  Math.abs(companion.z - (passBike.pos.z + Math.cos(passBike.yaw) * -0.42)) < 1e-9 &&
  Math.abs(companion.lean - passBike.group.rotation.z) < 1e-9);
passBike.dismount();
passCamp.update(1 / 60, passPlayer, passBike); // кадр высадки: слезает слева
check('высадка: слезает слева и снова топает сам',
  companion.ride === false &&
  Math.abs(companion.x - (passBike.pos.x + Math.cos(passBike.yaw) * 1.0)) < 1e-9 &&
  Math.abs(companion.z - (passBike.pos.z - Math.sin(passBike.yaw) * 1.0)) < 1e-9 &&
  Math.abs(companion.y - hm.heightAt(companion.x, companion.z)) < 1e-6);

// ---------- Итог ----------
console.log(`\nИтог: ${pass} ok, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
