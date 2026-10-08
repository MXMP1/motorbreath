// D. Симуляция игрока, E. Предметы в руках, стрельба и эффекты попаданий.
import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { Player, hurtKick } from '../../src/player/player.js';
import { Viewmodel } from '../../src/player/viewmodel.js';
import { Impacts } from '../../src/world/impacts.js';
import { check } from '../harness.js';

export function playerSection(ctx) {
  const { cfg, hm } = ctx;

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

  // ---------- вылет из седла: полежать и встать ----------
  player.setWorld(openWorld);
  player.respawn();
  camera.rotation.y = Math.PI; // взгляд на +z: «вперёд» совпадает с броском — послушается, уедет дальше
  const downZ = player.pos.z;
  player.throwOut(0, CONFIG.bike.crash.ejectUp, 8);
  check('throwOut: игрок сбит, таймер лёжки полный, тело летит',
    player.downT === CONFIG.player.down.time && player.getUpT === 0 && player.lie === 0 &&
    player.vel.z === 8 && player.vel.y === CONFIG.bike.crash.ejectUp && !player.onGround);
  keys.forward = true;
  stepN(2);
  check('сбитый не слушается клавиш: скорость не растёт',
    player.hSpeed === 8 && player.state === 'лежит', `v=${player.hSpeed.toFixed(2)}`);
  for (let i = 0; i < 60; i++) player.update(1 / 120, keys); // 0.5 с: тело приземлилось
  check('тело упало на землю и отлетело по инерции',
    player.onGround && Math.abs(player.pos.y - hm.heightAt(player.pos.x, player.pos.z)) < 0.02 &&
    player.pos.z > downZ + 0.5, `dz=${(player.pos.z - downZ).toFixed(2)}`);
  check('лёжа глаза у земли, а трение гасит инерцию',
    player.lie > 0.9 && player.eye < CONFIG.player.down.eye + 0.25 && player.hSpeed < 4,
    `lie=${player.lie.toFixed(2)} eye=${player.eye.toFixed(2)} v=${player.hSpeed.toFixed(2)}`);
  let guard = 0;
  while (player.downT > 0 && guard < 2000) { player.update(1 / 120, keys); guard++; }
  check('полежал down.time — начинается подъём',
    player.downT === 0 && player.getUpT === CONFIG.player.down.getUp && player.state === 'встаёт');
  guard = 0;
  while (player.getUpT > 0 && guard < 2000) { player.update(1 / 120, keys); guard++; }
  check('встал: поза и глаза обычные',
    player.getUpT === 0 && player.lie === 0 && player.state === 'стоя' &&
    Math.abs(player.eye - CONFIG.player.eyeHeight) < 1e-9, `eye=${player.eye.toFixed(2)}`);
  const stoodZ = player.pos.z;
  stepN(30);
  check('после подъёма управление возвращается', player.pos.z > stoodZ + 0.5, `dz=${(player.pos.z - stoodZ).toFixed(2)}`);
  keys.forward = false;
  player.respawn();
  check('respawn сбрасывает состояние «сбит»',
    player.downT === 0 && player.getUpT === 0 && player.lie === 0);

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
}
