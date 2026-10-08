import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';
import { Covers } from './covers.js';
import { NpcBrain } from './npc-brain.js';
import {
  SHELL, makeBodyGeometry, makeHeadGeometry, makeFaceGeometry,
  makeVisionSlice, makeStickGeometry, makeGunGeometry,
} from './npc-geo.js';

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const HAND = { x: 0.34, y: 1.02, z: 0.16 }; // кисть правой руки: сюда крепится оружие
const FALL_TIME = 0.45; // сколько NPC заваливается после смерти, с
const noop = () => {};

// Отряд NPC: instanced-меши, попадания, тревоги и отрисовка. Решения и движение —
// в NpcBrain, стены и видимость — в Covers. Живут в городе: патруль крутится
// вокруг дома. Рисуются одним набором instanced-мешей (тело, голова, лица, палки,
// пистолеты и тёмные контуры силуэта) — все NPC стоят почти как один.
export class Npcs {
  constructor(list, cfg, world, covers) {
    this.cfg = cfg.npc;
    this.world = world; // { heightmap, colliders, sizeX, sizeZ, cityLift }
    this.covers = covers || new Covers();
    this.rng = mulberry32(((cfg.seed | 0) ^ 0x5bd1e995) >>> 0);
    this.fullHp = cfg.npc.hp;
    this._t = 0; // общее время: по нему сканируют взглядом статисты
    this._sweepRad = (this.cfg.sweepAngle * Math.PI) / 180;
    this.brain = new NpcBrain(this.cfg, world, this.covers, this.rng);
    this.units = [];

    // --- меши: тело и голова — на каждого, палки и пистолеты — по типу оружия
    const nStick = list.filter((it) => it.weapon !== 'pistol').length;
    this.body = new THREE.InstancedMesh(makeBodyGeometry(), new THREE.MeshLambertMaterial({ color: cfg.palette.npcBody, flatShading: true }), list.length);
    this.head = new THREE.InstancedMesh(makeHeadGeometry(), new THREE.MeshLambertMaterial({ color: cfg.palette.npcHead, flatShading: true }), list.length);
    this.sticks = new THREE.InstancedMesh(makeStickGeometry(), new THREE.MeshLambertMaterial({ color: cfg.palette.trunk, flatShading: true }), nStick);
    this.guns = new THREE.InstancedMesh(makeGunGeometry(), new THREE.MeshLambertMaterial({ color: cfg.palette.npcGun, flatShading: true }), list.length - nStick);
    // контур силуэта: чуть раздутая тёмная копия корпуса и головы (рисуется
    // изнутри, BackSide) — на дистанции NPC не растворяется в пикселях фона
    this.bodyShell = new THREE.InstancedMesh(makeBodyGeometry(SHELL), new THREE.MeshBasicMaterial({ color: cfg.palette.npcOutline, side: THREE.BackSide }), list.length);
    this.headShell = new THREE.InstancedMesh(makeHeadGeometry(SHELL), new THREE.MeshBasicMaterial({ color: cfg.palette.npcOutline, side: THREE.BackSide }), list.length);
    // «лицо»: тёмная полоса-глаза на передней грани головы. Издалека видно, куда NPC
    // смотрит — а значит, где у него спина: туда и бей палкой для удара в спину
    this.faces = new THREE.InstancedMesh(makeFaceGeometry(), new THREE.MeshBasicMaterial({ color: cfg.palette.npcOutline }), list.length);
    this.parts = [this.body, this.head, this.sticks, this.guns, this.bodyShell, this.headShell, this.faces];
    for (const m of this.parts) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; // NPC ходят: коробка отсечения меша тут не годится
      m.userData.npc = true;   // хитсякану: попал в NPC — instanceId и есть его номер
    }

