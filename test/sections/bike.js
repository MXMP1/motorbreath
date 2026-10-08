// I. Мотоцикл: стоянка, коробка, фара, руль, таран. J. Пассажир и авария вдвоём.
import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { Motorcycle } from '../../src/world/bike.js';
import { Camp } from '../../src/world/camp.js';
import { Player } from '../../src/player/player.js';
import { resolveCircleAabb } from '../../src/core/collide.js';
import { check } from '../harness.js';

const RAM_WALL = { minX: -20, maxX: 20, minZ: -180, maxZ: -168, minY: -10, maxY: 30 };
const GAS = { forward: true, back: false, left: false, right: false };
const IDLE = { forward: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false };

// То же, что делает main.js в crashOut: выбить из седла водителя и пассажира.
function crashOut(bike, camp, rider, ev) {
  const c = CONFIG.bike.crash;
  const fx = Math.sin(bike.yaw);
  const fz = Math.cos(bike.yaw);
  bike.ejectRider();
  rider.pos.set(bike.pos.x, bike.collider.maxY + 0.05, bike.pos.z);
  rider.throwOut(fx * ev.speed * c.ejectFwd + -fz * c.ejectSide, c.ejectUp,
    fz * ev.speed * c.ejectFwd + fx * c.ejectSide);
  const mate = camp.ejectPassenger(bike, fx, fz, ev.speed, -c.ejectSide);
  camp.update(1 / 60, rider.pos, bike); // один кадр: матрицы тел переходят в позу «лежит»
  return mate;
}

