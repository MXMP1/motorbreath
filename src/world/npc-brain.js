import * as THREE from 'three';
import { resolveCircleAabb } from '../core/collide.js';

const UP = new THREE.Vector3(0, 1, 0);

// Мозг NPC: решения, движение и атаки. Ни одного меша — только математика и
// состояние юнита, поэтому гоняется headless-тестом напрямую.
//
// Цель — абстрактная «угроза» (позиция + куда адресовать урон): им может быть и
// игрок, и спутник игрока, поэтому решения не знают, по кому конкретно воюют.
//
// Зрение — строго конус (visionAngle): вне него NPC слеп, за спину можно подойти
// вплотную; внутри конуса стены и валуны режут взгляд, как свет (covers.los).
// Зоны контакта:
//   1) видит угрозу: палочник дожимает и бьёт, стрелок стоит и ведёт очередь,
//      отстрелялся — отходит за укрытие;
//   2) потерял из вида: стрелок держит свой забронированный угол и смотрит туда,
//      где видел цель — шагнул на угол, конус уже наведён; палочник идёт к месту
//      контакта. Терпение кончилось — все идут прочёсывать район находки;
//   3) вне видимости и контакта не было: реакции нет, обычный патруль у дома.
export class NpcBrain {
  constructor(cfg, world, covers, rng) {
    this.cfg = cfg;
    this.world = world; // { heightmap, colliders, sizeX, sizeZ, cityLift }
    this.covers = covers;
    this.rng = rng;
    // косинус полуугла конуса зрения: угол из конфига в градусах
    this._cosHalf = Math.cos((cfg.visionAngle * Math.PI) / 360);
    // баки — живые коллайдеры вне грида укрытий: «щупальце» и патруль должны их видеть
    this.binList = (world.bins && world.bins.units) || null;

    this._t1 = new THREE.Vector3(); // разброс выстрела: направление и поперечины
    this._t2 = new THREE.Vector3();
    this._t3 = new THREE.Vector3();
  }

  groundAt(x, z) {
    const lift = this.world.cityLift ? this.world.cityLift(x, z) : 0;
    return this.world.heightmap.heightAt(x, z) + lift;
  }

