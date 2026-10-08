import * as THREE from 'three';
import { resolveCircleAabb } from '../core/collide.js';
import { mulberry32 } from '../core/noise.js';
import { mergeGeometries } from './merge.js';

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const HAND = { x: 0.34, y: 1.02, z: 0.16 }; // кисть правой руки: сюда крепится оружие
const FALL_TIME = 0.45; // сколько NPC заваливается после смерти, с
export const SHELL = 0.07; // на сколько тёмный контур раздувает тело, м — силуэт читается вдали
const noop = () => {};

// NPC: видят строго внутри зелёного конуса зрения (F3): вне его — слепы, за спину
// можно зайти вплотную, а стены и валуны гасят взгляд, как свет (_los). Плюс три
// зоны контакта с игроком —
//   1) близко: агрессия — палка бьёт, пистолет стреляет в упор;
//   2) средне: сближение; стрелки ищут, за чем спрятаться (стена, валун, ствол),
//      выбегают на очередь 2–4 выстрела (с разбросом — мажут), отстрелялись —
//      прячутся за угол и через паузу выбегают снова;
//   3) вне видимости: реакции нет; если контакт уже был — идут к последней
//      известной точке и широко патрулируют район находки. Выстрел рядом (alertShot):
//      услышавший свист пули и его группа идут искать место выстрела.
// Живут в городе: патруль крутится вокруг дома. Рисуются одним набором
// instanced-мешей (тело, голова, лица, палки, пистолеты и тёмные контуры силуэта) —
// все NPC стоят почти как один.
export class Npcs {
  constructor(list, cfg, world, covers) {
    this.cfg = cfg.npc;
    this.world = world; // { heightmap, colliders, sizeX, sizeZ, cityLift }
    this.covers = covers || { grid: new Map(), cell: 8, city: null };
    this.rng = mulberry32(((cfg.seed | 0) ^ 0x5bd1e995) >>> 0);
    this.fullHp = cfg.npc.hp;
    this._t = 0; // общее время: по нему сканируют взглядом статисты
    // косинус полуугла конуса зрения: угол из конфига в градусах
    this._cosHalf = Math.cos((this.cfg.visionAngle * Math.PI) / 360);
    this._sweepRad = (this.cfg.sweepAngle * Math.PI) / 180;
    this.units = [];
    // баки — живые коллайдеры вне грида укрытий: «щупальце» и патруль должны их видеть
    this.binList = (world.bins && world.bins.units) || null;

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
    this._t1 = new THREE.Vector3(); // разброс выстрела: направление и поперечины
    this._t2 = new THREE.Vector3();
    this._t3 = new THREE.Vector3();
    this._sSlice = new THREE.Vector3(); // масштаб лепестка отладочного веера зрения
    this._dbgT = 0;                     // троттлинг веера: пересчёт ~30 Гц, не каждый кадр
    this._dbgVision = -1;               // прошлая дальность зрения: присед сменил — пересчёт сразу

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
        aware: false,      // был ли контакт с игроком
        sees: false,       // видит ли прямо сейчас (обновляется на «думании»)
        state: 'patrol',   // patrol | close | medium | search
        lastKnown: null,   // где видел игрока в последний раз
        searchCenter: null, // район поиска после потери из вида
        cover: null,       // точка за укрытием (стрелки)
        coverFrom: { x: 0, z: 0 }, // откуда игрок смотрел при выборе укрытия
        peek: null,        // точка у края укрытия, откуда выглядываем и стреляем
        peekSide: 1,       // сторона выгляда: держимся одной, чтобы не метаться
        hideT: 0,          // сколько уже пережидает за укрытием без боя
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
    const lift = this.world.cityLift ? this.world.cityLift(x, z) : 0;
    return this.world.heightmap.heightAt(x, z) + lift;
  }

  // Режим отладки (включается вместе с HUD по F3): показать зоны зрения.
  setDebug(on) {
    this.debugOn = !!on;
    this._dbgVision = -1; // включили — веер пересчитается на ближайшем кадре
    for (const m of this.debug) m.visible = this.debugOn;
  }

