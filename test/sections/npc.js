// G. NPC: зрение, укрытия, тревога, бой, патруль, урон и отладочный веер.
import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { Npcs } from '../../src/world/npc.js';
import { buildCovers } from '../../src/world/covers.js';
import { check } from '../harness.js';

export function npcSection(ctx) {
  const { cfg, layout, hm, cityLift, cityZone, npcWorld, emptyCovers, mkHooks } = ctx;

  console.log('\nG. NPC');
  const covers = buildCovers(cfg, layout);
  check('укрытия собраны в грид (дома, валуны, стволы)', covers.grid.size > 0 && covers.city !== null);

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

  // угол держит минуту: не разовый выгляд, а очереди весь бой
  const hold = mkHooks();
  const holder = new Npcs([
    { x: 0, z: 3.5, y: 0, rot: Math.PI / 2, weapon: 'pistol', home: { x: 0, z: 3.5 } },
  ], CONFIG, npcWorld, peekCovers);
  const holdPlayer = new THREE.Vector3(9, 0, 3.5);
  for (let i = 0; i < 60; i++) holder.update(1 / 60, holdPlayer, hold.hooks);
  holdPlayer.set(9, 0, 0); // спрятался за домом
  let burstSeconds = 0;
  let prevBurst = 0;
  let spotTaken = false;
  for (let i = 0; i < 3600; i++) {
    holder.update(1 / 60, holdPlayer, hold.hooks);
    if (holder.units[0].spot) spotTaken = true;
    if (i % 60 === 59) {
      if (hold.ev.shots - prevBurst >= 2) burstSeconds++; // секунда с очередью 2+
      prevBurst = hold.ev.shots;
    }
  }
  check('угол выгляда забронирован за стрелком', spotTaken);
  check('вышел на угол и держит его очередями всю минуту', burstSeconds >= 3 && hold.ev.shots >= 12,
    `очередей/с=${burstSeconds} shots=${hold.ev.shots}`);

  // разворот в бою: цель пропала из вида — смотрит туда, где видел её в последний раз
  const gazer = new Npcs([
    { x: 0, z: 0, y: 0, rot: 0, weapon: 'pistol', home: { x: 0, z: 0 } },
  ], CONFIG, npcWorld, emptyCovers);
  const gz = gazer.units[0];
  gz.aware = true;
  gz.sees = false;
  gz.lastKnown = { x: 10, z: 0 }; // видел на востоке
  gz.pauseT = 999; // стоим: цель движения не выбирается
  gz.target = null;
  for (let i = 0; i < 90; i++) gazer.brain.move(gz, 1 / 60, new THREE.Vector3(-10, 0, 0));
  check('в бою смотрит на lastKnown, а не по ходу движения', Math.abs(gz.yaw - Math.PI / 2) < 1e-6,
    `yaw=${gz.yaw.toFixed(3)}`);

  // двое у одного дома: углы делят, в одну точку не лезут
  const duoCovers = buildCovers(cfg, { buildings: [{ x: 5, z: 0, w: 3, d: 4 }], rocks: [], trees: [], city: null });
  const duo = mkHooks();
  const pair = new Npcs([
    { x: 0, z: 3.5, y: 0, rot: Math.PI / 2, weapon: 'pistol', home: { x: 0, z: 3.5 } },
    { x: -2, z: 6, y: 0, rot: Math.PI / 2, weapon: 'pistol', home: { x: -2, z: 6 } }, // дом не застит обзор
  ], CONFIG, npcWorld, duoCovers);
  const duoPlayer = new THREE.Vector3(9, 0, 3.5);
  for (let i = 0; i < 60; i++) pair.update(1 / 60, duoPlayer, duo.hooks);
  check('оба стрелка заметили игрока', pair.alertCount === 2, `alert=${pair.alertCount}`);
  duoPlayer.set(9, 0, 0);
  let sameSpot = false;
  let firstSpot = false;
  let secondSpot = false;
  for (let i = 0; i < 1800; i++) {
    pair.update(1 / 60, duoPlayer, duo.hooks);
    const [a, b] = pair.units;
    if (a.spot) firstSpot = true;
    if (b.spot) secondSpot = true;
    if (a.spot && a.spot === b.spot) sameSpot = true;
  }
  check('две точки выгляда не занимают вдвоём', !sameSpot);
  check('свой угол получает каждый из двоих', firstSpot && secondSpot,
    `a=${firstSpot} b=${secondSpot}`);

  // заняты все углы: второй стрелок ждёт за спиной того, кто выглядывает
  const busy = buildCovers(cfg, { buildings: [{ x: 5, z: 0, w: 3, d: 4 }], rocks: [], trees: [], city: null });
  const wallOb = busy.obstacles[0];
  const wallSpots = busy.spots(wallOb);
  const owners = wallSpots.map((s, k) => ({ pos: new THREE.Vector3(s.x, 0, s.z), id: k }));
  wallSpots.forEach((s, k) => { s.owner = owners[k]; }); // углы разобрали товарищи
  const late = { pos: new THREE.Vector3(0, 0, 3.5), spot: null };
  check('свободных углов нет — бронь не выдаётся', busy.claimSpot(late, wallOb, 9, 0) === null);
  const queue = busy.queueSpot(late, wallOb, CONFIG.npc.queueDist);
  const qOwner = wallSpots[0].owner;
  check('все углы заняты — встаёт в затылок товарищу',
    !!queue && Math.abs(Math.hypot(queue.x - qOwner.pos.x, queue.z - qOwner.pos.z) - CONFIG.npc.queueDist) < 1e-6,
    JSON.stringify(queue));
  busy.releaseAll();
  check('releaseAll снимает все брони', wallSpots.every((s) => s.owner === null));

  // терпение кончилось: стрелок бросает угол и приходит в точку контакта
  const lostCovers = buildCovers(cfg, { buildings: [{ x: 5, z: 0, w: 3, d: 4 }], rocks: [], trees: [], city: null });
  const lostHk = mkHooks();
  const seeker = new Npcs([
    { x: 0, z: 3.5, y: 0, rot: Math.PI / 2, weapon: 'pistol', home: { x: 0, z: 3.5 } },
  ], CONFIG, npcWorld, lostCovers);
  const lostPlayer = new THREE.Vector3(9, 0, 3.5);
  for (let i = 0; i < 60; i++) seeker.update(1 / 60, lostPlayer, lostHk.hooks); // заметил и запомнил
  const contact = { x: lostPlayer.x, z: lostPlayer.z };
  lostPlayer.set(-20, 0, -60); // ушёл далеко: ни вида, ни прямой видимости
  let lostMinD = Infinity;
  for (let i = 0; i < 1800; i++) {
    seeker.update(1 / 60, lostPlayer, lostHk.hooks);
    const su2 = seeker.units[0];
    lostMinD = Math.min(lostMinD, Math.hypot(su2.pos.x - contact.x, su2.pos.z - contact.z));
  }
  check('потерял игрока — дошёл до точки контакта', lostMinD < 1.5 && seeker.units[0].spot === null,
    `minD=${lostMinD.toFixed(2)}`);

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
  sight.brain.think(su, new THREE.Vector3(0, 0, 20), CONFIG.npc.visionRange);
  check('спереди NPC видит игрока с 20 м', su.sees === true);
  sight.brain.think(su, new THREE.Vector3(0, 0, -20), CONFIG.npc.visionRange);
  check('за спиной с 20 м NPC не видит (front/back)', su.sees === false);
  sight.brain.think(su, new THREE.Vector3(0, 0, -6), CONFIG.npc.visionRange);
  check('за спиной даже в упор (6 м) NPC слеп: видит только конус', su.sees === false);

  // конус обзора уже прежних 180°: фланг в 60° виден, глубже 70° — уже тыл
  const coneTry = new Npcs([
    { x: 0, z: 0, y: 0, rot: 0, weapon: 'stick', home: { x: 0, z: 0 } },
  ], CONFIG, npcWorld, emptyCovers);
  const cnu = coneTry.units[0];
  coneTry.brain.think(cnu, new THREE.Vector3(Math.sin(Math.PI / 3) * 20, 0, Math.cos(Math.PI / 3) * 20), CONFIG.npc.visionRange);
  check('внутри конуса (60° от носа) NPC видит игрока с 20 м', cnu.sees === true);
  const off80 = (80 * Math.PI) / 180;
  coneTry.brain.think(cnu, new THREE.Vector3(Math.sin(off80) * 20, 0, Math.cos(off80) * 20), CONFIG.npc.visionRange);
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
  for (let i = 0; i < 90; i++) facing.brain.move(fu, 1 / 60, eastPlayer);
  check('потеряв игрока, NPC смотрит по ходу движения, а не на него', Math.abs(fu.yaw) < 0.01, `yaw=${fu.yaw.toFixed(2)}`);
  fu.pos.set(0, 0, 0);
  fu.pauseT = 999; // стоим: цель не выбирается
  fu.target = null;
  fu.sees = true;
  for (let i = 0; i < 90; i++) facing.brain.move(fu, 1 / 60, eastPlayer);
  check('видя игрока, NPC доворачивается на него', Math.abs(fu.yaw - Math.PI / 2) < 1e-6, `yaw=${fu.yaw.toFixed(3)}`);

  // спокойный патруль доворачивается медленно (в бою — быстро)
  const slow = new Npcs([
    { x: 0, z: 0, y: 0, rot: Math.PI, weapon: 'stick', home: { x: 0, z: 0 } },
  ], CONFIG, npcWorld, emptyCovers);
  const slu = slow.units[0];
  slu.target = { x: 0, z: 10 }; // разворот на север: ровно π
  for (let i = 0; i < 24; i++) slow.brain.move(slu, 1 / 60, eastPlayer);
  check('спокойный патруль поворачивается медленно', Math.abs(Math.PI - slu.yaw - CONFIG.npc.patrolTurnSpeed * 0.4) < 0.02,
    `Δ=${(Math.PI - slu.yaw).toFixed(2)}`);
  for (let i = 0; i < 60; i++) slow.brain.move(slu, 1 / 60, eastPlayer);
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
  stander.brain.think(stu, new THREE.Vector3(20, 0, 0), CONFIG.npc.visionRange);
  check('сканирующая голова двигает сектор: игрок сбоку виден', stu.sees === true);
  stu.gaze = 0;
  stander.brain.think(stu, new THREE.Vector3(20, 0, 0), CONFIG.npc.visionRange);
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
}
