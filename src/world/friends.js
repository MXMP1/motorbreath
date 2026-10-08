import * as THREE from 'three';
import { mergeGeometries } from '../core/merge.js';
import { resolveCircleAabb } from '../core/collide.js';
import { SHELL, makeBodyGeometry } from './npc-geo.js';

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const HEAD_STAND = 1.66; // центр головы стоящего — как у городских NPC
const HEAD_SIT = 1.18;   // голова сидящего на земле
const HEAD_TURN = 2.2;   // насколько голова отворачивается от тела, рад
const TURN_RATE = 8;     // скорость доворота корпуса спутника, рад/с
const RIDE_SEAT = 0.87;  // седло пассажира: высота над землёй (сидит за спиной водителя)
const RIDE_Z = -0.42;    // пассажир сидит позади оси мотоцикла (локальный −z)
const HEAD_RIDE = 0.87;  // центр головы пассажира над его седлом

// Дружелюбные лагеря: двое у костра и один у палатки сидят, один стоит у вешалок,
// один за столом в палатке и один — в центре города. Когда игрок подходит ближе
// lookRange, их головы поворачиваются за ним. Стоящего можно позвать за собой (E),
// а спутник в режиме follow подсаживается пассажиром, когда игрок заводит мотоцикл.
//
// Тела — статичные instanced-меши по позам (сидит / стоит / едет), головы — свои
// матрицы. Слоты у каждого друга ПОСТОЯННЫЕ: иначе при посадке пассажира чужие
// слоты съезжают, а освободившийся остаётся с прошлой матрицей (тело без головы).
export class Friends {
  constructor(cfg, world, group, places) {
    this.cfg = cfg.camp;
    this.palette = cfg.palette;
    this.down = cfg.player.down;     // тайминги «полежать и встать» — как у игрока
    this.crash = cfg.bike.crash;     // импульс вылета из седла
    this.gravity = cfg.player.gravity;
    this.friendHp = cfg.quest.friendHp; // здоровье друга: враждебные бьют и спутника
    this.world = world;   // нужна карта высот и коллайдеры: спутник ходит по миру
    this.group = group;   // меши живут в группе лагеря (тени и общий dispose)
    this.places = places; // { tent, fire, city } — где рассаживать
    this.list = [];

    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'XYZ'); // крен пассажира: поза с наклоном
    this._eF = new THREE.Euler(0, 0, 0, 'YXZ'); // сбитый: Ry(курс)·Rx(падение)
    this._p = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._sZero = new THREE.Vector3(0, 0, 0); // нулевой масштаб: погасить неактивный слот