  // Веер зрения (F3): конус нарезан на тонкие лепестки-лучи; каждый гаснет о
  // стену или валун ровно там, где _los обрывает взгляд. Вне веера NPC слеп.
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
        const r = u.dead ? 0 : this._castVision(u, a, vision);
        this._q.setFromAxisAngle(UP, a);
        this._m.compose(this._p, this._q, this._sSlice.set(r, 1, r));
        this.debugFront.setMatrixAt(idx, this._m);
      }
    }
    this.debugFront.instanceMatrix.needsUpdate = true;
  }

  // Дальность луча зрения по азимуту a: первое препятствие на пути — там луч гаснет.
  _castVision(u, a, max) {
    const dx = Math.sin(a) * max;
    const dz = Math.cos(a) * max;
    const x0 = u.pos.x;
    const z0 = u.pos.z;
    const stamp = (this._castStamp = (this._castStamp | 0) + 1);
    let best = 1; // ближайшее препятствие как t отрезка [0..1]
    const gx0 = Math.floor(Math.min(x0, x0 + dx) / this.covers.cell);
    const gx1 = Math.floor(Math.max(x0, x0 + dx) / this.covers.cell);
    const gz0 = Math.floor(Math.min(z0, z0 + dz) / this.covers.cell);
    const gz1 = Math.floor(Math.max(z0, z0 + dz) / this.covers.cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const bucket = this.covers.grid.get(gx + ':' + gz);
        if (!bucket) continue;
        for (const ob of bucket) {
          if (ob._castStamp === stamp) continue; // одно препятствие — один раз
          ob._castStamp = stamp;
          const t = this._segHitT(ob, x0, z0, dx, dz);
          if (t >= 0 && t < best) best = t;
        }
      }
    }
    return best * max;
  }

  // Первое пересечение отрезка (x0,z0)+t·(dx,dz), t ∈ [0,1], с препятствием; -1 — мимо.
  _segHitT(ob, x0, z0, dx, dz) {
    if (ob.rect) {
      const minX = ob.x - ob.e1;
      const maxX = ob.x + ob.e1;
      const minZ = ob.z - ob.e2;
      const maxZ = ob.z + ob.e2;
      let t0 = 0;
      let t1 = 1;
      if (Math.abs(dx) < 1e-9) {
        if (x0 < minX || x0 > maxX) return -1;
      } else {
        let a = (minX - x0) / dx;
        let b = (maxX - x0) / dx;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) return -1;
      }
      if (Math.abs(dz) < 1e-9) {
        if (z0 < minZ || z0 > maxZ) return -1;
      } else {
        let a = (minZ - z0) / dz;
        let b = (maxZ - z0) / dz;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) return -1;
      }
      return t0;
    }
    // круг (ствол, валун): первое пересечение луча с окружностью
    const fx = x0 - ob.x;
    const fz = z0 - ob.z;
    const C = fx * fx + fz * fz - ob.e1 * ob.e1;
    if (C <= 0) return 0; // старт внутри ствола: дальней видимости нет
    const A = dx * dx + dz * dz;
    if (A < 1e-12) return -1;
    const B = 2 * (fx * dx + fz * dz);
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return -1;
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    return t >= 0 && t <= 1 ? t : -1;
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
    u.hideT = 0;
    u.pauseT = 0;
  }

  update(dt, playerPos, hooks, opts) {
    const onDamage = (hooks && hooks.playerDamage) || noop;
    const onMuzzle = (hooks && hooks.muzzle) || noop;
    const onTracer = (hooks && hooks.tracer) || noop;
    // присевшего игрока замечают со значительно меньшей дистанции — стелс
    const vision = this.cfg.visionRange * (opts && opts.crouch ? this.cfg.crouchVision : 1);
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
      u.thinkT -= dt;
      if (u.thinkT <= 0) {
        this._think(u, playerPos, vision);
        u.thinkT = this.cfg.thinkInterval * (0.75 + this.rng() * 0.5); // решения вразнобой
      }
      this._move(u, dt, playerPos);
      this._act(u, dt, playerPos, onDamage, onMuzzle, onTracer);
    }
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

  // Решение по зонам контакта; вызывается раз в thinkInterval.
  // vision — уже урезанная дальность (присед игрока), а не полная из конфига.
  _think(u, p, vision) {
    const c = this.cfg;
    const dist = Math.hypot(p.x - u.pos.x, p.z - u.pos.z);
    // зрение — строго зелёный конус (F3): вне его NPC слеп, за спину можно подойти
    // вплотную; внутри конуса стены и валуны режут взгляд — как свет (_los)
    const yawG = u.yaw + u.gaze; // статист смотрит с учётом сканирования головой
    const ahead = Math.sin(yawG) * (p.x - u.pos.x) + Math.cos(yawG) * (p.z - u.pos.z);
    const visible = dist <= vision && ahead >= dist * this._cosHalf && this._los(u.pos.x, u.pos.z, p.x, p.z);
    u.sees = visible;
    if (visible) {
      u.aware = true;
      u.lastKnown = { x: p.x, z: p.z }; // вижу — запоминаю, где игрок
      u.hideT = 0;
    }
    if (!u.aware) {
      u.state = 'patrol';
      return;
    }

    if (visible && dist <= c.closeRange) {
      // близкий контакт: палочник дожимает и бьёт, стрелок ведёт очередь
      u.state = 'close';
      if (u.weapon === 'stick') {
        u.cover = null;
        u.peek = null;
        u.target = { x: p.x, z: p.z };
        return;
      }
      // стрелок в упор: отстрелялся — шаг назад к укрытию, потом выглядывает снова
      if (!u.cover) {
        u.cover = this._pickCover(u, p);
        u.coverFrom = { x: p.x, z: p.z };
        u.peek = null;
      }
      u.target = u.burstLeft > 0 || !u.cover ? null : { x: u.cover.x, z: u.cover.z };
      return;
    }
    if (visible) {
      // средний контакт: сближение; стрелки уходят за укрытие и ведут пристрелку
      u.state = 'medium';
      if (u.weapon === 'pistol') {
        if (u.cover && (Math.abs(p.x - u.coverFrom.x) > 6 || Math.abs(p.z - u.coverFrom.z) > 6)) {
          u.cover = null;
          u.peek = null;
        }
        if (!u.cover) {
          u.cover = this._pickCover(u, p);
          u.coverFrom = { x: p.x, z: p.z };
          u.peek = null;
        }
        // на огневой позиции: в очереди — стоим и стреляем, отстрелялись — прячемся назад
        const atCover = u.cover && Math.hypot(u.cover.x - u.pos.x, u.cover.z - u.pos.z) < 1.2;
        const atPeek = u.peek && Math.hypot(u.peek.x - u.pos.x, u.peek.z - u.pos.z) < 0.9;
        if (!u.cover) u.target = { x: p.x, z: p.z };
        else if (atPeek && u.burstLeft <= 0) u.target = { x: u.cover.x, z: u.cover.z };
        else if (atCover || atPeek) u.target = null;
        else if (u.shotT <= 0 && u.peek && this._los(u.peek.x, u.peek.z, p.x, p.z)) {
          // держим курс на уголок до конца: мелькнувшая по пути видимость не разворачивает
          u.target = { x: u.peek.x, z: u.peek.z };
        } else u.target = { x: u.cover.x, z: u.cover.z };
      } else {
        u.target = { x: p.x, z: p.z };
      }
      return;
    }
    // вне видимости: контакт уже был — стрелки выглядывают, остальные ищут игрока
    u.state = 'search';
    const hide = u.cover ? Math.hypot(u.cover.x - u.pos.x, u.cover.z - u.pos.z) : Infinity;
    if (u.weapon === 'pistol' && u.cover && dist <= vision && u.shotT <= 0) {
      // уже выглядываем: держим курс на уголок, пока он видит игрока — бросок
      // к углу не должен срываться на полпути из-за отрыва от укрытия
      if (u.peek && this._los(u.peek.x, u.peek.z, p.x, p.z)) {
        u.target = { x: u.peek.x, z: u.peek.z };
        return;
      }
      // новый выгляд — только из-за самого укрытия
      if (hide < 2.2) {
        const peek = this._pickPeek(u, p);
        if (peek) {
          u.peek = peek;
          u.hideT = 0;
          u.target = { x: peek.x, z: peek.z };
          return;
        }
      }
    }
    u.peek = null;
    if (hide < 8) {
      // по пути к укрытию или уже там: добегаем и пережидаем
      u.hideT += c.thinkInterval;
      if (u.hideT < c.hideWait) {
        u.target = { x: u.cover.x, z: u.cover.z };
        return;
      }
    }
    u.hideT = 0;
    u.cover = null;
    // известно место игрока/выстрела — идём туда; иначе цель не трогаем: патрульная
    // точка района поиска держится до прибытия, а не перескакивает каждый тик
    if (u.lastKnown) u.target = { x: u.lastKnown.x, z: u.lastKnown.z };
  }

  _move(u, dt, p) {
    const c = this.cfg;
    u.pauseT = Math.max(0, u.pauseT - dt);

    // патрульная точка, когда идти некуда: у дома — спокойный обход,
    // после поиска — широкий район вокруг места находки
    // статисты не патрулируют: стоят на месте, пока не заметили игрока
    if (!u.target && u.pauseT <= 0 && (!u.static || u.aware) && (u.state === 'patrol' || u.state === 'search')) {
      const wide = u.aware && u.searchCenter;
      u.target = this._pickPatrol(wide ? u.searchCenter : u.home, wide ? c.searchPatrolRadius : c.patrolRadius);
    }

    let dirx = 0;
    let dirz = 0;
    if (u.target) {
      const dx = u.target.x - u.pos.x;
      const dz = u.target.z - u.pos.z;
      const d = Math.hypot(dx, dz);
      // к точке выгляда подходим вплотную: стрельба идёт точно с края укрытия
      const arrive = u.peek && Math.abs(u.target.x - u.peek.x) < 1e-9 && Math.abs(u.target.z - u.peek.z) < 1e-9 ? 0.25 : 0.8;
      if (d < arrive) {
        // дошли: последнее место игрока стало районом поиска
        if (u.lastKnown && Math.abs(u.target.x - u.lastKnown.x) < 1e-6 && Math.abs(u.target.z - u.lastKnown.z) < 1e-6) {
          u.searchCenter = u.lastKnown;
          u.lastKnown = null;
        }
        u.target = null;
        u.pauseT = 0.7 + this.rng() * 2;
      } else {
        dirx = dx / d;
        dirz = dz / d;
        // палочник в ближней зоне не влезает в игрока — бьёт с дистанции
        if (u.state === 'close' && u.weapon === 'stick' && d <= c.attackRange * 0.8) dirx = dirz = 0;
      }
    }

    // «щупальце» вперёд: упёрлись в стену или бак — ищем свободный обходной поворот
    if (dirx || dirz) {
      const ahead = 1.3;
      if (this._blocked(u.pos.x + dirx * ahead, u.pos.z + dirz * ahead)) {
        let free = false;
        for (const a of [0.9, -0.9, 1.7, -1.7, 2.4, -2.4]) {
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const rx = dirx * ca - dirz * sa;
          const rz = dirx * sa + dirz * ca;
          if (!this._blocked(u.pos.x + rx * ahead, u.pos.z + rz * ahead)) {
            dirx = rx;
            dirz = rz;
            free = true;
            break;
          }
        }
        if (!free) dirx = dirz = 0;
      }
    }

    const speed = u.aware ? c.chaseSpeed : c.walkSpeed;
    u.pos.x += dirx * speed * dt;
    u.pos.z += dirz * speed * dt;

    // отдача от ударов игрока
    u.pos.x += u.vel.x * dt;
    u.pos.z += u.vel.z * dt;
    const damp = Math.exp(-7 * dt);
    u.vel.x *= damp;
    u.vel.z *= damp;

    // стены, дома, баки — то же выталкивание, что у игрока
    const res = resolveCircleAabb(u.pos.x, u.pos.z, c.radius, u.pos.y, 1.7, this.world.colliders);
    if (res.hit) {
      u.pos.x = res.x;
      u.pos.z = res.z;
    }

    const limX = this.world.sizeX / 2 - 3;
    const limZ = this.world.sizeZ / 2 - 3;
    u.pos.x = Math.max(-limX, Math.min(limX, u.pos.x));
    u.pos.z = Math.max(-limZ, Math.min(limZ, u.pos.z));
    u.pos.y = this.groundAt(u.pos.x, u.pos.z);

    // разворот: лицом к игроку — только пока реально видим (убежал за стену —
    // уже нет), иначе — по ходу движения. Спокойный патруль доворачивается медленно
    let want = null;
    if (u.sees) want = Math.atan2(p.x - u.pos.x, p.z - u.pos.z);
    else if (dirx || dirz) want = Math.atan2(dirx, dirz);
    if (want !== null) {
      const delta = Math.atan2(Math.sin(want - u.yaw), Math.cos(want - u.yaw));
      const mx = (u.aware ? c.turnSpeed : c.patrolTurnSpeed) * dt;
      u.yaw += Math.abs(delta) <= mx ? delta : Math.sign(delta) * mx;
    }
  }

  // Атаки: палка — взмах с уроном в середине дуги; пистолет — очереди 2–4 выстрела.
  _act(u, dt, p, onDamage, onMuzzle, onTracer) {
    const c = this.cfg;
    const dist = Math.hypot(p.x - u.pos.x, p.z - u.pos.z);
    if (u.weapon === 'stick') {
      if (u.swingT > 0) {
        u.swingT = Math.max(0, u.swingT - dt);
        const progress = 1 - u.swingT / c.swingTime;
        if (!u.swingDone && progress >= 0.45 && u.sees && dist <= c.attackRange + 0.3) {
          u.swingDone = true;
          onDamage(c.attackDamage, u.pos); // палка достала игрока — оттуда и удар
        }
      }
      u.shotT = Math.max(0, u.shotT - dt);
      if (u.sees && u.state === 'close' && dist <= c.attackRange && u.swingT <= 0 && u.shotT <= 0) {
        u.swingT = c.swingTime;
        u.swingDone = false;
        u.shotT = c.attackCooldown;
      }
    } else {
      u.shotT = Math.max(0, u.shotT - dt);
      u.gunT = Math.max(0, u.gunT - dt);
      const canShoot = u.aware && u.sees && dist <= c.shotRange;
      if (!canShoot) {
        u.aimT = 0;
        u.burstLeft = 0; // цель потеряна — очередь прервана
      } else {
        if (u.burstLeft <= 0 && u.shotT <= 0) {
          // новая очередь: 2–4 выстрела подряд
          u.burstLeft = c.burstMin + Math.floor(this.rng() * (c.burstMax - c.burstMin + 1));
          u.aimT = 0;
        }
        if (u.burstLeft > 0) {
          u.aimT += dt; // пристрелка — только перед первым выстрелом очереди
          if (u.aimT >= c.aimTime && u.shotT <= 0) this._fire(u, p, dist, onDamage, onMuzzle, onTracer);
        }
      }
    }
  }

  // Выстрел: прицел в грудь игрока плюс разброс — NPC мажут, и это видно по следу.
  _fire(u, p, dist, onDamage, onMuzzle, onTracer) {
    const c = this.cfg;
    const inv = dist > 1e-6 ? 1 / dist : 0;
    const mx = u.pos.x + (p.x - u.pos.x) * inv * 0.6;
    const my = u.pos.y + 1.32;
    const mz = u.pos.z + (p.z - u.pos.z) * inv * 0.6;

    // базовое направление — в грудь; затем поворот на случайный малый угол
    const dir = this._t1.set(p.x - mx, p.y + 1.05 - my, p.z - mz).normalize();
    const spread = Math.tan(c.shotSpread * (this.rng() - 0.5) * 2);
    const roll = this.rng() * Math.PI * 2;
    const perp = this._t2.crossVectors(dir, UP).normalize(); // горизонтальная поперечина
    const rise = this._t3.crossVectors(perp, dir).normalize();
    dir.addScaledVector(perp, Math.cos(roll) * spread);
    dir.addScaledVector(rise, Math.sin(roll) * spread);
    dir.normalize();

    // луч прошёл рядом с «грудью» игрока — попадание; иначе промах мимо
    const rx = p.x - mx;
    const ry = p.y + 1.05 - my;
    const rz = p.z - mz;
    const tHit = rx * dir.x + ry * dir.y + rz * dir.z;
    let hit = false;
    if (tHit > 0 && tHit < c.shotRange) {
      const ox = rx - dir.x * tHit;
      const oy = ry - dir.y * tHit;
      const oz = rz - dir.z * tHit;
      hit = ox * ox + oy * oy + oz * oz <= c.hitRadius * c.hitRadius;
    }

    // след пули: оборвался в игроке или улетел мимо него
    const tEnd = hit ? tHit : Math.min(c.shotRange, dist + 8);
    onTracer(
      { x: mx, y: my, z: mz },
      { x: mx + dir.x * tEnd, y: my + dir.y * tEnd, z: mz + dir.z * tEnd },
    );
    onMuzzle({ x: mx, y: my, z: mz }, { x: dir.x, y: dir.y, z: dir.z });
    if (hit) onDamage(c.shotDamage, u.pos);

    u.burstLeft--;
    u.shotT = u.burstLeft > 0 ? c.burstInterval : c.burstPause;
    u.gunT = 0.12;
    u.aimT = c.aimTime; // очередь идёт без повторной пристрелки
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

  // Преграда под точкой: грид укрытий плюс баки — они живые и в грид не попадают.
  _blocked(x, z) {
    if (obstacleAt(this.covers, x, z, this.cfg.radius + 0.15)) return true;
    const bins = this.binList;
    if (!bins) return false;
    const r = this.cfg.radius + 0.4; // бак — круг радиусом с его основание
    for (let i = 0; i < bins.length; i++) {
      const dx = bins[i].pos.x - x;
      const dz = bins[i].pos.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  // Прямая видимость: точный отрезок против прямоугольников и кругов грида.
  // Короткие срезы у углов точечная проверка могла перескочить — стрелок видел сквозь угол.
  _los(x0, z0, x1, z1) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    if (dx === 0 && dz === 0) return true;
    const cell = this.covers.cell;
    const stamp = (this._losStamp = (this._losStamp | 0) + 1);
    const gx0 = Math.floor(Math.min(x0, x1) / cell);
    const gx1 = Math.floor(Math.max(x0, x1) / cell);
    const gz0 = Math.floor(Math.min(z0, z1) / cell);
    const gz1 = Math.floor(Math.max(z0, z1) / cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const bucket = this.covers.grid.get(gx + ':' + gz);
        if (!bucket) continue;
        for (const ob of bucket) {
          if (ob._lsStamp === stamp) continue; // одно препятствие — один раз
          ob._lsStamp = stamp;
          if (this._segHits(ob, x0, z0, dx, dz)) return false;
        }
      }
    }
    return true;
  }

  // Отрезок (x0,z0)+t·(dx,dz), t ∈ [0,1], задевает ли препятствие ob.
  _segHits(ob, x0, z0, dx, dz) {
    if (ob.rect) {
      let t0 = 0;
      let t1 = 1;
      const minX = ob.x - ob.e1;
      const maxX = ob.x + ob.e1;
      const minZ = ob.z - ob.e2;
      const maxZ = ob.z + ob.e2;
      if (Math.abs(dx) < 1e-9) {
        if (x0 < minX || x0 > maxX) return false;
      } else {
        let a = (minX - x0) / dx;
        let b = (maxX - x0) / dx;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) return false;
      }
      if (Math.abs(dz) < 1e-9) {
        if (z0 < minZ || z0 > maxZ) return false;
      } else {
        let a = (minZ - z0) / dz;
        let b = (maxZ - z0) / dz;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) return false;
      }
      return true;
    }
    // круг: расстояние от центра до отрезка меньше радиуса
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-12 ? ((ob.x - x0) * dx + (ob.z - z0) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x0 + dx * t - ob.x;
    const cz = z0 + dz * t - ob.z;
    return cx * cx + cz * cz < ob.e1 * ob.e1;
  }

  // Укрытие: точка за препятствием с противоположной от игрока стороны.
  _pickCover(u, p) {
    const c = this.cfg;
    let best = null;
    let bestScore = Infinity;
    cellsAround(this.covers, u.pos.x, u.pos.z, c.coverRange, (ob) => {
      let dx = ob.x - p.x;
      let dz = ob.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      // отходим от игрока через центр препятствия чуть дальше его края
      let out;
      if (ob.rect) {
        const tx = Math.abs(dx) > 1e-6 ? ob.e1 / Math.abs(dx) : Infinity;
        const tz = Math.abs(dz) > 1e-6 ? ob.e2 / Math.abs(dz) : Infinity;
        out = Math.min(tx, tz) + 0.7;
      } else {
        out = ob.e1 + 0.7;
      }
      const sx = ob.x + dx * out;
      const sz = ob.z + dz * out;
      const dNpc = Math.hypot(sx - u.pos.x, sz - u.pos.z);
      if (dNpc > c.coverRange) return;
      if (obstacleAt(this.covers, sx, sz, 0.3)) return; // место занято другим препятствием
      const between = Math.hypot(ob.x - p.x, ob.z - p.z) < Math.hypot(u.pos.x - p.x, u.pos.z - p.z);
      const score = dNpc + (between ? 0 : 8); // укрытие «между нами» приоритетнее
      if (score < bestScore) {
        bestScore = score;
        best = { x: sx, z: sz, ob }; // помним и само препятствие: по нему ищем точку выгляда
      }
    });
    return best;
  }

  // Точка у края укрытия, откуда игрока видно: стрелок высовывается и стреляет.
  // Кандидаты — углы и середины стен дома, точки по кругу у валуна/ствола.
  _pickPeek(u, p) {
    const ob = u.cover && u.cover.ob;
    if (!ob) return null;
    const limX = this.world.sizeX / 2 - 3;
    const limZ = this.world.sizeZ / 2 - 3;
    let best = null;
    let bestScore = Infinity;
    const consider = (x, z, side) => {
      if (Math.abs(x) > limX || Math.abs(z) > limZ) return;
      if (obstacleAt(this.covers, x, z, this.cfg.radius + 0.1)) return; // место занято другим препятствием
      if (!this._los(x, z, p.x, p.z)) return; // оттуда игрока не видно
      const dNpc = Math.hypot(x - u.pos.x, z - u.pos.z);
      if (dNpc > 12) return;
      const score = dNpc + (u.peekSide === side ? 0 : 2); // чаще выглядываем с той же стороны
      if (score < bestScore) {
        bestScore = score;
        best = { x, z, side };
      }
    };
    if (ob.rect) {
      const ex = ob.e1 + 0.7;
      const ez = ob.e2 + 0.7;
      consider(ob.x + ex, ob.z + ez, 1);
      consider(ob.x + ex, ob.z - ez, -1);
      consider(ob.x - ex, ob.z + ez, -1);
      consider(ob.x - ex, ob.z - ez, 1);
      consider(ob.x + ex, ob.z, 1);
      consider(ob.x - ex, ob.z, -1);
      consider(ob.x, ob.z + ez, 1);
      consider(ob.x, ob.z - ez, -1);
    } else {
      const r = ob.e1 + 0.7;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        consider(ob.x + Math.cos(a) * r, ob.z + Math.sin(a) * r, k % 2 ? -1 : 1);
      }
    }
    if (best) {
      u.peekSide = best.side;
      return { x: best.x, z: best.z };
    }
    return null;
  }

  // Случайная точка патруля радиуса radius вокруг центра: не в стенах, не за картой.
  _pickPatrol(center, radius) {
    const city = this.covers.city;
    const limX = this.world.sizeX / 2 - 4;
    const limZ = this.world.sizeZ / 2 - 4;
    for (let k = 0; k < 8; k++) {
      const a = this.rng() * Math.PI * 2;
      const r = 1.5 + this.rng() * radius;
      let x = center.x + Math.cos(a) * r;
      let z = center.z + Math.sin(a) * r;
      if (city && center.x > city.minX && center.x < city.maxX && center.z > city.minZ && center.z < city.maxZ) {
        x = Math.max(city.minX + 2, Math.min(city.maxX - 2, x)); // патруль держится города
        z = Math.max(city.minZ + 2, Math.min(city.maxZ - 2, z));
      }
      x = Math.max(-limX, Math.min(limX, x));
      z = Math.max(-limZ, Math.min(limZ, z));
      if (obstacleAt(this.covers, x, z, 0.8) || this._blocked(x, z)) continue; // стены и баки
      return { x, z };
    }
    return { x: center.x, z: center.z }; // зажаты стенами — стоим на месте
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
      u.peek = null;
      u.peekSide = 1;
      u.gaze = 0;
      u.hideT = 0;
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

// Собрать укрытия и стены в хеш-грид: дома (прямоугольники), крупные валуны и
// стволы деревьев (круги). По гриду NPC проверяет видимость, ищет укрытие и
// обходит препятствия. extra — готовые коробки не из layout (палатка лагеря).
// Чистая геометрия — гоняется headless-тестом.
export function buildCovers(cfg, layout, extra = []) {
  const cell = 8;
  const grid = new Map();
  for (const b of layout.buildings) {
    insertObstacle(grid, { rect: true, x: b.x, z: b.z, e1: b.w / 2, e2: b.d / 2 }, cell);
  }
  for (const r0 of layout.rocks) {
    if (!r0.big) continue;
    const r = Math.max(r0.sx, r0.sz) * 0.7;
    insertObstacle(grid, { rect: false, x: r0.x, z: r0.z, e1: r, e2: r }, cell);
  }
  for (const t of layout.trees) {
    const r = 0.3 * t.s; // крона высоко — взгляду мешает только ствол
    insertObstacle(grid, { rect: false, x: t.x, z: t.z, e1: r, e2: r }, cell);
  }
  // коробки построек вне layout (палатка лагеря): сквозь них NPC тоже не видит
  for (const b of extra) {
    insertObstacle(grid, {
      rect: true,
      x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2,
      e1: (b.maxX - b.minX) / 2, e2: (b.maxZ - b.minZ) / 2,
    }, cell);
  }
  return { grid, cell, city: layout.city ? { ...layout.city } : null };
}

// Препятствие под точкой (с запасом pad) или null.
function obstacleAt(covers, x, z, pad) {
  const bucket = covers.grid.get(Math.floor(x / covers.cell) + ':' + Math.floor(z / covers.cell));
  if (!bucket) return null;
  for (const ob of bucket) {
    const dx = Math.abs(x - ob.x);
    const dz = Math.abs(z - ob.z);
    if (ob.rect) {
      if (dx < ob.e1 + pad && dz < ob.e2 + pad) return ob;
    } else if (dx * dx + dz * dz < (ob.e1 + pad) * (ob.e1 + pad)) {
      return ob;
    }
  }
  return null;
}

// Обойти все препятствия в квадрате радиуса radius вокруг точки.
function cellsAround(covers, x, z, radius, cb) {
  const { cell, grid } = covers;
  const gx0 = Math.floor((x - radius) / cell);
  const gx1 = Math.floor((x + radius) / cell);
  const gz0 = Math.floor((z - radius) / cell);
  const gz1 = Math.floor((z + radius) / cell);
  const seen = new Set();
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gz = gz0; gz <= gz1; gz++) {
      const bucket = grid.get(gx + ':' + gz);
      if (!bucket) continue;
      for (const ob of bucket) {
        if (seen.has(ob)) continue;
        seen.add(ob);
        cb(ob);
      }
    }
  }
}