export function bikeSection(ctx) {
  const { cfg, hm, camp } = ctx;

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

  const gas = GAS;
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

  const wallBox = RAM_WALL;
  const ramWorld = { heightmap: hm, colliders: [wallBox], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null };
  const ram = new Motorcycle(CONFIG, ramWorld);
  ram.mount();
  let ev = null;
  let ramTicks = 0;
  while (!ev && ramTicks < 600) { ram.update(1 / 60, gas); ev = ram.crashEvent; ramTicks++; }
  check('стена поперёк дороги: мотоцикл до неё доехал и ударился',
    !!ev && Math.abs(ram.pos.z - (-180 - CONFIG.bike.radius)) < 1e-6, `t=${(ramTicks / 60).toFixed(2)}с z=${ram.pos.z.toFixed(2)}`);
  check('нормаль удара смотрит от стены назад', Math.abs(ev.nx) < 1e-9 && ev.nz < -0.99,
    `n=(${ev.nx.toFixed(2)}, ${ev.nz.toFixed(2)})`);
  check('таран на четвёртой передаче: удар почти на пределе скорости',
    ram.gear === 3 && ev.impact > CONFIG.bike.crash.ejectSpeed && ev.speed === ev.impact,
    `g=${ram.gear} impact=${ev.impact.toFixed(1)}`);
  check('скорость сменила знак — мотоцикл отскочил от стены', ram.speed < 0, `v=${ram.speed.toFixed(2)}`);
  check('отскок остался перед стеной, а не прошёл сквозь неё',
    ram.pos.z <= -180 - CONFIG.bike.radius + 1e-6, `z=${ram.pos.z.toFixed(2)}`);
  check('удар на такой скорости выбивает из седла', ev.eject === true);
  check('после удара мотоцикл трясёт', ram._wobT > 0 && ram._wobAmp > 0 && ram._wobAmp <= CONFIG.bike.crash.wobbleLean);

  // лёгкое касание: нормальной скорости мало — просто теряем ход, без отскока и вылета
  const tapWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null };
  const tap = new Motorcycle(CONFIG, tapWorld);
  tap.mount();
  tap.speed = CONFIG.bike.crash.minImpact - 0.4;
  const tapSpeed = tap.speed;
  const tapEv = tap._crash(tap.pos.x, tap.pos.z, { x: tap.pos.x, z: tap.pos.z - 0.1 });
  check('лёгкое касание не выбивает из седла и не роняет на бок',
    tapEv.eject === false && tapEv.impact <= CONFIG.bike.crash.minImpact &&
    tap.mounted === true && tap.speed > 0 && tap.speed < tapSpeed && tap._wobT === 0,
    `impact=${tapEv.impact.toFixed(2)} v=${tap.speed.toFixed(2)}`);

  // после аварии мотоцикл без водителя: ход сохраняется, откатывается и гаснет сам
  ram.ejectRider();
  check('ejectRider (в отличие от dismount) сохраняет ход',
    !ram.mounted && ram.gear === 0 && ram.speed < 0);
  for (let i = 0; i < 240; i++) ram.update(1 / 60, null);
  check('без водителя мотоцикл откатился от стены и встал',
    ram.speed === 0 && ram.pos.z < -180 - CONFIG.bike.radius && ram._wobT === 0,
    `z=${ram.pos.z.toFixed(2)} v=${ram.speed}`);
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
  // Слот тела читаем прямо из instanceMatrix: у three r186 decompose() на вырожденной
  // матрице возвращает масштаб (1,1,1), поэтому «погашен» ли слот — видно только по
  // нулевой матрице, увезённой под мир (y = −50). Координаты — float32, допуск 1e-3.
  const slot = (mesh, i) => {
    const a = mesh.instanceMatrix.array;
    const o = i * 16;
    return {
      blank: a[o + 13] === -50 && a[o] === 0 && a[o + 5] === 0 && a[o + 10] === 0,
      x: a[o + 12], y: a[o + 13], z: a[o + 14],
    };
  };
  const atFriend = (s, f, dy = 0) => !s.blank &&
    Math.abs(s.x - f.x) < 1e-3 && Math.abs(s.y - (f.y + dy)) < 1e-3 && Math.abs(s.z - f.z) < 1e-3;
  for (let i = 0; i < 120; i++) passCamp.update(1 / 60, passPlayer); // без игрока в седле мотоцикл не едет
  check('без игрока в седле спутник идёт пешком', companion.ride === false && companion.mode === 'follow');
  check('пеший спутник: тело на земле, поза седла погашена',
    atFriend(slot(passCamp.standBody, companion.standSlot), companion) &&
    slot(passCamp.rideBody, companion.rideSlot).blank);
  passBike.mount();
  for (let i = 0; i < 120; i++) passCamp.update(1 / 60, passPlayer, passBike);
  check('игрок сел — спутник садится пассажиром', companion.ride === true);
  check('у пассажира тело в седле, а на месте посадки ничего не осталось',
    slot(passCamp.standBody, companion.standSlot).blank &&
    slot(passCamp.standShell, companion.standSlot).blank &&
    atFriend(slot(passCamp.rideBody, companion.rideSlot), companion),
    `y=${slot(passCamp.rideBody, companion.rideSlot).y.toFixed(2)}`);
  check('пассажир сидит в седле за спиной игрока',
    Math.abs(companion.x - (passBike.pos.x + Math.sin(passBike.yaw) * -0.42)) < 1e-9 &&
    Math.abs(companion.z - (passBike.pos.z + Math.cos(passBike.yaw) * -0.42)) < 1e-9 &&
    Math.abs(companion.y - (passBike.pos.y + 0.87)) < 1e-9 &&
    Math.abs(companion.yaw - passBike.yaw) < 1e-9);
  check('голова пассажира в седле, а не на земле',
    atFriend(slot(passCamp.head, 3), companion, 0.87),
    `y=${slot(passCamp.head, 3).y.toFixed(2)}`);
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
  check('после высадки тело снова на земле, поза седла погашена',
    slot(passCamp.rideBody, companion.rideSlot).blank &&
    atFriend(slot(passCamp.standBody, companion.standSlot), companion));

  // ---------- авария вдвоём: таран на скорости выбивает из седла обоих ----------
  const crashWorld = { heightmap: hm, colliders: [RAM_WALL], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null };
  const crashBike = new Motorcycle(CONFIG, crashWorld);
  const crashCamp = new Camp(CONFIG, { heightmap: hm, cityLift: null });
  const crashCam = new THREE.PerspectiveCamera(74, 1, 0.1, 400);
  crashCam.rotation.order = 'YXZ';
  const rider = new Player(crashCam, CONFIG, crashWorld);
  const mate = crashCamp.friends[3]; // тот же стоящий у вешалок
  crashCamp.interact(mate);
  crashBike.mount();
  rider.pos.set(crashBike.pos.x, crashBike.pos.y, crashBike.pos.z); // «игрок» в седле у стоянки
  for (let i = 0; i < 240 && !mate.ride; i++) crashCamp.update(1 / 60, rider.pos, crashBike);
  check('перед аварией спутник едет пассажиром', mate.ride === true);

  let crashEv = null;
  for (let i = 0; i < 600 && !crashEv; i++) {
    crashBike.update(1 / 60, GAS);
    if (crashBike.crashEvent && crashBike.crashEvent.eject) {
      crashEv = crashBike.crashEvent;
      crashOut(crashBike, crashCamp, rider, crashEv); // то же, что делает main.js
      break;
    }
    crashCamp.update(1 / 60, rider.pos, crashBike);
  }
  check('таран на скорости: из седла вылетели оба',
    !!crashEv && crashBike.mounted === false && rider.downT > 0 && mate.downT > 0 && mate.ride === false,
    `impact=${crashEv ? crashEv.impact.toFixed(1) : '—'}`);
  check('водитель и пассажир разлетелись в разные стороны',
    Math.abs(rider.vel.x + CONFIG.bike.crash.ejectSide) < 1e-9 &&
    Math.abs(mate.vx - CONFIG.bike.crash.ejectSide) < 1e-9 &&
    rider.vel.z > 4 && mate.vz > 4,
    `rider=(${rider.vel.x.toFixed(2)}, ${rider.vel.z.toFixed(2)}) mate=(${mate.vx.toFixed(2)}, ${mate.vz.toFixed(2)})`);
  check('у сбитого пассажира тело лежит, а не стоит',
    mate.fall === 1 && slot(crashCamp.rideBody, mate.rideSlot).blank &&
    !slot(crashCamp.standBody, mate.standSlot).blank);
  check('голова сбитого на земле, а не на высоте стоячего',
    slot(crashCamp.head, 3).y < mate.y + 0.5, `y=${slot(crashCamp.head, 3).y.toFixed(2)} feet=${mate.y.toFixed(2)}`);
  check('сбитый не откликается на E', crashCamp.friendOf(crashCamp.standBody, mate.standSlot) === null &&
    crashCamp.interact(mate) === false);

  // лежат down.time, встают getUp — и снова на ногах
  const settle = Math.ceil((CONFIG.player.down.time + CONFIG.player.down.getUp) * 60) + 10;
  for (let i = 0; i < settle; i++) {
    rider.update(1 / 60, IDLE);
    crashBike.update(1 / 60, null);
    crashCamp.update(1 / 60, rider.pos, crashBike);
  }
  check('оба полежали и встали',
    rider.downT === 0 && rider.getUpT === 0 && rider.lie === 0 && rider.state === 'стоя' &&
    mate.downT === 0 && mate.getUpT === 0 && mate.fall === 0,
    `rider=${rider.state} mate.fall=${mate.fall}`);
  check('вставший спутник снова стоит на земле, голова на высоте',
    Math.abs(mate.y - hm.heightAt(mate.x, mate.z)) < 1e-6 &&
    Math.abs(slot(crashCamp.head, 3).y - (mate.y + 1.66)) < 1e-3,
    `headY=${slot(crashCamp.head, 3).y.toFixed(2)} feet=${mate.y.toFixed(2)}`);
  check('после подъёма спутник снова откликается на E',
    crashCamp.friendOf(crashCamp.standBody, mate.standSlot) === mate);
  check('водитель встал там же, где упал, — на земле',
    rider.onGround && Math.abs(rider.pos.y - hm.heightAt(rider.pos.x, rider.pos.z)) < 0.02,
    `y=${rider.pos.y.toFixed(2)}`);
}
