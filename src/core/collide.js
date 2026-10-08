// Чистая логика коллизий — без three и без DOM,
// чтобы её можно было гонять headless-тестом (test/headless.js).

// Выталкивание круга (x, z, radius) из AABB-коробок.
// Коробка: { minX, maxX, minZ, maxZ, minY, maxY }.
// feetY — низ капсулы, height — её высота: коробки, которые выше/ниже этого диапазона, игнорируются.
export function resolveCircleAabb(x, z, radius, feetY, height, boxes) {
  let hit = false;
  for (const b of boxes) {
    // вертикального пересечения нет — можно пройти/стоять сверху
    if (feetY >= b.maxY - 1e-4 || feetY + height <= b.minY + 1e-4) continue;

    const cx = Math.max(b.minX, Math.min(x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) continue;

    hit = true;
    if (d2 > 1e-8) {
      // выталкиваем по нормали от ближайшей точки коробки
      const d = Math.sqrt(d2);
      const push = radius - d;
      x += (dx / d) * push;
      z += (dz / d) * push;
    } else {
      // центр внутри коробки — выталкиваем через ближайшую грань
      const toL = x - (b.minX - radius);
      const toR = b.maxX + radius - x;
      const toB = z - (b.minZ - radius);
      const toT = b.maxZ + radius - z;
      const m = Math.min(toL, toR, toB, toT);
      if (m === toL) x = b.minX - radius;
      else if (m === toR) x = b.maxX + radius;
      else if (m === toB) z = b.minZ - radius;
      else z = b.maxZ + radius;
    }
  }
  return { x, z, hit };
}

// Высота «пола» под точкой (x, z): рельеф или крыша коробки, на которую можно шагнуть.
// standRadius — радиус опоры: чтобы стоять на самом краю крыши, а не за ней.
export function groundHeightAt(x, z, terrainHeight, boxes, feetY, stepHeight, standRadius = 0.35) {
  let g = terrainHeight;
  for (const b of boxes) {
    const cx = Math.max(b.minX, Math.min(x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz > standRadius * standRadius) continue;
    // на крышу можно встать, только если она не выше уступа шага над текущими ногами
    if (b.maxY > g && b.maxY <= feetY + stepHeight) g = b.maxY;
  }
  return g;
}