    this._build();
  }

  _groundAt(x, z) {
    const lift = this.world.cityLift ? this.world.cityLift(x, z) : 0; // горожанин — на покрытии
    return this.world.heightmap.heightAt(x, z) + lift;
  }

  _build() {
    const c = this.cfg;
    const { tent, fire, city } = this.places;
    const list = [
      { x: c.x + 3.2, z: c.z - 3.8, sit: true },           // у входа в палатку
      { x: c.x - 3.3, z: c.z + 1.1, sit: true },           // у костра слева
      { x: c.x - 0.6, z: c.z + 3.3, sit: true },           // у костра справа
      { x: c.x + 3.8, z: c.z + 4.7, sit: false },          // у вешалок
      { x: tent.x, z: tent.z - 1.35, sit: true, yaw: 0 }, // в палатке за столом, лицом к входу
      { x: city.cx, z: city.cz, sit: false, yaw: Math.PI / 2 }, // в центре города: элемент задания
    ];
    let sitSlot = 0;
    let standSlot = 0;
    for (const f of list) {
      f.y = this._groundAt(f.x, f.z);
      if (f.yaw === undefined) f.yaw = Math.atan2(fire.x - f.x, fire.z - f.z); // в покое смотрят на костёр
      f.headYaw = 0; // доворот головы к игроку поверх поворота тела
      f.headY = f.sit ? HEAD_SIT : HEAD_STAND;
      f.mode = 'stay'; // 'stay' | 'follow': стоящих игрок зовёт за собой клавишей E
      f.ride = false;  // сел пассажиром на мотоцикл (только follow рядом с седлом)
      f.lean = 0;      // крен в поворотах — как у мотоцикла, пока едет пассажиром
      f.downT = 0;     // лежит после аварии, с
      f.getUpT = 0;    // встаёт, с
      f.fall = 0;      // 0 — на ногах, 1 — лежит навзничь
      f.hp = this.friendHp; // здоровье: спутника квеста враждебные могут завалить
      f.dead = false;  // погиб — остаётся лежать навсегда (f.fall = 1)
      f.vx = 0; f.vy = 0; f.vz = 0; // скорость сбитого тела
      // исходная точка и курс — вернуть на место при сбросе (R)
      f.hx = f.x; f.hz = f.z; f.hy = f.y; f.hyaw = f.yaw;
      // постоянный слот в своём меша: поза сидящего и стоящего не пересекаются,
      // а пассажир едет в слоте своего стоячего тела
      if (f.sit) { f.sitSlot = sitSlot++; f.standSlot = -1; }
      else { f.standSlot = standSlot++; f.sitSlot = -1; }
      f.rideSlot = f.standSlot;
    }
    this.list = list;

    const nSit = sitSlot;
    const nStand = standSlot;
    const bodyMat = new THREE.MeshLambertMaterial({ color: this.palette.friendBody, flatShading: true });
    const headMat = new THREE.MeshLambertMaterial({ color: this.palette.npcHead, flatShading: true });
    const shellMat = new THREE.MeshBasicMaterial({ color: this.palette.npcOutline, side: THREE.BackSide });

    this.sitBody = new THREE.InstancedMesh(makeSitGeometry(), bodyMat, nSit);
    this.sitShell = new THREE.InstancedMesh(makeSitGeometry(SHELL), shellMat, nSit);
    this.standBody = new THREE.InstancedMesh(makeBodyGeometry(), bodyMat, nStand);
    this.standShell = new THREE.InstancedMesh(makeBodyGeometry(SHELL), shellMat, nStand);
    // пассажирская поза: спутник в седле мотоцикла — слотов по числу стоящих
    this.rideBody = new THREE.InstancedMesh(makeRideGeometry(), bodyMat, nStand);
    this.rideShell = new THREE.InstancedMesh(makeRideGeometry(SHELL), shellMat, nStand);
    this.head = new THREE.InstancedMesh(makeFriendHead(), headMat, list.length);
    this.headShell = new THREE.InstancedMesh(makeFriendHead(SHELL), shellMat, list.length);
    // «лицо»: тёмная полоса глаз на передней грани головы — видно, куда друг смотрит
    this.faces = new THREE.InstancedMesh(makeFriendFace(), new THREE.MeshBasicMaterial({ color: this.palette.npcOutline }), list.length);
    this.head.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.headShell.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.faces.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.parts = [this.sitBody, this.sitShell, this.standBody, this.standShell,
      this.rideBody, this.rideShell, this.head, this.headShell, this.faces];
    for (const m of this.parts) {
      m.frustumCulled = false; // инстансы разбросаны — автосфера отсечения врёт
      this.group.add(m);
    }

    this.syncBodies();
    this.syncHeads();
  }

  // Тела друзей: спутник (follow) ходит за игроком, пассажир едет в седле —
  // матрицы ставим каждый кадр. Слот у каждого свой, поэтому пишем ОБА меша
  // стоячего друга: активный — боевой матрицей, неактивный — нулевым масштабом.
  syncBodies() {
    for (const f of this.list) {
      if (f.sit) {
        this._poseStanding(f);
        this.sitBody.setMatrixAt(f.sitSlot, this._m);
        this.sitShell.setMatrixAt(f.sitSlot, this._m);
        continue;
      }
      if (f.ride) {
        // пассажир: сидит в седле, крен мотоцикла — наклоном тела (euler 0/yaw/lean)
        this._e.set(0, f.yaw, f.lean);
        this._q.setFromEuler(this._e);
        this._p.set(f.x, f.y, f.z);
        this._m.compose(this._p, this._q, ONE);
        this.rideBody.setMatrixAt(f.rideSlot, this._m);
        this.rideShell.setMatrixAt(f.rideSlot, this._m);
        this._blank(this.standBody, this.standShell, f.standSlot);
      } else {
        if (f.fall > 0) this._poseFallen(f);
        else this._poseStanding(f);
        this.standBody.setMatrixAt(f.standSlot, this._m);
        this.standShell.setMatrixAt(f.standSlot, this._m);
        this._blank(this.rideBody, this.rideShell, f.rideSlot);
      }
    }
    for (const m of [this.sitBody, this.sitShell, this.standBody, this.standShell,
      this.rideBody, this.rideShell]) m.instanceMatrix.needsUpdate = true;
  }

  // Поза стоящего/сидящего на земле: разворот вокруг вертикали, матрица в this._m.
  _poseStanding(f) {
    this._q.setFromAxisAngle(UP, f.yaw);
    this._p.set(f.x, f.y, f.z);
    this._m.compose(this._p, this._q, ONE);
  }

  // Поза сбитого: корпус заваливается на спину вокруг своей поперечной оси.
  // Порядок 'YXZ' даёт Ry·Rx — сначала разворот по курсу, потом падение.
  _poseFallen(f) {
    this._eF.set(-Math.PI / 2 * f.fall, f.yaw, 0);
    this._q.setFromEuler(this._eF);
    this._p.set(f.x, f.y, f.z);
    this._m.compose(this._p, this._q, ONE);
  }

  // Погасить слот: нулевой масштаб и увод за пределы мира.
  _blank(body, shell, slot) {
    if (slot < 0) return;
    this._m.compose(this._p.set(0, -50, 0), this._q.identity(), this._sZero);
    body.setMatrixAt(slot, this._m);
    shell.setMatrixAt(slot, this._m);
  }

  // E на стоящем друге: зовём за собой; повторный E на спутнике — «жди здесь»:
  // остаётся на месте, но корпус по-прежнему смотрит на игрока.
  interact(f) {
    if (!f || f.sit || f.dead || isDown(f)) return false;
    f.mode = f.mode === 'follow' ? 'stay' : 'follow';
    return true;
  }

  // Урон другу от враждебных NPC: здоровье, на нуле — заваливается навсегда.
  // Кровь рисует main.js (у него пул impacts), здесь только состояние тела.
  damage(f, amount) {
    if (!f || f.dead) return false;
    f.hp -= amount;
    if (f.hp <= 0) {
      f.hp = 0;
      f.dead = true;
      f.fall = 1;      // лёг и больше не встаёт
      f.mode = 'stay'; // мёртвый не идёт за игроком
      f.ride = false;
      f.downT = 0;
      f.getUpT = 0;
      f.vx = 0; f.vy = 0; f.vz = 0;
    }
    return true;
  }

  // Сброс (R): друзья снова живы, здоровы и на своих местах, режимы и позы — исходные.
  resetAll() {
    for (const f of this.list) {
      f.hp = this.friendHp;
      f.dead = false;
      f.fall = 0;
      f.downT = 0;
      f.getUpT = 0;
      f.mode = 'stay';
      f.ride = false;
      f.lean = 0;
      f.vx = 0; f.vy = 0; f.vz = 0;
      f.x = f.hx; f.z = f.hz; f.y = f.hy; f.yaw = f.hyaw;
      f.headYaw = 0;
    }
    this.syncBodies();
    this.syncHeads();
  }

  // Кого задел луч взгляда: голова — на любом друге, тело — только у стоящих.
  friendOf(object, instanceId) {
    if (instanceId === undefined) return null;
    let f = null;
    if (object === this.head || object === this.headShell || object === this.faces) {
      f = this.list[instanceId] || null;
    } else if (object === this.standBody || object === this.standShell) {
      for (const q of this.list) if (q.standSlot === instanceId) f = q;
    }
    return f && !f.dead && !isDown(f) ? f : null; // мёртвый и лежащий не откликаются на E
  }

  // Авария: пассажира выбило из седла вместе с водителем. side — в какую сторону
  // отбрасывать (main.js даёт знак противоположный игроку — разлетаются врозь).
  ejectPassenger(b, fx, fz, speed, side) {
    let who = null;
    for (const f of this.list) if (f.ride) who = f;
    if (!who) return null;
    who.ride = false;
    who.lean = 0;
    who.downT = this.down.time;
    who.getUpT = 0;
    who.fall = 1;
    // старт броска — чуть выше корпуса мотоцикла: иначе своё же железо вытолкнет
    // тело вбок из центра коробки (вырожденный случай resolveCircleAabb)
    who.y = b.collider.maxY + 0.05;
    who.vx = fx * speed * this.crash.ejectFwd + -fz * side;
    who.vz = fz * speed * this.crash.ejectFwd + fx * side;
    who.vy = this.crash.ejectUp;
    return who;
  }

  // Сбитые спутники: гравитация, инерция, стены, земля и трение — та же физика,
  // что у сбитого игрока. Поза и голова поднимаются вместе с fall → 0.
  _downed(dt) {
    for (const f of this.list) {
      if (!isDown(f)) continue;
      if (f.downT > 0) {
        f.downT = Math.max(0, f.downT - dt);
        if (f.downT === 0) f.getUpT = this.down.getUp;
      } else {
        f.getUpT = Math.max(0, f.getUpT - dt);
      }
      f.vy -= this.gravity * dt;
      f.x += f.vx * dt;
      f.z += f.vz * dt;
      const res = resolveCircleAabb(f.x, f.z, 0.35, f.y, 1.75, this.world.colliders || []);
      if (res.hit) {
        f.x = res.x;
        f.z = res.z;
        f.vx *= 0.3;
        f.vz *= 0.3;
      }
      f.y += f.vy * dt;
      const g = this._groundAt(f.x, f.z);
      if (f.y <= g) {
        f.y = g;
        f.vy = 0;
        const fr = Math.exp(-this.down.friction * dt);
        f.vx *= fr;
        f.vz *= fr;
      }
      f.headYaw = 0;
      if (f.downT > 0) {
        f.fall = 1;
      } else if (f.getUpT > 0) {
        f.fall = f.getUpT / this.down.getUp;
      } else {
        f.fall = 0; // встал — снова на ногах
        f.vx = 0; f.vy = 0; f.vz = 0;
      }
    }
  }

  // Игрок рядом — головы поворачиваются на него; ушёл — возвращаются к костру.
  // bike: спутник в follow рядом с седлом подсаживается пассажиром и едет за спиной.
  update(dt, p, bike) {
    const c = this.cfg;
    const k = 1 - Math.exp(-c.lookSpeed * dt);
    this._downed(dt); // сбитые: физика тела и поза идут раньше всего остального
    for (const f of this.list) {
      if (isDown(f) || f.dead) continue; // лежит или погиб — головой не вертит
      if (f.ride) { // пассажир смотрит по курсу: голову к игроку не ворочает
        f.headYaw += (0 - f.headYaw) * k;
        continue;
      }
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      let want = 0;
      if (dx * dx + dz * dz < c.lookRange * c.lookRange) {
        let d = Math.atan2(dx, dz) - f.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d)); // кратчайший разворот
        want = d < -HEAD_TURN ? -HEAD_TURN : d > HEAD_TURN ? HEAD_TURN : d;
      }
      f.headYaw += (want - f.headYaw) * k;
    }

    // спутник (позванный клавишей E): идёт за игроком; ближе followStop — стоит
    // и смотрит на него; повторный E — «жди здесь» и он остаётся на месте
    for (const f of this.list) {
      if (f.sit || f.ride || f.dead || f.mode !== 'follow' || isDown(f)) continue;
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      const d = Math.hypot(dx, dz);
      let want;
      if (d > c.followStop) {
        const nx = dx / d;
        const nz = dz / d;
        // «резинка»: отстал дальше followCatchUp — догоняет бегом, иначе не поспеть
        const spd = d > c.followCatchUp ? c.catchUpSpeed : c.followSpeed;
        f.x += nx * spd * dt;
        f.z += nz * spd * dt;
        const res = resolveCircleAabb(f.x, f.z, 0.35, f.y, 1.75, this.world.colliders || []);
        if (res.hit) {
          f.x = res.x;
          f.z = res.z;
        }
        f.y = this._groundAt(f.x, f.z);
        want = Math.atan2(nx, nz); // корпус идёт за направлением движения
      } else {
        want = Math.atan2(dx, dz); // дошёл — разворачивается к игроку
      }
      const delta = Math.atan2(Math.sin(want - f.yaw), Math.cos(want - f.yaw));
      const maxTurn = TURN_RATE * dt;
      f.yaw += Math.abs(delta) <= maxTurn ? delta : Math.sign(delta) * maxTurn;
    }

    // пассажир: спутник в follow рядом с седлом садится за спину игрока; при
    // высадке слезает слева от мотоцикла. Пока едет — поза и крен с мотоцикла.
    if (bike) {
      for (const f of this.list) {
        if (f.ride) {
          if (bike.mounted) {
            f.x = bike.pos.x + Math.sin(bike.yaw) * RIDE_Z;
            f.z = bike.pos.z + Math.cos(bike.yaw) * RIDE_Z;
            f.y = bike.pos.y + RIDE_SEAT;
            f.yaw = bike.yaw;               // пассажир смотрит по курсу
            f.lean = bike.group.rotation.z; // крен в поворотах — вместе с мотоциклом
          } else {
            f.x = bike.pos.x + Math.cos(bike.yaw) * 1.0; // слезает слева: l = (cos, −sin)
            f.z = bike.pos.z - Math.sin(bike.yaw) * 1.0;
            f.y = this._groundAt(f.x, f.z);
            f.ride = false;
            f.lean = 0;
          }
        } else if (bike.mounted && !f.sit && !f.dead && f.mode === 'follow' && !isDown(f)) {
          const dx = bike.pos.x - f.x;
          const dz = bike.pos.z - f.z;
          if (dx * dx + dz * dz <= c.boardRange * c.boardRange) f.ride = true;
        }
      }
    }
    this.syncBodies();
    this.syncHeads();
  }

  syncHeads() {
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const f = this.list[i];
      if (f.ride) {
        // пассажир: голова по курсу с креном, центр — над его седлом
        this._e.set(0, f.yaw + f.headYaw, f.lean);
        this._q.setFromEuler(this._e);
        this._p.set(f.x, f.y + HEAD_RIDE, f.z);
      } else if (f.fall > 0) {
        // сбитый: голова там же, куда её увёл разворот корпуса — лежит на земле
        this._eF.set(-Math.PI / 2 * f.fall, f.yaw + f.headYaw, 0);
        this._q.setFromEuler(this._eF);
        this._v.set(0, HEAD_STAND, 0).applyQuaternion(this._q);
        this._p.set(f.x + this._v.x, f.y + this._v.y, f.z + this._v.z);
      } else {
        this._q.setFromAxisAngle(UP, f.yaw + f.headYaw);
        this._p.set(f.x, f.y + f.headY, f.z);
      }
      this._m.compose(this._p, this._q, ONE);
      this.head.setMatrixAt(i, this._m);
      this.headShell.setMatrixAt(i, this._m);
      this.faces.setMatrixAt(i, this._m); // лицо смотрит туда же, куда голова
    }
    this.head.instanceMatrix.needsUpdate = true;
    this.headShell.instanceMatrix.needsUpdate = true;
    this.faces.instanceMatrix.needsUpdate = true;
  }
}

