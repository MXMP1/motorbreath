// A. Рельеф, B. Расстановка мира, C. Коллизии.
import { createHeightmap } from '../../src/world/heightmap.js';
import { resolveCircleAabb, groundHeightAt } from '../../src/core/collide.js';
import { check } from '../harness.js';

export function worldSection(ctx) {
  const { cfg, layout, hm } = ctx;

  // ---------- A. Рельеф ----------
  console.log('\nA. Рельеф');
  const hm2 = createHeightmap(cfg.world);
  const pts = [[0, 0], [10, 5], [-30, 20], [60, -40], [100, 100], [170, 0], [-200, 150], [0, 210]];
  check('сид детерминирован', pts.every(([x, z]) => hm.heightAt(x, z) === hm2.heightAt(x, z)));

  const hm3 = createHeightmap({ ...cfg.world, seed: cfg.seed + 1 });
  check('другой сид — другой рельеф', pts.some(([x, z]) => Math.abs(hm.heightAt(x, z) - hm3.heightAt(x, z)) > 0.5));

  let centreMax = 0;
  for (let x = -30; x <= 30; x += 5) {
    for (let z = -30; z <= 30; z += 5) centreMax = Math.max(centreMax, Math.abs(hm.heightAt(x, z)));
  }
  check('центр ровный (|h| < 2.5 м)', centreMax < 2.5, `max=${centreMax.toFixed(2)}`);

  // край карты — длинный коридор: хребет проверяем у всех четырёх стен
  const ringX = cfg.world.sizeX / 2 - 20; // вдоль длинной стороны: до гор ~100 м
  const ringZ = cfg.world.sizeZ / 2 - 20; // по торцам: ~110 м и больше
  const ringHeights = [];
  for (let i = 0; i < 8; i++) {
    const t = -130 + (260 * i) / 7;
    ringHeights.push(hm.heightAt(ringX, t), hm.heightAt(-ringX, t));
  }
  for (let i = 0; i < 6; i++) {
    const t = -100 + (200 * i) / 5;
    ringHeights.push(hm.heightAt(t, ringZ), hm.heightAt(t, -ringZ));
  }
  const avgRing = ringHeights.reduce((s, v) => s + v, 0) / ringHeights.length;
  check('горы по краю высокие (средн. > 25 м)', avgRing > 25, `avg=${avgRing.toFixed(1)}`);
  check('хребет хотя бы где-то > 45 м', Math.max(...ringHeights) > 45, `max=${Math.max(...ringHeights).toFixed(1)}`);

  // ---------- B. Расстановка ----------
  console.log('\nB. Расстановка мира');
  check('домов достаточно', layout.buildings.length >= 10, `=${layout.buildings.length}`);

  let overlap = false;
  for (let i = 0; i < layout.buildings.length; i++) {
    for (let j = i + 1; j < layout.buildings.length; j++) {
      const a = layout.buildings[i];
      const b = layout.buildings[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2) overlap = true;
    }
  }
  check('дома не пересекаются', !overlap);
  check('дома на ровных участках', layout.buildings.every((b) => hm.slopeAt(b.x, b.z) < 0.3));
  check('деревьев >= 400', layout.trees.length >= 400, `=${layout.trees.length}`);
  check('деревья не в домах', layout.trees.every((t) => !ctx.inBuilding(t.x, t.z, 1.5)));
  check('деревья в границах', layout.trees.every((t) =>
    Math.abs(t.x) < cfg.world.sizeX / 2 && Math.abs(t.z) < cfg.world.sizeZ / 2));
  check('нпс достаточно и все в городе', layout.npcs.length === cfg.layout.npcs && layout.npcs.every((n) =>
    n.x > layout.city.minX && n.x < layout.city.maxX && n.z > layout.city.minZ && n.z < layout.city.maxZ));
  check('нпс на покрытии, не в домах', layout.npcs.every((n) =>
    !ctx.inBuilding(n.x, n.z, 1) &&
    Math.abs(n.y - (hm.heightAt(n.x, n.z) + ctx.cityLift(n.x, n.z))) < 1e-6));
  check('нпс делятся на палочников и стрелков', layout.npcs.filter((n) => n.weapon === 'stick').length >= 6 &&
    layout.npcs.filter((n) => n.weapon === 'pistol').length >= 6);
  const campClear = (x, z) => Math.hypot(x - cfg.camp.x, z - cfg.camp.z) >= cfg.camp.clearing - 1e-6;
  check('поляна лагеря чиста: без леса, кустов и камней',
    layout.trees.every((t) => campClear(t.x, t.z)) &&
    layout.bushes.every((b) => campClear(b.x, b.z)) &&
    layout.rocks.every((r0) => campClear(r0.x, r0.z)));

  // ---------- C. Коллизии ----------
  console.log('\nC. Коллизии');
  const box = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, minY: 0, maxY: 3 };

  let r = resolveCircleAabb(0, 0, 0.4, 0, 1.8, [box]);
  check('центр в коробке — выталкивает наружу', r.hit && (Math.abs(r.x) >= 1.4 - 1e-6 || Math.abs(r.z) >= 1.4 - 1e-6));

  r = resolveCircleAabb(1.3, 0, 0.4, 0, 1.8, [box]);
  check('пересечение с гранью — выталкивает', r.hit && Math.abs(r.x - 1.4) < 1e-6, `x=${r.x}`);

  r = resolveCircleAabb(3, 3, 0.4, 0, 1.8, [box]);
  check('вне коробки — не трогает', !r.hit);

  r = resolveCircleAabb(1.2, 0, 0.4, 3.5, 1.8, [box]);
  check('стоя сверху — не выталкивает', !r.hit);

  check('стоя на крыше — пол = крыша', groundHeightAt(0, 0, -5, [box], 3.01, 0.55) === 3);
  check('высокий уступ не ступенька', groundHeightAt(0, 0, -5, [box], 2.0, 0.55) === -5);
}
