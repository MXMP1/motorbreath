import { createHeightmap } from './heightmap.js';
import { mulberry32 } from '../core/noise.js';

// Расстановка всего, что стоит на карте: город (дома, знаки, баки, мешки),
// зелёная зона (лес, кусты, камни) и манекены у спавна.
// Карта делится на две зоны: городскую прямоугольную и зелёную с буферной
// полосой между ними. Чистая логика без three — гоняется headless-тестом.
export function buildLayout(cfg) {
  const rng = mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0);
  const heightmap = createHeightmap(cfg.world);
  const { size } = cfg.world;
  const half = size / 2;
  const city = cfg.city;
  const cityRect = {
    minX: city.cx - city.halfW, maxX: city.cx + city.halfW,
    minZ: city.cz - city.halfD, maxZ: city.cz + city.halfD,
  };
  const inCity = (x, z, margin) =>
    x > cityRect.minX - margin && x < cityRect.maxX + margin &&
    z > cityRect.minZ - margin && z < cityRect.maxZ + margin;
  const inRect = (x, z, inset) =>
    x > cityRect.minX + inset && x < cityRect.maxX - inset &&
    z > cityRect.minZ + inset && z < cityRect.maxZ - inset;

  const buildings = [];
  const trees = [];
  const bushes = [];
  const rocks = [];
  const dummies = [];
  const signs = [];
  const bins = [];
  const bags = [];

  const range = (spec) => spec[0] + rng() * (spec[1] - spec[0]);

  // --- дома: сетка кварталов внутри городской зоны (город целиком стоит в долине)
  const kinds = [
    ...Array(cfg.layout.tallBuildings).fill('tall'),
    ...Array(cfg.layout.lowBuildings).fill('low'),
  ];
  const SIZES = {
    tall: { w: [6, 10], d: [6, 10], h: [14, 24] },
    low: { w: [8, 14], d: [6, 11], h: [3, 5.5] },
  };

  const COLS = 4;
  const ROWS = 3;
  const plotW = (cityRect.maxX - cityRect.minX) / COLS;
  const plotD = (cityRect.maxZ - cityRect.minZ) / ROWS;
  const plots = [];
  for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) plots.push({ i, j });
  for (let i = plots.length - 1; i > 0; i--) { // детерминированная перестановка кварталов
    const j = (rng() * (i + 1)) | 0;
    [plots[i], plots[j]] = [plots[j], plots[i]];
  }

  kinds.forEach((kind, k) => {
    const s = SIZES[kind];
    const plot = plots[k % plots.length];
    for (let attempt = 0; attempt < 80; attempt++) {
      const w = range(s.w);
      const d = range(s.d);
      const h = range(s.h);
      const px = cityRect.minX + (plot.i + 0.5) * plotW + (rng() * 2 - 1) * 3;
      const pz = cityRect.minZ + (plot.j + 0.5) * plotD + (rng() * 2 - 1) * 3;
      // дом обязан целиком поместиться в городскую зону
      const x = Math.max(cityRect.minX + w / 2, Math.min(cityRect.maxX - w / 2, px));
      const z = Math.max(cityRect.minZ + d / 2, Math.min(cityRect.maxZ - d / 2, pz));

      // участок должен быть ровным: разброс высот по углам фундамента < 1.2 м
      if (cornerSpread(x, z, w, d, heightmap) > 1.2) continue;
      if (heightmap.slopeAt(x, z) >= 0.3) continue;
      // не пересекаемся с уже поставленными домами (запас 6 м)
      if (overlapsAny(x, z, w + 6, d + 6, buildings)) continue;

      buildings.push({ kind, x, z, w, d, h, ground: heightmap.heightAt(x, z) });
      break;
    }
  });

  const liftAt = makeCityLift(cfg, buildings); // высота покрытия под ногами в городе

  // --- дорожные знаки: стоят у края «дороги» — на отступе от сеточных линий кварталов
  const SIGN_TYPES = ['limit', 'crossing', 'warn'];
  const edge = cfg.street.signEdge; // отступ от оси улицы к её краю, м
  const signSpots = [];
  for (let i = 1; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      signSpots.push({
        axis: 'x',
        fixed: cityRect.minX + i * plotW,
        side: (i + j) % 2 ? 1 : -1, // какой край улицы предпочтительнее
        x: cityRect.minX + i * plotW,
        z: cityRect.minZ + (j + 0.3 + rng() * 0.4) * plotD,
        ry: (rng() < 0.5 ? 1 : -1) * Math.PI / 2,
      });
    }
  }
  for (let j = 1; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      signSpots.push({
        axis: 'z',
        fixed: cityRect.minZ + j * plotD,
        side: (i + j) % 2 ? -1 : 1,
        x: cityRect.minX + (i + 0.3 + rng() * 0.4) * plotW,
        z: cityRect.minZ + j * plotD,
        ry: rng() < 0.5 ? 0 : Math.PI,
      });
    }
  }
  for (const spot of signSpots) {
    if (signs.length >= cfg.layout.signs) break;
    if (rng() > 0.78) continue; // улицы без «частокола» из знаков
    // сначала предпочтительный край улицы, если он занят — противоположный
    for (const side of [spot.side, -spot.side]) {
      const x = spot.axis === 'x' ? spot.fixed + side * edge : spot.x;
      const z = spot.axis === 'x' ? spot.z : spot.fixed + side * edge;
      if (!inRect(x, z, 2)) continue;
      if (overlapsAny(x, z, 2.4, 2.4, buildings)) continue;
      if (signs.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 7 ** 2)) continue;
      signs.push({
        x, z,
        y: heightmap.heightAt(x, z) + liftAt(x, z),
        ry: spot.ry,
        type: SIGN_TYPES[(rng() * SIGN_TYPES.length) | 0],
      });
      break;
    }
  }

  // --- мусорные баки: жмутся к стенам домов, стоят на тротуарах
  for (let i = 0; i < cfg.layout.bins; i++) {
    for (let attempt = 0; attempt < 40 && buildings.length > 0; attempt++) {
      const b = buildings[(rng() * buildings.length) | 0];
      const side = (rng() * 4) | 0;
      const off = 1.15; // отступ от стены
      let x, z;
      if (side === 0) { x = b.x + (rng() * 2 - 1) * Math.max(0, b.w / 2 - 0.7); z = b.z + b.d / 2 + off; }
      else if (side === 1) { x = b.x + (rng() * 2 - 1) * Math.max(0, b.w / 2 - 0.7); z = b.z - b.d / 2 - off; }
      else if (side === 2) { z = b.z + (rng() * 2 - 1) * Math.max(0, b.d / 2 - 0.7); x = b.x + b.w / 2 + off; }
      else { z = b.z + (rng() * 2 - 1) * Math.max(0, b.d / 2 - 0.7); x = b.x - b.w / 2 - off; }

      if (!inRect(x, z, 1.5)) continue;
      if (overlapsAny(x, z, 1.2, 1.2, buildings)) continue;
      if (bins.some((bn) => (bn.x - x) ** 2 + (bn.z - z) ** 2 < 1.7 ** 2)) continue;
      if (signs.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 0.8 ** 2)) continue;

      bins.push({
        x, z,
        y: heightmap.heightAt(x, z) + liftAt(x, z),
        ry: rng() * Math.PI * 2,
        tint: 0.85 + rng() * 0.35,
      });
      break;
    }
  }

  // --- мусорные мешки: кучки у баков + одиночки; лёгкие — их можно пинать
  const bagsTarget = cfg.layout.bags;
  const makeBag = (x, z) => ({
    x, z,
    y: heightmap.heightAt(x, z) + liftAt(x, z),
    s: 0.7 + rng() * 0.35,
    ry: rng() * Math.PI * 2,
    rx: (rng() - 0.5) * 0.24,
    rz: (rng() - 0.5) * 0.24,
    tint: 0.75 + rng() * 0.5,
  });
  for (const bin of bins) {
    const n = 2 + ((rng() * 3) | 0); // 2..4 мешка у бака
    for (let k = 0; k < n && bags.length < bagsTarget; k++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const a = rng() * Math.PI * 2;
        const d = 0.8 + rng() * 1.5;
        const x = bin.x + Math.cos(a) * d;
        const z = bin.z + Math.sin(a) * d;
        if (!inRect(x, z, 1.2)) continue;
        if (overlapsAny(x, z, 1, 1, buildings)) continue;
        if (bins.some((bn) => (bn.x - x) ** 2 + (bn.z - z) ** 2 < 0.85 ** 2)) continue;
        if (signs.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 0.6 ** 2)) continue;
        bags.push(makeBag(x, z));
        break;
      }
    }
  }
  for (let i = 0; bags.length < bagsTarget && i < bagsTarget * 30; i++) {
    const x = cityRect.minX + 2 + rng() * (cityRect.maxX - cityRect.minX - 4);
    const z = cityRect.minZ + 2 + rng() * (cityRect.maxZ - cityRect.minZ - 4);
    if (overlapsAny(x, z, 1.4, 1.4, buildings)) continue;
    if (bins.some((bn) => (bn.x - x) ** 2 + (bn.z - z) ** 2 < 1.4 ** 2)) continue;
    if (signs.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 0.8 ** 2)) continue;
    if (bags.some((bg) => (bg.x - x) ** 2 + (bg.z - z) ** 2 < 1.2 ** 2)) continue;
    bags.push(makeBag(x, z));
  }

  // --- деревья: только зелёная зона; сетка минимальной дистанции через хеш-грид
  const GRID = 4;
  const treeGrid = new Map();
  const target = cfg.layout.trees;
  const treeScale = cfg.layout.treeScale;
  for (let i = 0; i < target * 14 && trees.length < target; i++) {
    const x = (rng() * 2 - 1) * (half - 12);
    const z = (rng() * 2 - 1) * (half - 12);
    const r = Math.hypot(x, z);
    if (r < 18) continue;              // у спавна лес не сажаем
    if (r > size * 0.42) continue;     // выше в горы не лезем
    if (heightmap.slopeAt(x, z) > 0.55) continue;  // на кручах не растут
    if (inCity(x, z, city.margin)) continue;       // лес в город не заходит
    if (overlapsAny(x, z, 5, 5, buildings)) continue;
    if (nearAny(treeGrid, x, z, 4.6, GRID)) continue; // кроны крупные — дистанция больше

    const tree = {
      x, z,
      y: heightmap.heightAt(x, z),
      s: treeScale[0] + rng() * (treeScale[1] - treeScale[0]),
      rot: rng() * Math.PI * 2,
      tint: 0.7 + rng() * 0.6,
    };
    trees.push(tree);
    gridPush(treeGrid, x, z, tree, GRID);
  }

  // --- манекены: кольцо вокруг точки спавна (зелёная зона)
  for (let i = 0; i < cfg.layout.dummies; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ang = (i / cfg.layout.dummies) * Math.PI * 2 + rng() * 0.8;
      const dist = 7 + rng() * 5;
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      if (overlapsAny(x, z, 2.5, 2.5, buildings)) continue;
      dummies.push({ x, z, y: heightmap.heightAt(x, z), rot: ang + Math.PI });
      break;
    }
  }

  // --- кусты: зелёная зона; растут подлеском у деревьев, одиночки — редкость
  const bushTarget = cfg.layout.bushes;
  const BGRID = 3;
  const bushGrid = new Map();
  for (let i = 0; i < bushTarget * 24 && bushes.length < bushTarget; i++) {
    const x = (rng() * 2 - 1) * (half - 12);
    const z = (rng() * 2 - 1) * (half - 12);
    const r = Math.hypot(x, z);
    if (r < 10) continue;                          // у спавна чисто
    if (r > size * 0.42) continue;
    if (heightmap.slopeAt(x, z) > 0.5) continue;
    if (inCity(x, z, city.margin)) continue;       // кусты в город не лезут
    if (overlapsAny(x, z, 3, 3, buildings)) continue;
    if (nearAny(treeGrid, x, z, 2.0, GRID)) continue;   // не в стволах
    if (nearAny(bushGrid, x, z, 2.2, BGRID)) continue;  // куст к кусту не вплотную
    if (dummies.some((dd) => (dd.x - x) ** 2 + (dd.z - z) ** 2 < 2.5 ** 2)) continue;
    // подлесок: без дерева поблизости куст прорастает лишь в четверти случаев
    if (rng() > 0.25 && !nearAny(treeGrid, x, z, 9, GRID, 3)) continue;

    const bush = {
      x, z,
      y: heightmap.heightAt(x, z),
      s: 0.6 + rng() * 0.7,
      rot: rng() * Math.PI * 2,
      tint: 0.8 + rng() * 0.35,
    };
    bushes.push(bush);
    gridPush(bushGrid, x, z, bush, BGRID);
  }

  // --- камни: валуны и мелкая россыпь по зелёной зоне и предгорьям
  const RGRID = 4;
  const rockGrid = new Map();
  const rockSpec = cfg.layout.rocks;

  function scatterRocks(big, count) {
    let placed = 0;
    const sMin = big ? 1.1 : 0.22;
    const sMax = big ? 2.1 : 0.65;
    const slopeMax = big ? 1.0 : 0.8;   // камни терпят кручи, деревья — нет
    const rMax = size * (big ? 0.47 : 0.42);
    for (let i = 0; i < count * 16 && placed < count; i++) {
      const x = (rng() * 2 - 1) * (half - 8);
      const z = (rng() * 2 - 1) * (half - 8);
      const r = Math.hypot(x, z);
      if (r < 10) continue;                     // спавн не заваливаем
      if (r > rMax) continue;
      if (heightmap.slopeAt(x, z) > slopeMax) continue;
      if (inCity(x, z, city.margin)) continue;  // город — без камней
      if (overlapsAny(x, z, 3, 3, buildings)) continue;
      if (nearAny(rockGrid, x, z, big ? 3.2 : 1.4, RGRID)) continue;
      if (big && nearAny(treeGrid, x, z, 2.2, GRID)) continue;  // валуны не растут из стволов
      if (dummies.some((dd) => (dd.x - x) ** 2 + (dd.z - z) ** 2 < 3 ** 2)) continue;

      const s = sMin + rng() * (sMax - sMin);
      const rock = {
        big,
        x, z,
        y: 0,
        sx: s * (0.8 + rng() * 0.5),
        sy: s * (0.6 + rng() * 0.6),
        sz: s * (0.8 + rng() * 0.5),
        rx: (rng() - 0.5) * 0.5,
        ry: rng() * Math.PI * 2,
        rz: (rng() - 0.5) * 0.5,
        tint: 0.75 + rng() * 0.45,
      };
      rock.y = heightmap.heightAt(x, z) - rock.sy * 0.3; // валун слегка вкопан в землю
      rocks.push(rock);
      gridPush(rockGrid, x, z, rock, RGRID);
      placed++;
    }
  }
  scatterRocks(true, rockSpec.big);
  scatterRocks(false, rockSpec.small);

  return {
    heightmap, city: cityRect,
    buildings, trees, bushes, rocks, dummies, signs, bins, bags,
    spawn: { x: 0, z: 0 },
  };
}

