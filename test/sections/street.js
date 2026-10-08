// F. Городская зона, зелень, камни и уличная обстановка (знаки, баки, мешки).
import { CONFIG } from '../../src/config.js';
import { rockColliders, binColliders } from '../../src/world/placement.js';
import { createPavement } from '../../src/world/ground.js';
import { Rocks, Bushes } from '../../src/world/scatter.js';
import { Bins, TrashBags, pushBagsByBins } from '../../src/world/props.js';
import { resolveCircleAabb } from '../../src/core/collide.js';
import { check } from '../harness.js';

export function streetSection(ctx) {
  const { cfg, layout, hm, cityLift, cityZone, inBuilding, strictlyInCity } = ctx;

  console.log('\nF. Городская зона, зелень и улица');
  const cityMargin = cfg.city.margin;

  check('дома целиком внутри городской зоны', layout.buildings.length > 0 && layout.buildings.every((b) =>
    b.x - b.w / 2 >= cityZone.minX - 1e-6 && b.x + b.w / 2 <= cityZone.maxX + 1e-6 &&
    b.z - b.d / 2 >= cityZone.minZ - 1e-6 && b.z + b.d / 2 <= cityZone.maxZ + 1e-6));
  check('лес не заходит в город', layout.trees.every((t) => !strictlyInCity(t.x, t.z, cityMargin)));

  check('кустов достаточно', layout.bushes.length >= 220, `=${layout.bushes.length}`);
  check('кусты в зелёной зоне', layout.bushes.every((b) => !strictlyInCity(b.x, b.z, cityMargin)));
  check('кусты на земле и не в домах', layout.bushes.every((b) =>
    b.y === hm.heightAt(b.x, b.z) && !inBuilding(b.x, b.z, 1)));

  const bigRocks = layout.rocks.filter((r0) => r0.big);
  const smallRocks = layout.rocks.filter((r0) => !r0.big);
  check('валунов достаточно', bigRocks.length >= 100, `=${bigRocks.length}`);
  check('мелких камней достаточно', smallRocks.length >= 220, `=${smallRocks.length}`);
  check('камни не в городе', layout.rocks.every((r0) => !strictlyInCity(r0.x, r0.z, cityMargin)));
  check('камни сидят в земле', layout.rocks.every((r0) => {
    const g = hm.heightAt(r0.x, r0.z);
    return r0.y <= g + 1e-6 && r0.y > g - 1.2;
  }));
  const rcols = rockColliders(layout.rocks);
  check('у каждого валуна есть коллайдер', rcols.length === bigRocks.length);
  if (rcols.length > 0) {
    const rc = rcols[0];
    const rr = resolveCircleAabb((rc.minX + rc.maxX) / 2, (rc.minZ + rc.maxZ) / 2, 0.4, rc.minY + 0.5, 1.8, [rc]);
    check('игрок выталкивается из валуна', rr.hit);
  }

  const pave = createPavement(layout.heightmap, layout.buildings, cfg);
  check('асфальт + тротуар под каждый дом', pave.group.children.length === 1 + layout.buildings.length);
  const asphaltMesh = pave.group.children[0];
  asphaltMesh.geometry.computeBoundingBox();
  const abox = asphaltMesh.geometry.boundingBox;
  check('асфальт накрывает все дома', layout.buildings.every((b) =>
    b.x > abox.min.x && b.x < abox.max.x && b.z > abox.min.z && b.z < abox.max.z));

  const rocksView = new Rocks(layout.rocks, cfg);
  const bushesView = new Bushes(layout.bushes, cfg);
  check('камни одним instanced-мешем', rocksView.mesh.count === layout.rocks.length);
  check('кусты одним instanced-мешем', bushesView.mesh.count === layout.bushes.length);

  // уличная обстановка: знаки, баки, мешки
  check('знаков достаточно', layout.signs.length >= 6, `=${layout.signs.length}`);
  check('знаки стоят на покрытии в городе', layout.signs.every((s) =>
    strictlyInCity(s.x, s.z) && !inBuilding(s.x, s.z, 1) &&
    Math.abs(s.y - (hm.heightAt(s.x, s.z) + cityLift(s.x, s.z))) < 1e-6));

  // знак стоит у края «дороги» — отступ от ближайшей оси улицы близок к signEdge
  const plotW = (cityZone.maxX - cityZone.minX) / 4;
  const plotD = (cityZone.maxZ - cityZone.minZ) / 3;
  const nearestLine = (v, min, step, n) => {
    let best = Infinity;
    for (let i = 1; i <= n; i++) best = Math.min(best, Math.abs(v - (min + i * step)));
    return best;
  };
  check('знаки у края дороги, не по её центру', layout.signs.every((s) => {
    const d = Math.min(nearestLine(s.x, cityZone.minX, plotW, 3), nearestLine(s.z, cityZone.minZ, plotD, 2));
    return Math.abs(d - cfg.street.signEdge) < 0.6;
  }));

  check('баков достаточно', layout.bins.length >= 8, `=${layout.bins.length}`);
  check('баки у домов, на покрытии', layout.bins.every((b) =>
    strictlyInCity(b.x, b.z) && !inBuilding(b.x, b.z, 0.5) &&
    Math.abs(b.y - (hm.heightAt(b.x, b.z) + cityLift(b.x, b.z))) < 1e-6));
  const bcols = binColliders(layout.bins, cfg);
  check('у каждого бака есть коллайдер', bcols.length === layout.bins.length);
  if (bcols.length > 0) {
    const bc = bcols[0];
    const rr = resolveCircleAabb((bc.minX + bc.maxX) / 2, (bc.minZ + bc.maxZ) / 2, 0.4, bc.minY + 0.5, 1.8, [bc]);
    check('игрок выталкивается из бака', rr.hit);
  }

  check('мешков достаточно', layout.bags.length >= 25, `=${layout.bags.length}`);
  check('мешки в городе, на покрытии', layout.bags.every((bg) =>
    strictlyInCity(bg.x, bg.z) && !inBuilding(bg.x, bg.z, 0.45) &&
    Math.abs(bg.y - (hm.heightAt(bg.x, bg.z) + cityLift(bg.x, bg.z))) < 1e-6));

  // кусты дрожат от удара и постепенно затухают
  bushesView.hit(0);
  check('куст начинает дрожать', bushesView.update(1 / 60) === 1);
  for (let i = 0; i < 300; i++) bushesView.update(1 / 60);
  check('дрожь куста затухает', bushesView.swayCount === 0);

  // физика мешков: пинок, полёт, засыпание, сброс по R
  const bagWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift };
  const bagsView = new TrashBags(layout.bags, CONFIG, bagWorld);
  check('мешки одним instanced-мешем', bagsView.mesh.count === layout.bags.length);
  check('мешки спят на старте', bagsView.awakeCount === 0);

  const bagStart = bagsView.units[0].pos.clone();
  bagsView.hit(0, { x: 1, z: 0 }, CONFIG.street.bagImpulse);
  check('пинок будит мешок', bagsView.awakeCount === 1);
  let bagSettled = false;
  for (let i = 0; i < 900 && !bagSettled; i++) { bagsView.update(1 / 60); bagSettled = bagsView.awakeCount === 0; }
  const bagEnd = bagsView.units[0].pos;
  const bagDist = bagEnd.distanceTo(bagStart);
  check('мешок отлетает от пинка', bagDist > 1.5, `d=${bagDist.toFixed(2)}`);
  check('мешок засыпает на земле', bagSettled &&
    Math.abs(bagEnd.y - bagsView.groundBelow(bagEnd.x, bagEnd.z, bagEnd.y)) < 0.05);

  bagsView.resetAll();
  check('R возвращает мешки на места', bagsView.units[0].pos.distanceTo(bagStart) < 0.05);

  // физика баков: тяжёлые — двигаются, но заметно меньше мешков; коллайдер едет за баком
  const propWorld = { heightmap: hm, colliders: [], sizeX: cfg.world.sizeX, sizeZ: cfg.world.sizeZ, cityLift };
  const binsView = new Bins(layout.bins, cfg, propWorld, bcols);
  check('баки одним instanced-мешем', binsView.mesh.count === layout.bins.length);
  check('баки спят на старте', binsView.awakeCount === 0);

  const binStart = binsView.units[0].pos.clone();
  binsView.hit(0, { x: 1, z: 0 }, CONFIG.street.binImpulse);
  check('пинок будит бак', binsView.awakeCount === 1);
  let binSettled = false;
  for (let i = 0; i < 900 && !binSettled; i++) { binsView.update(1 / 60); binSettled = binsView.awakeCount === 0; }
  const binDist = binsView.units[0].pos.distanceTo(binStart);
  check('бак сдвигается от пинка', binSettled && binDist > 0.15, `d=${binDist.toFixed(2)}`);
  check('бак тяжелее мешка', binDist < bagDist * 0.5, `bin=${binDist.toFixed(2)} bag=${bagDist.toFixed(2)}`);
  const bc0 = bcols[0];
  check('коллайдер бака едет за баком',
    Math.abs((bc0.minX + bc0.maxX) / 2 - binsView.units[0].pos.x) < 0.01 &&
    Math.abs((bc0.minZ + bc0.maxZ) / 2 - binsView.units[0].pos.z) < 0.01);

  // бак, проехав по лежащему мешку, будит его лёгким толчком
  const soloBag = new TrashBags([{
    x: layout.bins[0].x + 0.7, z: layout.bins[0].z, y: layout.bins[0].y,
    s: 0.8, ry: 0, rx: 0.1, rz: 0, tint: 1,
  }], CONFIG, propWorld);
  const soloStart = soloBag.units[0].pos.clone();
  binsView.resetAll();
  binsView.hit(0, { x: 1, z: 0 }, CONFIG.street.binImpulse);
  let soloMoved = false;
  for (let i = 0; i < 900; i++) {
    binsView.update(1 / 60);
    pushBagsByBins(soloBag, binsView, CONFIG.street.bagPush);
    soloBag.update(1 / 60);
    if (soloBag.units[0].pos.distanceTo(soloStart) > 0.2) soloMoved = true;
  }
  check('бак столкнул мешок', soloMoved && soloBag.awakeCount === 0);

  binsView.resetAll();
  check('R возвращает баки на места', binsView.units[0].pos.distanceTo(binStart) < 0.05);
}
