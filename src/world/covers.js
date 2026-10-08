// Укрытия мира: хеш-грид препятствий (дома, валуны, стволы, палатка) и вся
// геометрия вокруг них — прямая видимость, дальность луча, точки выгляда.
// Чистая математика: ни three, ни DOM, поэтому гоняется headless-тестом.

const CELL = 8; // сторона ячейки грида, м

export class Covers {
  constructor(cell = CELL, city = null) {
    this.grid = new Map();     // "gx:gz" -> препятствия, накрывающие ячейку
    this.cell = cell;
    this.city = city;          // границы города: патруль держится внутри
    this.obstacles = [];       // все препятствия подряд (бронь точек выгляда)
    this._losStamp = 0;        // метки проходов: одно препятствие проверяем один раз
    this._castStamp = 0;
  }

  // Препятствие: rect — коробка (e1/e2 — полуоси x/z), иначе круг радиуса e1.
  insert(ob) {
    this.obstacles.push(ob);
    const gx0 = Math.floor((ob.x - ob.e1) / this.cell);
    const gx1 = Math.floor((ob.x + ob.e1) / this.cell);
    const gz0 = Math.floor((ob.z - ob.e2) / this.cell);
    const gz1 = Math.floor((ob.z + ob.e2) / this.cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = gx + ':' + gz;
        let bucket = this.grid.get(key);
        if (!bucket) {
          bucket = [];
          this.grid.set(key, bucket);
        }
        bucket.push(ob);
      }
    }
    return ob;
  }

  // Препятствие под точкой (с запасом pad) или null.
  obstacleAt(x, z, pad) {
    const bucket = this.grid.get(Math.floor(x / this.cell) + ':' + Math.floor(z / this.cell));
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
  cellsAround(x, z, radius, cb) {
    const gx0 = Math.floor((x - radius) / this.cell);
    const gx1 = Math.floor((x + radius) / this.cell);
    const gz0 = Math.floor((z - radius) / this.cell);
    const gz1 = Math.floor((z + radius) / this.cell);
    const seen = new Set();
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const bucket = this.grid.get(gx + ':' + gz);
        if (!bucket) continue;
        for (const ob of bucket) {
          if (seen.has(ob)) continue;
          seen.add(ob);
          cb(ob);
        }
      }
    }
  }

  // Прямая видимость: точный отрезок против прямоугольников и кругов грида.
  // Короткие срезы у углов точечная проверка могла перескочить — стрелок видел сквозь угол.
  los(x0, z0, x1, z1) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    if (dx === 0 && dz === 0) return true;
    const stamp = (this._losStamp = (this._losStamp | 0) + 1);
    const gx0 = Math.floor(Math.min(x0, x1) / this.cell);
    const gx1 = Math.floor(Math.max(x0, x1) / this.cell);
    const gz0 = Math.floor(Math.min(z0, z1) / this.cell);
    const gz1 = Math.floor(Math.max(z0, z1) / this.cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const bucket = this.grid.get(gx + ':' + gz);
        if (!bucket) continue;
        for (const ob of bucket) {
          if (ob._lsStamp === stamp) continue; // одно препятствие — один раз
          ob._lsStamp = stamp;
          if (segHitT(ob, x0, z0, dx, dz) >= 0) return false;
        }
      }
    }
    return true;
  }

  // Дальность луча по азимуту angle: первое препятствие на пути — там луч гаснет.
  // Зовётся отладочным веером зрения (F3): каждый лепесток упирается в стену.
  cast(x0, z0, angle, max) {
    const dx = Math.sin(angle) * max;
    const dz = Math.cos(angle) * max;
    const stamp = (this._castStamp = (this._castStamp | 0) + 1);
    let best = 1; // ближайшее препятствие как t отрезка [0..1]
    const gx0 = Math.floor(Math.min(x0, x0 + dx) / this.cell);
    const gx1 = Math.floor(Math.max(x0, x0 + dx) / this.cell);
    const gz0 = Math.floor(Math.min(z0, z0 + dz) / this.cell);
    const gz1 = Math.floor(Math.max(z0, z0 + dz) / this.cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const bucket = this.grid.get(gx + ':' + gz);
        if (!bucket) continue;
        for (const ob of bucket) {
          if (ob._castStamp === stamp) continue; // одно препятствие — один раз
          ob._castStamp = stamp;
          const t = segHitT(ob, x0, z0, dx, dz);
          if (t >= 0 && t < best) best = t;
        }
      }
    }
    return best * max;
  }

  // ---------- точки выгляда: бронь углов, чтобы стрелки не толпились ----------

  // Кандидаты у краёв препятствия: углы и середины стен у коробки, 8 точек по
  // кругу у ствола/валуна. Считаются один раз и кешируются в самом препятствии.
  spots(ob) {
    if (ob._spots) return ob._spots;
    const out = [];
    const push = (x, z) => {
      if (this.obstacleAt(x, z, 0.3)) return; // внутри другого препятствия — не годится
      out.push({ x, z, ob, owner: null });
    };
    if (ob.rect) {
      const ex = ob.e1 + 0.7;
      const ez = ob.e2 + 0.7;
      push(ob.x + ex, ob.z + ez);
      push(ob.x + ex, ob.z - ez);
      push(ob.x - ex, ob.z + ez);
      push(ob.x - ex, ob.z - ez);
      push(ob.x + ex, ob.z);
      push(ob.x - ex, ob.z);
      push(ob.x, ob.z + ez);
      push(ob.x, ob.z - ez);
    } else {
      const r = ob.e1 + 0.7;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        push(ob.x + Math.cos(a) * r, ob.z + Math.sin(a) * r);
      }
    }
    ob._spots = out;
    return out;
  }

  // Есть ли у препятствия свободная точка выгляда: укрытие, где все углы заняты,
  // стрелки делят неохотно — второй ищет другое или встаёт в затылок первому.
  hasFreeSpot(ob) {
    for (const s of this.spots(ob)) {
      if (s.owner === null) return true;
    }
    return false;
  }

  // Занять свободную точку выгляда у препятствия ob, откуда видна цель (tx, tz):
  // ближайшая к юниту и не дальше maxDist. Точка коммитится и не пересчитывается,
  // пока занята, — иначе стрелок мечется между углами и не успевает выстрелить.
  claimSpot(u, ob, tx, tz, maxDist = Infinity) {
    if (!ob) return null;
    let best = null;
    let bestD = Infinity;
    for (const s of this.spots(ob)) {
      if (s.owner !== null) continue;
      const d = Math.hypot(s.x - u.pos.x, s.z - u.pos.z);
      if (d > maxDist || d >= bestD) continue;
      if (!this.los(s.x, s.z, tx, tz)) continue; // оттуда цель не видна
      best = s;
      bestD = d;
    }
    if (!best) return null;
    best.owner = u;
    u.spot = best;
    return best;
  }

  releaseSpot(u) {
    if (u.spot) u.spot.owner = null;
    u.spot = null;
  }

  // Все точки заняты: встаём в затылок тому, кто выглядывает, и ждём очереди.
  // ob — укрытие, у которого не осталось свободных углов.
  queueSpot(u, ob, back = 0.95) {
    let s = u.spot && u.spot.owner ? u.spot : null;
    if (!s && ob) {
      for (const c of this.spots(ob)) {
        if (c.owner && c.owner !== u) { s = c; break; }
      }
    }
    if (!s) return null;
    const o = s.owner;
    let dx = s.x - o.pos.x;
    let dz = s.z - o.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) { dx = 0; dz = 1; } else { dx /= d; dz /= d; } // от цели — за спину
    return { x: o.pos.x - dx * back, z: o.pos.z - dz * back };
  }

  // Снять все брони (клавиша R: юниты вернулись на места, углы снова свободны).
  releaseAll() {
    for (const ob of this.obstacles) {
      if (!ob._spots) continue;
      for (const s of ob._spots) s.owner = null;
    }
  }
}

