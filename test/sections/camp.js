// H. Лагерь: постройки, костёр, дружелюбные, спутник и палатка как укрытие.
import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { Camp } from '../../src/world/camp.js';
import { buildCovers } from '../../src/world/covers.js';
import { resolveCircleAabb } from '../../src/core/collide.js';
import { check } from '../harness.js';

export function campSection(ctx) {
  const { cfg, hm, cityLift, inBuilding } = ctx;

  console.log('\nH. Лагерь');
  const camp = new Camp(CONFIG, { heightmap: hm, cityLift: null });
  ctx.camp = camp; // нужен секции мотоцикла: стоянка не должна пересекать постройки
  check('лагерь собран: постройки и шесть дружелюбных',
    camp.group.children.length > 10 && camp.friends.length === 6 && camp.colliders.length >= 6);
  check('лица друзей и поза пассажира: девять мешей, меш — в общем наборе',
    camp.parts.length === 9 && camp.faces.count === 6);
  const tentWallTry = resolveCircleAabb(camp.tent.x - camp.tent.half + 0.25, camp.tent.z,
    0.4, camp.tent.gy + 0.5, 1.8, camp.colliders);
  check('стена палатки не пропускает сквозь себя', tentWallTry.hit);
  const tentDoorTry = resolveCircleAabb(camp.tent.x, camp.tent.z + camp.tent.depth / 2 - 0.3,
    0.4, camp.tent.gy + 0.5, 1.8, camp.colliders);
  check('вход в палатку открыт — внутрь можно зайти', !tentDoorTry.hit);
  const fTent = camp.friends[4];
  const fTentTry = resolveCircleAabb(fTent.x, fTent.z, 0.25, fTent.y, 1.2, camp.colliders);
  check('друг за столом в палатке стоит свободно', !fTentTry.hit);
  const spawnTry = resolveCircleAabb(CONFIG.camp.x + CONFIG.camp.spawnDx, CONFIG.camp.z + CONFIG.camp.spawnDz,
    0.4, hm.heightAt(CONFIG.camp.x + CONFIG.camp.spawnDx, CONFIG.camp.z + CONFIG.camp.spawnDz), 1.8, camp.colliders);
  check('спавн игрока не торчит в постройках', !spawnTry.hit);

  // костёр: пламя живёт, свет мерцает, тени — по кнобу fireShadows
  check('костёр горит: пламя из трёх кубиков и свет на fireDist метров',
    camp.flame.children.length === 3 && camp.fireLight.intensity >= 5 &&
    camp.fireLight.distance === CONFIG.camp.fireDist);
  check('тени костра — минимальная карта, по кнобу fireShadows',
    camp.fireLight.castShadow === CONFIG.camp.fireShadows && camp.fireLight.shadow.mapSize.x === 256);
  const fireI0 = camp.fireLight.intensity;
  const fireY0 = camp.flame.position.y;
  const awayVec = new THREE.Vector3(999, 0, 999);
  for (let i = 0; i < 30; i++) camp.update(1 / 60, awayVec);
  check('пламя дрожит, свет мерцает во времени',
    camp.fireLight.intensity !== fireI0 && camp.flame.position.y !== fireY0,
    `I=${camp.fireLight.intensity.toFixed(2)}`);

  // городской друг: центр города, не в доме, стоит на покрытии
  const campCity = new Camp(CONFIG, { heightmap: hm, cityLift });
  const fCity = campCity.friends[5];
  check('городской друг стоит в центре города и не в доме',
    Math.abs(fCity.x - cfg.city.cx) < 1e-6 && Math.abs(fCity.z - cfg.city.cz) < 1e-6 &&
    !inBuilding(fCity.x, fCity.z, 1),
    `x=${fCity.x.toFixed(1)} z=${fCity.z.toFixed(1)}`);
  check('городской друг стоит на покрытии города',
    Math.abs(fCity.y - (hm.heightAt(fCity.x, fCity.z) + cityLift(fCity.x, fCity.z))) < 1e-6);

  // спутник: E — зовём за собой; повторный E — «жди здесь», стоит на месте
  check('E у стоящего друга включает спутника', campCity.interact(fCity) === true && fCity.mode === 'follow');
  check('у сидящего друга взаимодействия нет', campCity.interact(campCity.friends[1]) === false &&
    campCity.friends[1].mode === 'stay');
  check('friendOf: тело стоящего и голова — друзья, тело сидящего — нет',
    campCity.friendOf(campCity.standBody, 0) === campCity.friends[3] &&
    campCity.friendOf(campCity.standShell, 1) === campCity.friends[5] &&
    campCity.friendOf(campCity.head, 2) === campCity.friends[2] &&
    campCity.friendOf(campCity.faces, 5) === campCity.friends[5] &&
    campCity.friendOf(campCity.sitBody, 0) === null);
  const followTo = new THREE.Vector3(fCity.x + 20, 0, fCity.z);
  for (let i = 0; i < 600; i++) campCity.update(1 / 60, followTo);
  const followD = Math.hypot(followTo.x - fCity.x, followTo.z - fCity.z);
  check('спутник догоняет игрока и держит дистанцию', followD < CONFIG.camp.followStop + 0.6,
    `d=${followD.toFixed(1)}`);
  check('E при спутнике — «жди здесь»', campCity.interact(fCity) === true && fCity.mode === 'stay');
  const waitX = fCity.x;
  const waitZ = fCity.z;
  followTo.set(fCity.x + 40, 0, fCity.z);
  for (let i = 0; i < 300; i++) campCity.update(1 / 60, followTo);
  check('в режиме ожидания друг стоит на месте',
    Math.abs(fCity.x - waitX) < 1e-6 && Math.abs(fCity.z - waitZ) < 1e-6);

  // палатка в гриде укрытий: сквозь неё враждебные не видят игрока
  const tentCovers = buildCovers(cfg, { buildings: [], rocks: [], trees: [], city: null }, camp.coverBoxes);
  check('палатка блокирует линию взгляда NPC (как дом)',
    !tentCovers.los(camp.tent.x, camp.tent.z - 6, camp.tent.x, camp.tent.z + 6));
  check('рядом с палаткой линия взгляда свободна',
    tentCovers.los(camp.tent.x + 8, camp.tent.z - 6, camp.tent.x + 8, camp.tent.z + 6));

  const f0 = camp.friends[0];
  const nearCamp = new THREE.Vector3(f0.x + 3, 0, f0.z + 3);
  for (let i = 0; i < 300; i++) camp.update(1 / 60, nearCamp);
  check('головы дружелюбных поворачиваются на близкого игрока', Math.abs(f0.headYaw) > 0.5,
    `yaw=${f0.headYaw.toFixed(2)}`);
  const farCamp = new THREE.Vector3(f0.x + 100, 0, f0.z);
  for (let i = 0; i < 300; i++) camp.update(1 / 60, farCamp);
  check('игрок ушёл — головы возвращаются к костру', Math.abs(f0.headYaw) < 0.08,
    `yaw=${f0.headYaw.toFixed(2)}`);
}