    // отладочная зона зрения (видна вместе с HUD по F3): веер тонких лепестков-лучей,
    // каждый гаснет о стену или валун, как свет — где веер оборван, там NPC слеп.
    // В parts веера нет: хитсякан его не видит
    const cone = (this.cfg.visionAngle * Math.PI) / 180;
    const slices = this.cfg.visionSlices;
    this._slice = cone / slices; // угловая ширина одного лепестка, рад
    const visionMat = new THREE.MeshBasicMaterial({
      color: cfg.palette.visionFront, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide,
    });
    this.debugFront = new THREE.InstancedMesh(makeVisionSlice(this._slice), visionMat, list.length * slices);
    this.debug = [this.debugFront];
    this.debugOn = false;
    for (const m of this.debug) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.renderOrder = 2; // поверх травы, глубину не пишут — мир под ними виден
      m.visible = false;
    }

    this._q = new THREE.Quaternion();
    this._qa = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._mHand = new THREE.Matrix4();
    this._mRot = new THREE.Matrix4();
    this._mPart = new THREE.Matrix4();
    this._mHead = new THREE.Matrix4(); // голова отдельно: у статистов она сканирует
    this._c = new THREE.Color();
    this._sSlice = new THREE.Vector3(); // масштаб лепестка отладочного веера зрения
    this._dbgT = 0;                     // троттлинг веера: пересчёт ~30 Гц, не каждый кадр
    this._dbgVision = -1;               // прошлая дальность зрения: присед сменил — пересчёт сразу

    // Угрозы: обёртки переиспользуются (список собирается каждый кадр), урон
    // уходит одному стабильному диспетчеру — он смотрит, по кому воюет юнит.
    this._threats = [];
    this._threatPool = [];
    this._dmgThreat = null;
    this._playerDamage = noop;
    this._friendDamage = noop;
    this._damage = (amount, from) => {
      const t = this._dmgThreat;
      if (t && t.friend) this._friendDamage(t.friend, amount, from);
      else this._playerDamage(amount, from);
    };

    let wiStick = 0;
    let wiGun = 0;
    const headCol = new THREE.Color(cfg.palette.npcHead);
    this._hc = headCol; // свой цвет головы — вернуть после вспышки попадания
    list.forEach((it, i) => {
      const u = {
        pos: new THREE.Vector3(it.x, it.y !== undefined ? it.y : this.groundAt(it.x, it.z), it.z),
        vel: new THREE.Vector3(), // только отдача от ударов игрока
        yaw: it.rot || 0,
        rot: it.rot || 0,
        home: { x: it.home ? it.home.x : it.x, z: it.home ? it.home.z : it.z },
        static: !!it.static, // статист: стоит на месте и сканирует головой, пока спокоен
        gaze: 0,             // текущий поворот головы сверх корпуса (взгляд)
        gazePhase: i * 2.399963, // фаза сканирования: у всех разная, без rng
        weapon: it.weapon === 'pistol' ? 'pistol' : 'stick',
        wi: 0, // слот внутри своего меша оружия
        hp: this.fullHp,
        dead: false,
        fall: 0,
        aware: false,      // был ли контакт с угрозой
        sees: false,       // видит ли прямо сейчас (обновляется на «думании»)
        state: 'patrol',   // patrol | close | medium | hold | search
        lastKnown: null,   // где видел угрозу в последний раз
        searchCenter: null, // район поиска после потери из вида
        cover: null,       // точка за укрытием (стрелки)
        coverFrom: { x: 0, z: 0 }, // где была угроза при выборе укрытия
        toCover: false,    // отстрелялся и отходит за укрытие: угол не бросает
        spot: null,        // забронированный угол выгляда (ссылка внутрь covers)
        lostT: 0,          // сколько не видит угрозу, с: терпение у угла ограничено
        threat: null,      // текущая цель: игрок или спутник игрока
        target: null,
        pauseT: 0,
        thinkT: this.rng() * this.cfg.thinkInterval,
        swingT: 0,
        swingDone: true,
        shotT: 0,
        aimT: 0,
        gunT: 0,
        burstLeft: 0, // выстрелов осталось в текущей очереди
        flashT: 0,    // белая вспышка куртки от попадания игрока
      };
      u.wi = u.weapon === 'pistol' ? wiGun++ : wiStick++;
      this.units.push(u);

      this._c.set(cfg.palette.npcBody).multiplyScalar(0.8 + this.rng() * 0.45); // у каждого свой оттенок куртки
      this.body.setColorAt(i, this._c);
      u.col = this._c.clone(); // свой цвет — вернуть после вспышки попадания
      this.head.setColorAt(i, headCol);
    });
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.head.instanceColor) this.head.instanceColor.needsUpdate = true;

    for (let i = 0; i < this.units.length; i++) this._compose(i);
    for (const m of this.parts) m.instanceMatrix.needsUpdate = true;
  }

  get aliveCount() {
    let n = 0;
    for (const u of this.units) if (!u.dead) n++;
    return n;
  }

  get alertCount() {
    let n = 0;
    for (const u of this.units) if (u.aware && !u.dead) n++;
    return n;
  }

  addTo(scene) {
    for (const m of this.parts) scene.add(m);
    scene.add(this.debugFront);
  }

  groundAt(x, z) {
    return this.brain.groundAt(x, z);
  }

  // Режим отладки (включается вместе с HUD по F3): показать зоны зрения.
  setDebug(on) {
    this.debugOn = !!on;
    this._dbgVision = -1; // включили — веер пересчитается на ближайшем кадре
    for (const m of this.debug) m.visible = this.debugOn;
  }

  // Веер зрения (F3): конус нарезан на тонкие лепестки-лучи; каждый гаснет о
  // стену или валун ровно там, где covers.los обрывает взгляд. Вне веера NPC слеп.
  _syncDebug(vision) {
    const slices = this.cfg.visionSlices;
    const span = this._slice;
    const half = (span * slices) / 2; // полуугол полного конуса, рад
    let idx = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const yawG = u.yaw + u.gaze; // взгляд: у статистов сканирует влево-вправо
      this._p.set(u.pos.x, u.pos.y + 0.07, u.pos.z);
      for (let s = 0; s < slices; s++, idx++) {
        const a = yawG - half + (s + 0.5) * span; // центр лепестка
        const r = u.dead ? 0 : this.covers.cast(u.pos.x, u.pos.z, a, vision);
        this._q.setFromAxisAngle(UP, a);
        this._m.compose(this._p, this._q, this._sSlice.set(r, 1, r));
        this.debugFront.setMatrixAt(idx, this._m);
      }
    }
    this.debugFront.instanceMatrix.needsUpdate = true;
  }

  // Удар или пуля по NPC: imp — урон и толчок. fromPos — откуда прилетело:
  // нужен для удара В СПИНУ (взгляд NPC отвёрнут от игрока больше 120° —
  // backstabMult валит одним ударом). hitPoint — точка попадания: выше
  // headZone считается голова, и headDamage (хэдшот) убивает сразу.
  hit(i, dir, imp, fromPos, hitPoint) {
    const u = this.units[i];
    if (!u || u.dead) return false;
    u.vel.x += dir.x * (imp.knockback || 0);
    u.vel.z += dir.z * (imp.knockback || 0);
    // белая вспышка куртки и головы: попадание видно сразу, даже боковым зрением
    u.flashT = this.cfg.hitFlashTime;
    this._c.set(0xffffff);
    this.body.setColorAt(i, this._c);
    this.head.setColorAt(i, this._c);
    this.body.instanceColor.needsUpdate = true;
    this.head.instanceColor.needsUpdate = true;
    u.aware = true;
    if (fromPos) u.lastKnown = { x: fromPos.x, z: fromPos.z };
    let damage = imp.damage || 0;
    // голова: точка попадания выше груди — хэдшот валит с одного раза
    if (hitPoint && imp.headDamage && hitPoint.y - u.pos.y > this.cfg.headZone) damage = imp.headDamage;
    // спина: взгляд NPC (локальная ось +z) против направления на игрока
    if (imp.backstabMult && fromPos) {
      const dx = fromPos.x - u.pos.x;
      const dz = fromPos.z - u.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6 && (Math.sin(u.yaw) * dx + Math.cos(u.yaw) * dz) / d < -0.5) damage *= imp.backstabMult;
    }
    u.hp -= damage;
    if (u.hp <= 0) {
      u.hp = 0;
      u.dead = true;
      u.sees = false;
      u.gaze = 0;
      u.target = null;
      this.covers.releaseSpot(u); // умер — угол снова свободен
    }
    return true;
  }

  // Выстрел игрока: пуля, просвистевшая рядом, поднимает NPC и его соседей —
  // группа идёт искать место выстрела. Новый выстрел перенацеливает и тех,
  // кто уже идёт искать: обновляем зону; не трогаем только воюющих (видят игрока).
  // Зовётся из main на каждый выстрел.
  alertShot(from, dir, len) {
    const c = this.cfg;
    const r2 = c.shotAlertRadius * c.shotAlertRadius;
    const heard = [];
    for (const u of this.units) {
      if (u.dead || u.sees) continue; // в бою цель не сбиваем
      // ближайшее приближение пули к корпусу NPC по отрезку выстрела
      const rx = u.pos.x - from.x;
      const ry = u.pos.y + 1 - from.y;
      const rz = u.pos.z - from.z;
      let t = rx * dir.x + ry * dir.y + rz * dir.z;
      t = t < 0 ? 0 : t > len ? len : t;
      const ox = rx - dir.x * t;
      const oy = ry - dir.y * t;
      const oz = rz - dir.z * t;
      if (ox * ox + oy * oy + oz * oz > r2) continue;
      this._alert(u, from);
      heard.push(u);
    }
    if (heard.length === 0) return;
    // соседи рядом с услышавшими тоже идут: тревожится вся группа
    const g2 = c.shotAlertGroup * c.shotAlertGroup;
    for (const u of this.units) {
      if (u.dead || u.sees || heard.includes(u)) continue;
      for (const a of heard) {
        const dx = a.pos.x - u.pos.x;
        const dz = a.pos.z - u.pos.z;
        if (dx * dx + dz * dz < g2) { this._alert(u, from); break; }
      }
    }
  }

  // Громкий выстрел: NPC в радиусе слышат хлопок и идут к месту выстрела
  // (позиция игрока). Палка не шумит — тихий путь существует, это стелс.
  alertNoise(from, radius) {
    const r2 = radius * radius;
    for (const u of this.units) {
      if (u.dead || u.sees) continue; // в бою цель не сбиваем
      const dx = u.pos.x - from.x;
      const dz = u.pos.z - from.z;
      if (dx * dx + dz * dz > r2) continue;
      this._alert(u, from);
    }
  }

  // Поднять по тревоге: место выстрела — последняя известная точка, дальше обычный поиск.
  _alert(u, from) {
    u.aware = true;
    u.lastKnown = { x: from.x, z: from.z };
    u.target = u.lastKnown; // сразу разворачиваются к месту выстрела, не ждём «думания»
    u.state = 'search';
    u.lostT = 0;
    u.pauseT = 0;
    u.toCover = false; // новая цель — прежний отход не в счёт
    this.covers.releaseSpot(u); // цель другая — прежний угол может её не видеть
  }

  // Список угроз: игрок — всегда, плюс спутники, которых можно бить (идут за
  // игроком, живые, не в седле и на ногах). Ведение квеста поэтому возможно и
  // стелсом, и зачисткой: враждебные видят и бьют спутника тоже.
  _collectThreats(playerPos, friends, crouch) {
    const c = this.cfg;
    const out = this._threats;
    out.length = 0;
    // присевшего игрока замечают со значительно меньшей дистанции — стелс
    out.push(this._threat(0, playerPos, null, crouch ? c.visionRange * c.crouchVision : c.visionRange));
    if (!friends) return out;
    let i = 1;
    for (const f of friends) {
      if (f.dead || f.sit || f.ride || f.mode !== 'follow') continue;
      if (f.downT > 0 || f.getUpT > 0) continue; // лежачего не бьют
      out.push(this._threat(i++, f, f, c.visionRange));
    }
    return out;
  }

  // Обёртка угрозы из пула: позиция копируется, потому что у спутников она живёт
  // в скалярах f.x/f.y/f.z, а мозгу нужен один объект с .x/.y/.z.
  _threat(i, src, friend, vision) {
    const t = this._threatPool[i] || (this._threatPool[i] = { pos: new THREE.Vector3(), friend: null, vision: 0 });
    t.pos.set(src.x, src.y, src.z);
    t.friend = friend;
    t.vision = vision;
    return t;
  }

  // Цель юнита: из реально видимых угроз — ближайшая. Никого не видно — держим
  // прошлую, пока она в пределах зрения и за прямой видимостью (по её lastKnown
  // и идём искать); прошлая исчезла (сел в седло, погиб) — цель по умолчанию.
  _selectThreat(u, threats) {
    let best = null;
    let bestD = Infinity;
    let keep = null;
    for (const t of threats) {
      if (!this.brain.inSight(u, t.pos.x, t.pos.z, t.vision)) continue;
      if (t === u.threat) keep = t;
      if (!this.brain.canSee(u, t.pos.x, t.pos.z, t.vision)) continue; // вне конуса
      const d = Math.hypot(t.pos.x - u.pos.x, t.pos.z - u.pos.z);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best || keep || threats[0];
  }

  update(dt, playerPos, hooks, opts) {
    this._playerDamage = (hooks && hooks.playerDamage) || noop;
    this._friendDamage = (hooks && hooks.friendDamage) || noop;
    const onMuzzle = (hooks && hooks.muzzle) || noop;
    const onTracer = (hooks && hooks.tracer) || noop;
    const crouch = !!(opts && opts.crouch);
    const threats = this._collectThreats(playerPos, opts && opts.friends, crouch);
    const vision = threats[0].vision; // зрение игрока: с ним рисуется отладочный веер
    this._t += dt; // время сканирования головой
    for (const u of this.units) {
      if (u.dead) {
        u.fall = Math.min(1, u.fall + dt / FALL_TIME); // заваливается и остаётся лежать
        continue;
      }
      // спокойный статист сканирует головой влево-вправо — сектор обзора ходит;
      // заметил — взгляд выравнивается, дальше доворачивается корпусом
      if (u.static && !u.aware) {
        u.gaze = Math.sin(this._t * this.cfg.sweepSpeed + u.gazePhase) * this._sweepRad;
      } else if (u.gaze !== 0) {
        u.gaze *= Math.exp(-8 * dt);
        if (Math.abs(u.gaze) < 1e-3) u.gaze = 0;
      }
      const t = (u.threat = this._selectThreat(u, threats));
      u.thinkT -= dt;
      if (u.thinkT <= 0) {
        this.brain.think(u, t.pos, t.vision);
        u.thinkT = this.cfg.thinkInterval * (0.75 + this.rng() * 0.5); // решения вразнобой
      }
      this.brain.move(u, dt, t.pos);
      this._dmgThreat = t; // урон уходит той цели, по которой воюет этот юнит
      this.brain.act(u, dt, t.pos, this._damage, onMuzzle, onTracer);
    }
    this._dmgThreat = null;
    // вспышка попадания гаснет: куртка и голова возвращают свои оттенки
    let colDirty = false;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.flashT <= 0) continue;
      u.flashT -= dt;
      if (u.flashT <= 0) {
        this.body.setColorAt(i, u.col);
        this.head.setColorAt(i, this._hc);
        colDirty = true;
      }
    }
    if (colDirty) {
      this.body.instanceColor.needsUpdate = true;
      this.head.instanceColor.needsUpdate = true;
    }
    this._separate();
    for (let i = 0; i < this.units.length; i++) this._compose(i);
    for (const m of this.parts) m.instanceMatrix.needsUpdate = true;
    // веер зрения: пересчёт ~30 Гц; смена дальности (присед) — сразу
    if (this.debugOn) {
      this._dbgT += dt;
      if (this._dbgT >= 0.033 || this._dbgVision !== vision) {
        this._dbgT = 0;
        this._dbgVision = vision;
        this._syncDebug(vision);
      }
    }
  }

  // NPC не стоят друг в друге: мягко расталкиваем пары.
  _separate() {
    const min = 0.85;
    for (let i = 0; i < this.units.length; i++) {
      const a = this.units[i];
      if (a.dead) continue;
      for (let j = i + 1; j < this.units.length; j++) {
        const b = this.units[j];
        if (b.dead) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) / 2;
        const nx = dx / d;
        const nz = dz / d;
        a.pos.x -= nx * push;
        a.pos.z -= nz * push;
        b.pos.x += nx * push;
        b.pos.z += nz * push;
      }
    }
  }

  // Перенос NPC в instanced-меши: база (позиция + разворот + падение) для тела
  // и головы, оружие — к кисти руки с анимацией замаха/отдачи.
  _compose(i) {
    const u = this.units[i];
    this._q.setFromAxisAngle(UP, u.yaw);
    if (u.fall > 0) {
      this._qa.setFromAxisAngle(X_AXIS, -(Math.PI / 2) * u.fall);
      this._q.multiply(this._qa); // заваливается вперёд, вокруг собственных ног
    }
    this._p.set(u.pos.x, u.pos.y, u.pos.z);
    this._m.compose(this._p, this._q, ONE);
    this.body.setMatrixAt(i, this._m);
    this.bodyShell.setMatrixAt(i, this._m);
    // голова отдельно: у статистов она сканирует (gaze поверх разворота)
    this._q.setFromAxisAngle(UP, u.gaze ? u.yaw + u.gaze : u.yaw);
    if (u.fall > 0) {
      this._qa.setFromAxisAngle(X_AXIS, -(Math.PI / 2) * u.fall);
      this._q.multiply(this._qa);
    }
    this._mHead.compose(this._p, this._q, ONE);
    this.head.setMatrixAt(i, this._mHead);
    this.headShell.setMatrixAt(i, this._mHead);
    this.faces.setMatrixAt(i, this._mHead); // лицо живёт при голове: тот же разворот

    let ang;
    if (u.weapon === 'pistol') {
      ang = -0.1 - 0.5 * (u.gunT / 0.12); // отдача подкидывает ствол
    } else {
      const progress = u.swingT > 0 ? 1 - u.swingT / this.cfg.swingTime : 0;
      ang = -0.25 + 1.3 * Math.sin(Math.PI * progress); // замах: палка описывает дугу
    }
    this._mHand.makeTranslation(HAND.x, HAND.y, HAND.z);
    this._mRot.makeRotationX(ang);
    this._mHand.multiply(this._mRot);
    this._mPart.multiplyMatrices(this._m, this._mHand);
    if (u.weapon === 'pistol') this.guns.setMatrixAt(u.wi, this._mPart);
    else this.sticks.setMatrixAt(u.wi, this._mPart);
  }

  // Вернуть всех на исходные позиции в полном здравии (клавиша R).
  resetAll() {
    this.covers.releaseAll(); // углы выгляда снова свободны
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      u.flashT = 0;
      this.body.setColorAt(i, u.col); // погасить случайную вспышку попадания
      this.head.setColorAt(i, this._hc);
      u.pos.set(u.home.x, this.groundAt(u.home.x, u.home.z), u.home.z);
      u.vel.set(0, 0, 0);
      u.yaw = u.rot;
      u.hp = this.fullHp;
      u.dead = false;
      u.fall = 0;
      u.aware = false;
      u.sees = false;
      u.state = 'patrol';
      u.lastKnown = null;
      u.searchCenter = null;
      u.cover = null;
      u.coverFrom = { x: 0, z: 0 };
      u.toCover = false;
      u.spot = null; // бронь сняли выше — ссылку тоже роняем
      u.gaze = 0;
      u.lostT = 0;
      u.threat = null;
      u.target = null;
      u.pauseT = 0;
      u.thinkT = this.rng() * this.cfg.thinkInterval;
      u.swingT = 0;
      u.swingDone = true;
      u.shotT = 0;
      u.aimT = 0;
      u.gunT = 0;
      u.burstLeft = 0;
    }
    for (let i = 0; i < this.units.length; i++) this._compose(i);
    for (const m of this.parts) m.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.head.instanceColor) this.head.instanceColor.needsUpdate = true;
  }
}