  // Видит ли юнит точку прямо сейчас: дистанция, конус зрения и прямая видимость.
  // Зовётся и мозгом (sees), и выбором цели — проверка одна на всех.
  canSee(u, x, z, vision) {
    const dx = x - u.pos.x;
    const dz = z - u.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > vision) return false;
    // зрение — строго зелёный конус (F3): вне его NPC слеп, за спину можно подойти
    // вплотную; статист смотрит с учётом сканирования головой
    const yawG = u.yaw + u.gaze;
    if (Math.sin(yawG) * dx + Math.cos(yawG) * dz < dist * this._cosHalf) return false;
    return this.covers.los(u.pos.x, u.pos.z, x, z); // стены и валуны режут взгляд, как свет
  }

  // В пределах ли точка зрения и прямой видимости (конус не важен): так юнит
  // держит прошлую угрозу, даже если она пока за краем обзора.
  inSight(u, x, z, vision) {
    if (Math.hypot(x - u.pos.x, z - u.pos.z) > vision) return false;
    return this.covers.los(u.pos.x, u.pos.z, x, z);
  }

  // Решение по зонам контакта; вызывается раз в thinkInterval.
  // p — позиция текущей угрозы, vision — её дальность обнаружения (присевшего
  // игрока замечают хуже), а не полная из конфига.
  think(u, p, vision) {
    const c = this.cfg;
    const visible = this.canSee(u, p.x, p.z, vision);
    u.sees = visible;
    if (visible) {
      u.aware = true;
      u.lastKnown = { x: p.x, z: p.z }; // вижу — запоминаю, где угроза
      u.lostT = 0;
    } else if (u.aware) {
      u.lostT += c.thinkInterval; // сколько не видим: терпение у угла не вечно
    }
    if (!u.aware) {
      u.state = 'patrol';
      return;
    }
    if (u.weapon === 'stick') this._thinkStick(u, p, visible);
    else this._thinkGunner(u, p, visible);
  }

  // Палочник: укрытия ему не нужны. Видит — сближается и бьёт, потерял —
  // прочёсывает место контакта.
  _thinkStick(u, p, visible) {
    const c = this.cfg;
    if (visible) {
      const dist = Math.hypot(p.x - u.pos.x, p.z - u.pos.z);
      u.state = dist <= c.closeRange ? 'close' : 'medium';
      u.target = { x: p.x, z: p.z };
      return;
    }
    u.state = 'search';
    if (u.lastKnown) u.target = { x: u.lastKnown.x, z: u.lastKnown.z };
  }

  // Стрелок: укрытие, забронированный угол и очереди.
  //   видит     — стоим и стреляем; очередь кончилась — отход к укрытию;
  //   потерял   — держим свой угол (нет угла — бронируем, все заняты — в затылок
  //               товарищу) и смотрим туда, где видели цель;
  //   терпение кончилось — угол освобождаем и идём к месту контакта.
  _thinkGunner(u, p, visible) {
    const c = this.cfg;
    if (visible) {
      const dist = Math.hypot(p.x - u.pos.x, p.z - u.pos.z);
      u.state = dist <= c.closeRange ? 'close' : 'medium';
      this._keepCover(u, p);
      // прятаться негде (чистое поле) — идём на сближение
      if (!u.cover) {
        u.toCover = false;
        u.target = { x: p.x, z: p.z };
        return;
      }
      // в очереди стоим на месте, отстрелялись — отходим за укрытие
      u.toCover = u.burstLeft <= 0;
      u.target = u.toCover ? { x: u.cover.x, z: u.cover.z } : null;
      return;
    }

    // Отход к укрытию и выход на забронированный угол — действия завершённые:
    // обегать здание дольше терпения, поэтому потеря цели их не обрывает (иначе
    // стрелок мечется на полпути: не успевает ни спрятаться, ни выстрелить).
    // Совсем потерял цель (giveUp) — бросает и укрытие, и угол.
    const giveUp = c.lostPatience * 3;
    u.state = 'hold';
    if (u.toCover && u.cover && u.lostT <= giveUp) {
      u.target = { x: u.cover.x, z: u.cover.z };
      if (this._near(u, u.cover, 1.0)) u.toCover = false; // дошли — можно выглянуть снова
      return;
    }
    if (u.spot && !this._near(u, u.spot, 0.6) && u.lostT <= giveUp) {
      u.target = { x: u.spot.x, z: u.spot.z };
      return;
    }

    if (u.lostT <= c.lostPatience) {
      // на своём углу: стоим и смотрим туда, где видели цель (разворот — в move);
      // увидим — act сразу откроет огонь
      if (u.spot) {
        u.target = null;
        return;
      }
      this._keepCover(u, p);
      if (u.cover) {
        // за укрытием и очередь ещё не готова: пережидаем, не высовываясь
        if (u.shotT > 0 && this._near(u, u.cover, 1.2)) {
          u.target = null;
          return;
        }
        const spot = this.covers.claimSpot(u, u.cover.ob, p.x, p.z, c.spotRange);
        if (spot) {
          u.target = { x: spot.x, z: spot.z };
          return;
        }
        // углы разобрали товарищи: ждём очереди за спиной того, кто выглядывает
        const queue = this.covers.queueSpot(u, u.cover.ob, c.queueDist);
        u.target = queue || { x: u.cover.x, z: u.cover.z };
        return;
      }
    } else {
      // долго не видим: бросаем угол и укрытие, идём прочёсывать место контакта
      this.covers.releaseSpot(u);
      u.cover = null;
      u.toCover = false;
    }
    u.state = 'search';
    // известно место угрозы — идём туда; иначе цель не трогаем: патрульная точка
    // района поиска держится до прибытия, а не перескакивает каждый тик
    if (u.lastKnown) u.target = { x: u.lastKnown.x, z: u.lastKnown.z };
  }

  // Укрытие держим, пока угроза там же, откуда мы его выбирали: ушла больше чем
  // на 6 м — ищем новое, прежний угол освобождаем товарищам.
  _keepCover(u, p) {
    if (u.cover && (Math.abs(p.x - u.coverFrom.x) > 6 || Math.abs(p.z - u.coverFrom.z) > 6)) {
      u.cover = null;
      u.toCover = false;
      this.covers.releaseSpot(u);
    }
    if (!u.cover) {
      u.cover = this.pickCover(u, p);
      if (u.cover) u.coverFrom = { x: p.x, z: p.z };
    }
  }

  _near(u, pt, r) {
    return Math.hypot(pt.x - u.pos.x, pt.z - u.pos.z) < r;
  }

  move(u, dt, p) {
    const c = this.cfg;
    u.pauseT = Math.max(0, u.pauseT - dt);

    // патрульная точка, когда идти некуда: у дома — спокойный обход,
    // после поиска — широкий район вокруг места находки
    // статисты не патрулируют: стоят на месте, пока не заметили игрока
    if (!u.target && u.pauseT <= 0 && (!u.static || u.aware) && (u.state === 'patrol' || u.state === 'search')) {
      const wide = u.aware && u.searchCenter;
      u.target = this.pickPatrol(wide ? u.searchCenter : u.home, wide ? c.searchPatrolRadius : c.patrolRadius);
    }

    let dirx = 0;
    let dirz = 0;
    if (u.target) {
      const dx = u.target.x - u.pos.x;
      const dz = u.target.z - u.pos.z;
      const d = Math.hypot(dx, dz);
      // к забронированному углу подходим вплотную: стрельба идёт точно с края укрытия
      const arrive = u.spot && u.target.x === u.spot.x && u.target.z === u.spot.z ? 0.25 : 0.8;
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
      if (this.blocked(u.pos.x + dirx * ahead, u.pos.z + dirz * ahead)) {
        let free = false;
        for (const a of [0.9, -0.9, 1.7, -1.7, 2.4, -2.4]) {
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const rx = dirx * ca - dirz * sa;
          const rz = dirx * sa + dirz * ca;
          if (!this.blocked(u.pos.x + rx * ahead, u.pos.z + rz * ahead)) {
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

    // разворот: видим угрозу — на неё; не видим, но контакт был — туда, где видели
    // в последний раз (стоим за стеной «спиной к стене», шагнули на угол — конус
    // уже наведён); иначе — по ходу движения. Спокойный патруль доворачивается медленно
    let want = null;
    if (u.sees) want = Math.atan2(p.x - u.pos.x, p.z - u.pos.z);
    else if (u.aware && u.lastKnown) want = Math.atan2(u.lastKnown.x - u.pos.x, u.lastKnown.z - u.pos.z);
    else if (dirx || dirz) want = Math.atan2(dirx, dirz);
    if (want !== null) {
      const delta = Math.atan2(Math.sin(want - u.yaw), Math.cos(want - u.yaw));
      const mx = (u.aware ? c.turnSpeed : c.patrolTurnSpeed) * dt;
      u.yaw += Math.abs(delta) <= mx ? delta : Math.sign(delta) * mx;
    }
  }

  // Атаки: палка — взмах с уроном в середине дуги; пистолет — очереди 2–4 выстрела.
  act(u, dt, p, onDamage, onMuzzle, onTracer) {
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
          if (u.aimT >= c.aimTime && u.shotT <= 0) this.fire(u, p, dist, onDamage, onMuzzle, onTracer);
        }
      }
    }
  }

  // Выстрел: прицел в грудь игрока плюс разброс — NPC мажут, и это видно по следу.
  fire(u, p, dist, onDamage, onMuzzle, onTracer) {
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

  // Преграда под точкой: грид укрытий плюс баки — они живые и в грид не попадают.
  blocked(x, z) {
    if (this.covers.obstacleAt(x, z, this.cfg.radius + 0.15)) return true;
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

  // Укрытие: точка за препятствием с противоположной от игрока стороны.
  pickCover(u, p) {
    const c = this.cfg;
    let best = null;
    let bestScore = Infinity;
    this.covers.cellsAround(u.pos.x, u.pos.z, c.coverRange, (ob) => {
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
      if (this.covers.obstacleAt(sx, sz, 0.3)) return; // место занято другим препятствием
      const between = Math.hypot(ob.x - p.x, ob.z - p.z) < Math.hypot(u.pos.x - p.x, u.pos.z - p.z);
      let score = dNpc + (between ? 0 : 8); // укрытие «между нами» приоритетнее
      if (!this.covers.hasFreeSpot(ob)) score += 6; // углы разобрали — ищем другое укрытие
      if (score < bestScore) {
        bestScore = score;
        best = { x: sx, z: sz, ob }; // помним и само препятствие: по нему ищем точку выгляда
      }
    });
    return best;
  }

  // Случайная точка патруля радиуса radius вокруг центра: не в стенах, не за картой.
  pickPatrol(center, radius) {
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
      if (this.covers.obstacleAt(x, z, 0.8) || this.blocked(x, z)) continue; // стены и баки
      return { x, z };
    }
    return { x: center.x, z: center.z }; // зажаты стенами — стоим на месте
  }
}
