import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { CONFIG } from './config.js';
import { Render } from './render.js';
import { buildWorld, disposeWorld } from './world/assemble.js';
import { pushBagsByBins } from './world/props.js';
import { Player, hurtKick } from './player/player.js';
import { Viewmodel } from './player/viewmodel.js';
import { Impacts } from './world/impacts.js';
import { Input } from './core/input.js';
import { resolveCircleAabb } from './core/collide.js';
import { Hud } from './core/hud.js';
import { Quest } from './quest/quest.js';
import { QuestUI } from './quest/quest-ui.js';
import { Markers } from './quest/markers.js';

// ---------- рендерер, сцена, камера ----------
const canvas = document.getElementById('game');
const render = new Render(canvas, CONFIG);
const { renderer, scene, camera } = render;

// ---------- управление ----------
const controls = new PointerLockControls(camera, canvas);
controls.pointerSpeed = CONFIG.player.sens / 0.002;

const hint = document.getElementById('hint');
const damageEl = document.getElementById('damage'); // красный фильтр урона
const hitmarkEl = document.getElementById('hitmarker'); // X в центре: попадание по NPC
const promptEl = document.getElementById('prompt'); // подсказка «E» на дружелюбном рядом
let hitmarkT = 0;
let interactFriend = null; // дружелюбный под прицелом: с ним работает E
let interactBike = false;  // мотоцикл под прицелом на дистанции посадки
function showHitmark() { hitmarkT = CONFIG.hud.hitMarkTime; }
document.addEventListener('click', () => { if (!controls.isLocked) controls.lock(); });
controls.addEventListener('lock', () => hint.classList.add('hidden'));
controls.addEventListener('unlock', () => hint.classList.remove('hidden'));

const input = new Input(controls);
const hud = new Hud();

// ---------- мир ----------
let world = null;
let seed = CONFIG.seed;
let quest = null; // создаётся после первого мира; перепривязывается на G

function rebuildWorld(newSeed) {
  disposeWorld(world, scene);
  seed = newSeed;
  interactFriend = null; // старый мир исчез — и цель взаимодействия тоже
  world = buildWorld({ ...CONFIG, seed }, scene);
  world.npcs.setDebug(hud.visible); // отладочные зоны зрения живут вместе с HUD (F3)
  if (quest) quest.attach(world); // новый мир — новые друзья, квест с начала
  return world;
}

rebuildWorld(seed);

// ---------- игрок, предметы в руках, попадания ----------
const player = new Player(camera, CONFIG, world);
const viewmodel = new Viewmodel(CONFIG);
const impacts = new Impacts(CONFIG);
scene.add(impacts.group);

// Квест «Вывести Малого»: логика, DOM-слой и маркер «!». Маркер живёт на сцене
// постоянно (не в world.disposables) — переживает пересборку мира на G.
quest = new Quest(CONFIG, world.camp.friends, {
  cx: CONFIG.city.cx, cz: CONFIG.city.cz, halfW: CONFIG.city.halfW, halfD: CONFIG.city.halfD,
});
const questUI = new QuestUI();
const markers = new Markers(CONFIG);
markers.addTo(scene);

// NPC сообщает о себе наружу: урон игроку, вспышка и след выстрела у ствола
const npcMuzzlePos = new THREE.Vector3();
const npcMuzzleDir = new THREE.Vector3();
const npcTraceTo = new THREE.Vector3();
const npcHooks = {
  playerDamage: (amount, from) => hurt(amount, from),
  // урон спутнику квеста: здоровье и падение — в лагере, кровь — здесь (пул impacts)
  friendDamage: (f, amount, from) => {
    if (!world.camp.damage(f, amount)) return;
    const dx = f.x - (from ? from.x : f.x);
    const dz = f.z - (from ? from.z : f.z);
    const len = Math.hypot(dx, dz) || 1;
    impacts.spawnBlood(tmpHit.set(f.x, f.y + 1.0, f.z), tmpFlat.set(dx / len, 0, dz / len));
  },
  muzzle: (pos, dir) => {
    impacts.spawn(npcMuzzlePos.set(pos.x, pos.y, pos.z), npcMuzzleDir.set(dir.x, dir.y, dir.z));
    impacts.flash(npcMuzzlePos); // ярко: сразу видно, откуда стреляют
  },
  // след пули: до игрока при попадании или мимо него при промахе
  tracer: (from, to) => impacts.tracer(npcMuzzlePos.set(from.x, from.y, from.z), npcTraceTo.set(to.x, to.y, to.z)),
};