// Первое пересечение отрезка (x0,z0)+t·(dx,dz), t ∈ [0,1], с препятствием; -1 — мимо.
// Один тест на оба случая: видимость (нужен факт) и луч веера (нужна дальность).
function segHitT(ob, x0, z0, dx, dz) {
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

// Собрать укрытия и стены в грид: дома (прямоугольники), крупные валуны и
// стволы деревьев (круги). extra — готовые коробки не из layout (палатка лагеря).
export function buildCovers(cfg, layout, extra = []) {
  const covers = new Covers(CELL, layout.city ? { ...layout.city } : null);
  for (const b of layout.buildings) {
    covers.insert({ rect: true, x: b.x, z: b.z, e1: b.w / 2, e2: b.d / 2 });
  }
  for (const r0 of layout.rocks) {
    if (!r0.big) continue;
    const r = Math.max(r0.sx, r0.sz) * 0.7;
    covers.insert({ rect: false, x: r0.x, z: r0.z, e1: r, e2: r });
  }
  for (const t of layout.trees) {
    const r = 0.3 * t.s; // крона высоко — взгляду мешает только ствол
    covers.insert({ rect: false, x: t.x, z: t.z, e1: r, e2: r });
  }
  // коробки построек вне layout (палатка лагеря): сквозь них NPC тоже не видит
  for (const b of extra) {
    covers.insert({
      rect: true,
      x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2,
      e1: (b.maxX - b.minX) / 2, e2: (b.maxZ - b.minZ) / 2,
    });
  }
  return covers;
}
