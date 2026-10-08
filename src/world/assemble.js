import { buildLayout, rockColliders, binColliders, makeCityLift } from './placement.js';
import { createTerrain, createPavement } from './ground.js';
import { createBuildings, Signs } from './city.js';
import { Trees, Rocks, Bushes } from './scatter.js';
import { Bins, TrashBags } from './props.js';
import { buildCovers } from './covers.js';
import { Npcs } from './npc.js';
import { Camp } from './camp.js';
import { Motorcycle } from './bike.js';

// Сборка мира из конфига: рельеф, город, декор, лагерь, мотоцикл и NPC.
// main.js не знает ни про деревья, ни про знаки — он получает готовый объект.
// Все корни, которые надо снимать со сцены, складываются в world.disposables.
export function buildWorld(cfg, scene) {
  const layout = buildLayout(cfg);

  const terrain = createTerrain(layout.heightmap, cfg);
  scene.add(terrain);

  const pavement = createPavement(layout.heightmap, layout.buildings, cfg);
  scene.add(pavement.group);

  const buildings = createBuildings(layout.buildings, cfg);
  scene.add(buildings.group);

  const trees = new Trees(layout.trees, cfg);
  trees.addTo(scene);

  const rocks = new Rocks(layout.rocks, cfg);
  scene.add(rocks.mesh);

  const bushes = new Bushes(layout.bushes, cfg);
  scene.add(bushes.mesh);

  const binCols = binColliders(layout.bins, cfg); // коллайдеры баков: физика двигает их вместе с баками
  const world = {
    heightmap: layout.heightmap,
    // дома + валуны + баки: сквозь них не пройти
    colliders: buildings.colliders.concat(rockColliders(layout.rocks), binCols),
    sizeX: cfg.world.sizeX,
    sizeZ: cfg.world.sizeZ,
    cityLift: makeCityLift(cfg, layout.buildings), // высота покрытия в городе (нужна физике мешков)
    layout,
    terrain,
    pavement,
    buildings,
    trees,
    rocks,
    bushes,
    disposables: [terrain, pavement.group, buildings.group, trees.trunks, trees.crowns,
      rocks.mesh, bushes.mesh],
  };

  world.signs = new Signs(layout.signs, cfg);
  scene.add(world.signs.group);
  world.disposables.push(world.signs.group);

  world.bins = new Bins(layout.bins, cfg, world, binCols);
  scene.add(world.bins.mesh);
  world.bags = new TrashBags(layout.bags, cfg, world);
  scene.add(world.bags.mesh);
  world.disposables.push(world.bins.mesh, world.bags.mesh);

  world.camp = new Camp(cfg, world); // лагерь напротив города: спавн, дружелюбные, постройки
  scene.add(world.camp.group);
  world.colliders.push(...world.camp.colliders);
  world.disposables.push(world.camp.group);

  // мотоцикл у лагеря: кинематический, корпус — коллайдер для пешеходов
  world.bike = new Motorcycle(cfg, world);
  scene.add(world.bike.group);
  world.disposables.push(world.bike.group);

  world.npcs = new Npcs(layout.npcs, cfg, world, buildCovers(cfg, layout, world.camp.coverBoxes));
  world.npcs.addTo(scene);
  world.disposables.push(...world.npcs.parts, ...world.npcs.debug);

  return world;
}

// Снять мир со сцены и освободить геометрию, материалы и текстуры.
export function disposeWorld(world, scene) {
  if (!world) return;
  for (const part of world.disposables) {
    scene.remove(part);
    part.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }
  world.disposables.length = 0;
}