// Кик камеры при выстреле/ударе: добавляем смещение питча, потом компенсируем его же
// при затухании, чтобы суммарно камера не «уехала».
let pitchKick = 0;
let appliedKick = 0;

// Попадание по игроку: красный фильтр (ярче, чем ниже здоровье) и качение камеры —
// рывок уводит взгляд в сторону, противоположную удару.
let dmgT = 0;
let dmgAlpha = 0;
let hurtPitch = 0;
let hurtYaw = 0;
let hurtRoll = 0;
let hurtPitchA = 0;
let hurtYawA = 0;
let hurtRollA = 0;

// Авария: тряска камеры и крен «лёжа». Крен ведём отдельным компенсированным
// каналом по образцу hurtRoll — иначе камера навсегда уедет на бок.
let shakeT = 0;
let shakeAmp = 0;
let lieRollA = 0;

// Игрок сбит: лежит после аварии или встаёт. В этом состоянии ни сесть на
// мотоцикл, ни позвать друга, ни выстрелить.
const isDown = () => player.downT > 0 || player.getUpT > 0;

// Таран на большой скорости: обоих выбивает из седла. Вызывается сразу после
// bike.update и до camp.update — иначе пассажир «слезет» штатно, а не вылетит.
function crashOut(ev) {
  const b = world.bike;
  const c = CONFIG.bike.crash;
  const fx = Math.sin(b.yaw);
  const fz = Math.cos(b.yaw);
  const rx = -fz; // правый бок мотоцикла: r = (−cos, sin)
  const rz = fx;
  b.ejectRider();
  // старт броска — чуть выше корпуса: иначе мотоцикл вытолкнет тело из своей же коробки
  player.pos.set(b.pos.x, b.collider.maxY + 0.05, b.pos.z);
  player.throwOut(
    fx * ev.speed * c.ejectFwd + rx * c.ejectSide,
    c.ejectUp,
    fz * ev.speed * c.ejectFwd + rz * c.ejectSide,
  );
  player.syncCamera();
  world.camp.ejectPassenger(b, fx, fz, ev.speed, -c.ejectSide); // пассажир летит в другую сторону
  if (c.damage > 0) hurt(c.damage);
  shakeT = c.shakeTime;
  shakeAmp = c.shakeAmp;
  hurtPitch += (Math.random() * 2 - 1) * c.shakeAmp;
  hurtYaw += (Math.random() * 2 - 1) * c.shakeAmp;
  hurtRoll += (Math.random() * 2 - 1) * c.shakeAmp * 2;
}

function hurt(amount, from) {
  // смертельный урон в седле: сначала слезаем, потом игрок падает на спавне
  if (world.bike.mounted && player.hp - amount <= 0) world.bike.dismount();
  player.damage(amount);
  const h = CONFIG.player.hurt;
  dmgT = h.time;
  dmgAlpha = h.redMin + (h.redMax - h.redMin) * (1 - player.hp / player.maxHp);
  if (!from) return;
  camera.getWorldDirection(tmpDir);
  const k = hurtKick(from.x, from.z, player.pos.x, player.pos.z, tmpDir.x, tmpDir.z, h);
  hurtPitch += k.pitch;
  hurtYaw += k.yaw;
  hurtRoll += k.roll;
}

const tmpDir = new THREE.Vector3();
const tmpFlat = new THREE.Vector3();
const tmpHit = new THREE.Vector3(); // точка кровяных брызг при ударе палкой
const raycaster = new THREE.Raycaster();
raycaster.far = CONFIG.pistol.range;
const PISTOL_HIT = { damage: CONFIG.pistol.damage, headDamage: CONFIG.pistol.headDamage, knockback: CONFIG.pistol.knockback }; // импульс NPC от пули: в голову — хэдшот

