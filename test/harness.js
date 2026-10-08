// Общая обвязка headless-проверок: счётчик ok/FAIL, контекст мира и предикаты расстановки.
// Секции (test/sections/*.js) принимают ctx, печатают свои пункты и дописывают в ctx то,
// что нужно следующим секциям (например, лагерь — секции мотоцикла).
import { CONFIG } from '../src/config.js';
import { buildLayout, makeCityLift } from '../src/world/placement.js';
import { Covers } from '../src/world/covers.js';

let pass = 0;
let fail = 0;

export const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(` FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

export function report() {
  console.log(`\nИтог: ${pass} ok, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

// Мир собирается один раз: сид фиксирован, поэтому расстановка у всех секций общая.
export function makeContext() {
  const cfg = { ...CONFIG, seed: CONFIG.seed };
  const layout = buildLayout(cfg);
  const hm = layout.heightmap;

  return {
    cfg,
    layout,
    hm,
    cityZone: layout.city,
    cityLift: makeCityLift(cfg, layout.buildings), // высота покрытия в городе (асфальт/тротуар)
    // «пустой» мир для юнитов, которым не нужны коллайдеры и покрытие
    npcWorld: { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift: null },
    emptyCovers: new Covers(), // без укрытий: LOS всегда свободен
    // заглушки обратных вызовов NPC: считаем урон, выстрелы и следы пуль
    mkHooks: () => {
      const ev = { dmg: [], shots: 0, tracers: 0, friendDmg: [] };
      return {
        ev,
        hooks: {
          playerDamage: (d) => ev.dmg.push(d),
          friendDamage: (f, d) => ev.friendDmg.push({ f, d }),
          muzzle: () => { ev.shots++; },
          tracer: () => { ev.tracers++; },
        },
      };
    },
    inBuilding: (x, z, margin = 0) => layout.buildings.some((b) =>
      Math.abs(x - b.x) < b.w / 2 + margin && Math.abs(z - b.z) < b.d / 2 + margin),
    strictlyInCity: (x, z, m = 0) =>
      x > layout.city.minX - m && x < layout.city.maxX + m &&
      z > layout.city.minZ - m && z < layout.city.maxZ + m,
  };
}