// Высота городского покрытия в точке: тротуар у домов чуть выше асфальта; вне города — 0.
// По ней садятся знаки, баки и мешки, и по ней же считает пол физика мешков.
export function makeCityLift(cfg, buildings) {
  const c = cfg.city;
  const minX = c.cx - c.halfW, maxX = c.cx + c.halfW;
  const minZ = c.cz - c.halfD, maxZ = c.cz + c.halfD;
  return (x, z) => {
    if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) return 0;
    for (const b of buildings) {
      if (Math.abs(x - b.x) <= b.w / 2 + c.sidewalkPad &&
          Math.abs(z - b.z) <= b.d / 2 + c.sidewalkPad) return c.sidewalkLift;
    }
    return c.asphaltLift;
  };
}

// AABB-коллайдеры крупных валунов: игрок и манекены не проходят сквозь них.
export function rockColliders(rocks) {
  const out = [];
  for (const rock of rocks) {
    if (!rock.big) continue;
    const hx = rock.sx * 0.75;
    const hz = rock.sz * 0.75;
    out.push({
      minX: rock.x - hx, maxX: rock.x + hx,
      minZ: rock.z - hz, maxZ: rock.z + hz,
      minY: rock.y - 1.5, maxY: rock.y + rock.sy * 0.85,
    });
  }
  return out;
}