// Положить препятствие во все ячейки, которые накрывает его коробка.
function insertObstacle(grid, ob, cell) {
  const gx0 = Math.floor((ob.x - ob.e1) / cell);
  const gx1 = Math.floor((ob.x + ob.e1) / cell);
  const gz0 = Math.floor((ob.z - ob.e2) / cell);
  const gz1 = Math.floor((ob.z + ob.e2) / cell);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gz = gz0; gz <= gz1; gz++) {
      const key = gx + ':' + gz;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(ob);
    }
  }
}

// Тело NPC: куртка + ноги, один слитый меш; происхождение — на уровне ног.
// inflate — раздутие для тёмного контура силуэта (рисуется BackSide).
// Экспорт — лагерь дружелюбных переиспользует эту же геометрию для стоящих.
export function makeBodyGeometry(inflate = 0) {
  const torso = new THREE.BoxGeometry(0.52 + inflate, 0.78 + inflate, 0.3 + inflate);
  torso.translate(0, 1.11, 0);
  const legL = new THREE.BoxGeometry(0.18 + inflate, 0.72 + inflate, 0.2 + inflate);
  legL.translate(-0.13, 0.36, 0);
  const legR = legL.clone();
  legR.translate(0.26, 0, 0);
  return mergeGeometries([torso, legL, legR]);
}