// Друг сбит: лежит после аварии или встаёт. В этом состоянии он не ходит,
// не откликается на E и не садится пассажиром.
export function isDown(f) {
  return f.downT > 0 || f.getUpT > 0;
}

// Тело пассажира: сидит на седле, ноги по бокам вниз-вперёд;
// происхождение — на самом седле. inflate — раздутие для контура силуэта.
function makeRideGeometry(inflate = 0) {
  const hips = new THREE.BoxGeometry(0.46 + inflate, 0.24 + inflate, 0.4 + inflate);
  hips.translate(0, 0.12, 0);
  const torso = new THREE.BoxGeometry(0.5 + inflate, 0.52 + inflate, 0.3 + inflate);
  torso.translate(0, 0.44, 0.02);
  const legL = new THREE.BoxGeometry(0.15 + inflate, 0.44 + inflate, 0.17 + inflate);
  legL.rotateX(-0.5);
  legL.translate(-0.15, -0.12, 0.14);
  const legR = legL.clone();
  legR.translate(0.3, 0, 0);
  return mergeGeometries([hips, torso, legL, legR]);
}

// Сидящее тело: таз, торс и вытянутые вперёд ноги; происхождение — на земле.
function makeSitGeometry(inflate = 0) {
  const hips = new THREE.BoxGeometry(0.46 + inflate, 0.3 + inflate, 0.42 + inflate);
  hips.translate(0, 0.3, 0.02);
  const torso = new THREE.BoxGeometry(0.52 + inflate, 0.6 + inflate, 0.32 + inflate);
  torso.translate(0, 0.72, 0);
  const legs = new THREE.BoxGeometry(0.4 + inflate, 0.24 + inflate, 0.62 + inflate);
  legs.translate(0, 0.14, 0.35);
  return mergeGeometries([hips, torso, legs]);
}

// Голова дружелюбного: геометрия вокруг шеи — матрица задаёт и позицию, и поворот.
function makeFriendHead(inflate = 0) {
  return new THREE.BoxGeometry(0.3 + inflate, 0.3 + inflate, 0.3 + inflate);
}

// «Лицо» друга: тёмная полоса глаз на передней грани головы (грань +z на 0.15).
function makeFriendFace() {
  const face = new THREE.BoxGeometry(0.2, 0.05, 0.04);
  face.translate(0, 0.02, 0.16);
  return face;
}