// AABB-коллайдеры мусорных баков: сквозь них не пройти, мешки от них отскакивают.
export function binColliders(bins, cfg) {
  const h = cfg.street.binHeight;
  return bins.map((b) => ({
    minX: b.x - 0.34, maxX: b.x + 0.34,
    minZ: b.z - 0.3, maxZ: b.z + 0.3,
    minY: b.y - 0.5, maxY: b.y + h,
  }));
}

// Есть ли в хеш-гриде точка ближе radius (кольцо ring соседних ячеек).
function nearAny(grid, x, z, radius, cell, ring = 1) {
  const cx = Math.floor(x / cell);
  const cz = Math.floor(z / cell);
  const rr = radius * radius;
  for (let gx = cx - ring; gx <= cx + ring; gx++) {
    for (let gz = cz - ring; gz <= cz + ring; gz++) {
      const bucket = grid.get(gx + ':' + gz);
      if (!bucket) continue;
      for (const it of bucket) {
        const dx = it.x - x;
        const dz = it.z - z;
        if (dx * dx + dz * dz < rr) return true;
      }
    }
  }
  return false;
}

function gridPush(grid, x, z, item, cell) {
  const key = Math.floor(x / cell) + ':' + Math.floor(z / cell);
  let bucket = grid.get(key);
  if (!bucket) { bucket = []; grid.set(key, bucket); }
  bucket.push(item);
}

function cornerSpread(x, z, w, d, heightmap) {
  const hs = [
    heightmap.heightAt(x - w / 2, z - d / 2),
    heightmap.heightAt(x + w / 2, z - d / 2),
    heightmap.heightAt(x - w / 2, z + d / 2),
    heightmap.heightAt(x + w / 2, z + d / 2),
  ];
  return Math.max(...hs) - Math.min(...hs);
}

function overlapsAny(x, z, w, d, buildings) {
  const minX = x - w / 2;
  const maxX = x + w / 2;
  const minZ = z - d / 2;
  const maxZ = z + d / 2;
  for (const b of buildings) {
    if (minX < b.x + b.w / 2 && maxX > b.x - b.w / 2 &&
        minZ < b.z + b.d / 2 && maxZ > b.z - b.d / 2) return true;
  }
  return false;
}