function makeHeadGeometry(inflate = 0) {
  const head = new THREE.BoxGeometry(0.3 + inflate, 0.3 + inflate, 0.3 + inflate);
  head.translate(0, 1.66, 0);
  return head;
}

// «Лицо»: тёмная полоса глаз на передней грани головы (центр 1.66, грань +z на 0.15).
function makeFaceGeometry() {
  const face = new THREE.BoxGeometry(0.2, 0.05, 0.04);
  face.translate(0, 1.68, 0.16);
  return face;
}

// Лепесток веера зрения: единичный треугольник-луч угловой ширины span,
// центр — локальный +z. Масштаб инстанса задаёт длину луча, разворот — направление.
function makeVisionSlice(span) {
  const half = span / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    Math.sin(-half), 0, Math.cos(-half),
    Math.sin(half), 0, Math.cos(half),
  ], 3));
  g.setIndex([0, 1, 2]);
  return g;
}

// Палка: происхождение у кисти, растёт вверх.
function makeStickGeometry() {
  const g = new THREE.CylinderGeometry(0.035, 0.05, 1.05, 5);
  g.translate(0, 0.5, 0);
  return g;
}

// Пистолет: ствол вперёд и рукоятка вниз, происхождение — у кисти.
function makeGunGeometry() {
  const barrel = new THREE.BoxGeometry(0.07, 0.09, 0.32);
  barrel.translate(0, 0.03, 0.13);
  const grip = new THREE.BoxGeometry(0.06, 0.16, 0.09);
  grip.translate(0, -0.09, 0.01);
  return mergeGeometries([barrel, grip]);
}