// Удар палкой: сфера по лучу взгляда — деревья качаются, NPC получает урон и злится.
function stickHit() {
  camera.getWorldDirection(tmpDir);
  const cx = camera.position.x + tmpDir.x * CONFIG.stick.reach;
  const cy = camera.position.y + tmpDir.y * CONFIG.stick.reach;
  const cz = camera.position.z + tmpDir.z * CONFIG.stick.reach;

  // горизонтальное направление удара — общее для NPC, мешков и баков
  tmpFlat.set(tmpDir.x, 0, tmpDir.z);
  if (tmpFlat.lengthSq() < 1e-6) tmpFlat.set(0, 0, -1);
  tmpFlat.normalize();

  const treeIndex = world.trees.findNearest(cx, cy, cz, CONFIG.stick.hitRadius);
  if (treeIndex >= 0) world.trees.hit(treeIndex);
  const bushIndex = world.bushes.findNearest(cx, cy, cz, CONFIG.stick.hitRadius);
  if (bushIndex >= 0) world.bushes.hit(bushIndex);

  // NPC: палка бьёт больно — прилетело, значит, знает откуда
  for (let i = 0; i < world.npcs.units.length; i++) {
    const u = world.npcs.units[i];
    const dx = u.pos.x - cx;
    const dy = u.pos.y + 0.9 - cy;
    const dz = u.pos.z - cz;
    if (dx * dx + dy * dy + dz * dz < 1.35 * 1.35) {
      if (world.npcs.hit(i, tmpFlat, CONFIG.stick, camera.position)) {
        impacts.spawnBlood(tmpHit.set(u.pos.x, u.pos.y + 0.95, u.pos.z), tmpFlat);
        showHitmark();
      }
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
// урон NPC, покачивание дереву.
function shoot() {
  camera.getWorldDirection(tmpDir);
  raycaster.set(camera.position, tmpDir);
  const hits = raycaster.intersectObjects(
    [world.terrain, world.pavement.group, world.buildings.group,
     world.trees.trunks, world.trees.crowns, world.rocks.mesh, world.bushes.mesh,
     world.bins.mesh, world.signs.group, world.bags.mesh, world.camp.group, world.bike.group, ...world.npcs.parts],
    true,
  );
  // свист пули рядом с NPC поднимает группу: идут искать место выстрела
  world.npcs.alertShot(camera.position, tmpDir, hits.length ? hits[0].distance : CONFIG.pistol.range);
  // выстрел гремит: вся округа в радиусе noiseRadius идёт к месту выстрела.
  // Палка не шумит — тихий путь существует, это стелс.
  world.npcs.alertNoise(camera.position, CONFIG.pistol.noiseRadius);
  if (hits.length === 0) return;
  const hit = hits[0];

  // горизонтальное направление выстрела — общее для NPC, мешков и баков
  tmpFlat.set(tmpDir.x, 0, tmpDir.z);
  if (tmpFlat.lengthSq() < 1e-6) tmpFlat.set(0, 0, -1);
  tmpFlat.normalize();

  let flesh = false; // попадание по живой цели: кровь и X-маркер — есть отдача от попадания
  if (hit.object.userData.npc && hit.instanceId !== undefined) {
    world.npcs.hit(hit.instanceId, tmpFlat, PISTOL_HIT, camera.position, hit.point); // hit.point — зона: голова или тело
    flesh = true;
  } else if ((hit.object === world.trees.trunks || hit.object === world.trees.crowns) && hit.instanceId !== undefined) {
    world.trees.hit(hit.instanceId);
  } else if (hit.object === world.bushes.mesh && hit.instanceId !== undefined) {
    world.bushes.hit(hit.instanceId);
  } else if (hit.object === world.bags.mesh && hit.instanceId !== undefined) {
    world.bags.hit(hit.instanceId, tmpFlat, CONFIG.street.bagImpulse);
  } else if (hit.object === world.bins.mesh && hit.instanceId !== undefined) {
    world.bins.hit(hit.instanceId, tmpFlat, CONFIG.street.binImpulse);
  }

  if (flesh) {
    impacts.spawnBlood(hit.point, tmpDir); // кровь: попадание читается сразу
    showHitmark();
  } else {
    impacts.spawn(hit.point, tmpDir); // искры о мир: стена, камень, дерево
  }
  pitchKick = CONFIG.pistol.pitchKick;
}

// Посадка: игрок садится в седло — дальше его везёт мотоцикл
function mountBike() {
  world.bike.mount();
  player.pos.set(world.bike.pos.x, world.bike.pos.y, world.bike.pos.z);
  player.syncCamera();
  updatePrompt();
}

// Высадка: слезаем сбоку от мотоцикла; там тесно (стена) — слева
function dismountBike() {
  const b = world.bike;
  b.dismount();
  const rx = -Math.cos(b.yaw); // правый бок мотоцикла: r = (−cos, sin)
  const rz = Math.sin(b.yaw);
  let sx = b.pos.x + rx * 1.1;
  let sz = b.pos.z + rz * 1.1;
  let res = resolveCircleAabb(sx, sz, CONFIG.player.radius, b.pos.y, CONFIG.player.standHeight, world.colliders);
  if (res.hit) { // справа тесно — слезаем слева
    sx = b.pos.x - rx * 1.1;
    sz = b.pos.z - rz * 1.1;
    res = resolveCircleAabb(sx, sz, CONFIG.player.radius, b.pos.y, CONFIG.player.standHeight, world.colliders);
  }
  player.pos.set(res.x, b.pos.y, res.z);
  player.pos.y = world.heightmap.heightAt(res.x, res.z);
  player.vel.set(0, 0, 0);
  player.syncCamera();
  updatePrompt();
}

// Подсказка взаимодействия: прицел на дружелюбном рядом — «E»; в седле —
// всегда «сойти»; прицел на мотоцикле в пределах посадки — «сесть».
// Дружелюбный: раз нажал — друг идёт за игроком; ещё раз — «жди здесь».
function updatePrompt() {
  interactFriend = null;
  interactBike = false;
  if (quest.talking) { // открыт диалог — никаких подсказок взаимодействия
    promptEl.classList.remove('on');
    return;
  }
  if (isDown()) { // лежит — никакого взаимодействия
    promptEl.classList.remove('on');
    return;
  }
  if (world.bike.mounted) {
    promptEl.textContent = '[E] — сойти с мотоцикла · L — свет';
    promptEl.classList.add('on');
    return;
  }
  if (controls.isLocked) {
    camera.getWorldDirection(tmpDir);
    raycaster.set(camera.position, tmpDir);
    const hits = raycaster.intersectObjects(
      [world.camp.standBody, world.camp.standShell, world.camp.head, world.camp.headShell, world.camp.faces],
      false,
    );
    if (hits.length && hits[0].distance <= CONFIG.camp.interactRange) {
      const f = world.camp.friendOf(hits[0].object, hits[0].instanceId);
      // стоячий — зовём за собой; друг в палатке (сидит) — говорим, пока квест не взят
      if (f && (!f.sit || quest.canTalkTo(f))) interactFriend = f;
    }
    if (!interactFriend) {
      const bh = raycaster.intersectObject(world.bike.group, true);
      if (bh.length && bh[0].distance <= CONFIG.bike.mountRange) interactBike = true;
    }
  }
  if (interactFriend) {
    promptEl.textContent = quest.canTalkTo(interactFriend) ? '[E] — поговорить'
      : interactFriend.mode === 'follow' ? '[E] — подожди здесь' : '[E] — взаимодействовать';
    promptEl.classList.add('on');
  } else if (interactBike) {
    promptEl.textContent = '[E] — сесть на мотоцикл';
    promptEl.classList.add('on');
  } else {
    promptEl.classList.remove('on');
  }
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

function step(dt) {
  const talking = quest.talking; // диалог: движение и стрельба заморожены
  const riding = world.bike.mounted && !talking;
  if (talking) {
    player.hSpeed = 0; // стоим на месте, камеру можно вращать мышью
  } else if (riding) {
    // в седле игрок не ходит сам: его везёт мотоцикл, глаза — на высоте райдера
    player.pos.set(world.bike.pos.x, world.bike.pos.y, world.bike.pos.z);
    player.vel.set(0, 0, 0);
    player.crouching = false;
    player.eye += (1.35 - player.eye) * Math.min(1, dt * 10);
    player.hSpeed = Math.abs(world.bike.speed);
    player.state = 'мотоцикл · передача ' + (world.bike.gear + 1);
    player.syncCamera();
  } else {
    player.update(dt, input);
  }
  world.bike.update(dt, riding ? input : null);
  // удар на ходу: выбивает из седла до того, как лагерь успеет «высадить» пассажира
  const ev = world.bike.crashEvent;
  if (riding && ev && ev.eject) crashOut(ev);
  // присед игрока урезает дальность обнаружения — стелс; спутники квеста тоже цели
  world.npcs.update(dt, player.pos, npcHooks, { crouch: player.crouching, friends: world.camp.friends });
  world.camp.update(dt, player.pos, world.bike); // дружелюбные следят за игроком и подсаживаются пассажиром
  world.bins.update(dt);
  pushBagsByBins(world.bags, world.bins, CONFIG.street.bagPush); // проехал ли бак по мешку
  world.bags.update(dt);
  quest.update(dt, player.pos); // субтитр у палатки и переходы escort → done | failed

  for (const code of input.consumePressed()) {
    if (code === 'KeyV') {
      render.cycleResolution();
    } else if (code === 'F3') {
      hud.toggle();
      world.npcs.setDebug(hud.visible); // зоны зрения NPC — отладочный слой HUD
    } else if (code === 'KeyE' && !isDown()) {
      // E: в диалоге — дальше; в седле — сойти; друг в палатке — заговорить;
      // иначе standing-друг (позвать/ждать) или мотоцикл
      if (quest.talking) quest.advance();
      else if (world.bike.mounted) dismountBike();
      else if (interactFriend && quest.canTalkTo(interactFriend)) quest.openDialogue();
      else if (interactFriend && world.camp.interact(interactFriend)) updatePrompt();
      else if (interactBike) mountBike();
    } else if (code === 'KeyL' && !isDown()) {
      // L: фара мотоцикла по кругу — выкл → ближний → дальний (в седле или рядом)
      if (world.bike.mounted || interactBike) world.bike.toggleLight();
    } else if (code === 'KeyR') {
      world.npcs.resetAll();
      world.bins.resetAll();
      world.bags.resetAll();
      world.bike.reset();
      world.camp.resetFriends(); // друзья живы и на местах
      quest.reset();             // квест можно пройти заново
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

  if (input.consumeAttack() && !world.bike.mounted && !isDown() && !quest.talking) viewmodel.startPrimary(); // в седле и в диалоге руки заняты
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, clock.getDelta());

  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 8) { step(STEP); acc -= STEP; guard++; }
  if (guard === 8) acc = 0; // не копим долг физики, если вкладка лагала

  // ПКМ: пистолет — прицел, палка — зум-бинокль (осмотреться). Обзор поджимается,
  // вьюмодель ведёт себя сама и читает view.aim
  const aimCfg = viewmodel.currentId === 'pistol' ? CONFIG.pistol
    : viewmodel.currentId === 'stick' ? CONFIG.stick : null;
  const aiming = !!(input.rmb && controls.isLocked && aimCfg && viewmodel.pendingId === null &&
    !world.bike.mounted && !isDown());
  const fovTarget = aiming ? aimCfg.aimFov : CONFIG.camera.fov;
  if (camera.fov !== fovTarget) {
    const aimSpeed = aimCfg ? aimCfg.aimSpeed : CONFIG.pistol.aimSpeed;
    camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-aimSpeed * dt));
    if (Math.abs(camera.fov - fovTarget) < 0.02) camera.fov = fovTarget;
    camera.updateProjectionMatrix();
  }

  // визуальный слой — по реальному времени кадра
  viewmodel.update(dt, { speed: player.hSpeed, onGround: player.onGround, aim: aiming });
  impacts.update(dt);
  const swaying = world.trees.update(dt) + world.bushes.update(dt);

  pitchKick *= Math.exp(-10 * dt);
  if (pitchKick < 1e-5) pitchKick = 0;
  camera.rotation.x += pitchKick - appliedKick;
  appliedKick = pitchKick;

  // тряска после аварии: случайные рывки, затухают вместе с каналами hurt
  if (shakeT > 0) {
    shakeT = Math.max(0, shakeT - dt);
    const a = shakeAmp * (shakeT / CONFIG.bike.crash.shakeTime);
    hurtPitch += (Math.random() * 2 - 1) * a;
    hurtYaw += (Math.random() * 2 - 1) * a;
    hurtRoll += (Math.random() * 2 - 1) * a;
  }

  // качение от полученных ударов: затухает за hurt.time
  const hurtK = Math.exp(-CONFIG.player.hurt.decay * dt);
  hurtPitch *= hurtK;
  hurtYaw *= hurtK;
  hurtRoll *= hurtK;
  if (Math.abs(hurtPitch) < 1e-5) hurtPitch = 0;
  if (Math.abs(hurtYaw) < 1e-5) hurtYaw = 0;
  if (Math.abs(hurtRoll) < 1e-5) hurtRoll = 0;
  camera.rotation.x += hurtPitch - hurtPitchA;
  camera.rotation.y += hurtYaw - hurtYawA;
  camera.rotation.z += hurtRoll - hurtRollA;
  hurtPitchA = hurtPitch;
  hurtYawA = hurtYaw;
  hurtRollA = hurtRoll;

  // крен лёжа: камера заваливается на бок вместе с телом и возвращается ровно,
  // когда игрок встал. Канал компенсированный — суммарно камера никуда не уезжает.
  const lieRoll = player.lie * CONFIG.player.down.roll;
  camera.rotation.z += lieRoll - lieRollA;
  lieRollA = lieRoll;

  // красный фильтр урона: гаснет за hurt.time, плотнее при низком hp
  if (dmgT > 0) {
    dmgT = Math.max(0, dmgT - dt);
    damageEl.style.opacity = (dmgAlpha * (dmgT / CONFIG.player.hurt.time)).toFixed(3);
  } else if (damageEl.style.opacity !== '0') {
    damageEl.style.opacity = '0';
  }

  // X-маркер попадания: вспыхивает в центре и быстро гаснет
  if (hitmarkT > 0) {
    hitmarkT = Math.max(0, hitmarkT - dt);
    const k = hitmarkT / CONFIG.hud.hitMarkTime;
    hitmarkEl.style.opacity = k.toFixed(2);
    hitmarkEl.style.transform = `scale(${(1.6 - 0.6 * k).toFixed(2)})`;
  } else if (hitmarkEl.style.opacity !== '0') {
    hitmarkEl.style.opacity = '0';
  }

  updatePrompt(); // подсказка «E»: прицел на дружелюбном в пределах дистанции

  // квест: маркер «!» над целью, плашка диалога, субтитр и строка цели с компасом
  const mp = quest.markerPos;
  markers.update(mp, dt);
  if (quest.talking) {
    questUI.showDialogue(quest.currentLine(), quest.line >= quest.lines.length - 1);
  } else {
    questUI.hideDialogue();
  }
  questUI.setSubtitle(quest.subtitle);
  const objText = quest.objective;
  if (objText && mp) {
    camera.getWorldDirection(tmpDir);
    const toX = mp.x - camera.position.x;
    const toZ = mp.z - camera.position.z;
    questUI.setObjective(objText, QuestUI.arrowFor(tmpDir.x, tmpDir.z, toX, toZ), Math.hypot(toX, toZ));
  } else {
    questUI.setObjective(objText, '', null);
  }

  const size = render.size;
  hud.update(dt, {
    pos: player.pos,
    speed: player.hSpeed,
    state: player.state,
    res: `${size.x}x${size.y}`,
    seed,
    item: viewmodel.current ? viewmodel.current.label : '—',
    slot: viewmodel.currentId ? CONFIG.hands.slots.indexOf(viewmodel.currentId) + 1 : 0,
    npcs: world.npcs.aliveCount,
    alert: world.npcs.alertCount,
    hp: player.hp,
    bins: world.bins.awakeCount,
    bags: world.bags.awakeCount,
    swaying,
    sparks: impacts.activeCount,
    quest: quest.stage,
  });

  viewmodel.render(renderer, scene, camera, render.aspect, !world.bike.mounted && !isDown()); // в седле и лёжа руки не видны
}

frame();
