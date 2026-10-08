// K. Квест «Вывести Малого»: стадии, диалог, урон спутнику, резинка, маркер.
import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { Camp } from '../../src/world/camp.js';
import { Npcs } from '../../src/world/npc.js';
import { Quest, INTRO_LINES, DONE_LINES } from '../../src/quest/quest.js';
import { check } from '../harness.js';

export function questSection(ctx) {
  const { cfg, hm, cityLift, npcWorld, emptyCovers, mkHooks } = ctx;

  console.log('\nK. Квест «Вывести Малого»');
  const city = { cx: cfg.city.cx, cz: cfg.city.cz, halfW: cfg.city.halfW, halfD: cfg.city.halfD };

  // конфиг квеста на месте
  check('конфиг квеста: здоровье, дистанции, резинка',
    cfg.quest.friendHp === 40 && cfg.quest.giverRange === 2.6 && cfg.quest.arrivePad === 6 &&
    cfg.camp.followCatchUp === 16 && cfg.camp.catchUpSpeed === 9.6);

  const camp = new Camp(CONFIG, { heightmap: hm, cityLift });
  const q = new Quest(CONFIG, camp.friends, city);
  check('квест стартует со стадии intro', q.stage === 'intro');
  check('задание даёт друг в палатке (сидит), ведём Малого у вешалок (стоит)',
    q.giver === camp.friends[4] && q.giver.sit && q.ward === camp.friends[3] && !q.ward.sit);
  check('на intro маркер над другом в палатке',
    q.markerPos && Math.abs(q.markerPos.x - q.giver.x) < 1e-6 && Math.abs(q.markerPos.z - q.giver.z) < 1e-6);

  // реплика-субтитр: один раз, когда игрок подошёл к другу
  const nearGiver = new THREE.Vector3(q.giver.x + 1, 0, q.giver.z);
  q.update(1 / 60, nearGiver);
  check('рядом с другом всплывает субтитр (один раз)', q.subtitle !== null && q.subtitleShown);
  const subFirst = q.subtitleText;
  q.update(1 / 60, nearGiver);
  check('субтитр не повторяется', q.subtitleText === subFirst);

  // диалог: E у друга в палатке открывает 6 реплик, доводит до escort
  check('E на друге в палатке во время intro открывает диалог', q.canTalkTo(q.giver) && q.openDialogue() === true && q.talking);
  let lines = 0;
  while (q.talking && lines < 20) { q.advance(); lines++; }
  check('диалог из 6 реплик закрывается и переводит в escort',
    lines === INTRO_LINES.length && q.stage === 'escort', `lines=${lines}`);
  check('Малой автоматически идёт за игроком (follow)', q.ward.mode === 'follow');
  check('в escort маркер переезжает на Малого',
    q.markerPos && Math.abs(q.markerPos.x - q.ward.x) < 1e-6 && Math.abs(q.markerPos.z - q.ward.z) < 1e-6);
  check('цель escort — довести Малого живым до города', q.objective === 'Доведи Малого живым до города');

  // «резинка»: на большом отрыве спутник догоняет бегом
  const ward = q.ward;
  const far = new THREE.Vector3(ward.x + 40, 0, ward.z);
  for (let i = 0; i < 600; i++) camp.update(1 / 60, far);
  const dCatch = Math.hypot(far.x - ward.x, far.z - ward.z);
  check('резинка догоняет игрока на отрыве 40 м', dCatch < CONFIG.camp.followStop + 0.6, `d=${dCatch.toFixed(1)}`);

  // враждебные видят и бьют спутника: урон уходит в friendDamage, а не в playerDamage
  const shot = mkHooks();
  const fakeFriend = { x: 0, y: 0, z: 5, mode: 'follow', sit: false, ride: false, dead: false, downT: 0, getUpT: 0, hp: 40 };
  const gunner = new Npcs([
    { x: 0, z: 0, y: 0, rot: 0, weapon: 'pistol', home: { x: 0, z: 0 } }, // смотрит на спутника (+z)
  ], CONFIG, npcWorld, emptyCovers);
  const farPlayer = new THREE.Vector3(0, 0, -300); // игрок далеко: цель — спутник
  for (let i = 0; i < 600; i++) gunner.update(1 / 60, farPlayer, shot.hooks, { friends: [fakeFriend] });
  check('NPC воюет со спутником и наносит ему урон (не игроку)',
    shot.ev.friendDmg.length > 0 && shot.ev.dmg.length === 0, `fd=${shot.ev.friendDmg.length}`);

  // здоровье и смерть спутника через лагерь → failed
  const hp0 = ward.hp;
  camp.damage(ward, 10);
  check('урон спутнику снимает здоровье', ward.hp === hp0 - 10 && !ward.dead);
  camp.damage(ward, 99999);
  check('на нуле спутник погибает и падает навсегда', ward.dead === true && ward.fall === 1 && ward.mode === 'stay');
  q.update(1 / 60, nearGiver);
  check('смерть Малого — стадия failed', q.stage === 'failed' && q.objective.includes('провалено'));
  check('у мёртвого Малого маркера нет', q.markerPos === null);

  // прибытие в город → done + благодарность городского друга
  camp.resetFriends();
  q.reset();
  check('сброс (R): друзья живы, квест снова intro', q.stage === 'intro' && camp.friends.every((f) => !f.dead && f.hp === CONFIG.quest.friendHp));
  q.openDialogue();
  let l2 = 0;
  while (q.talking && l2 < 20) { q.advance(); l2++; }
  const w = q.ward;
  w.x = cfg.city.cx;
  w.z = cfg.city.cz; // Малой дошёл до центра города
  q.update(1 / 60, new THREE.Vector3(w.x, 0, w.z));
  check('Малой в городской зоне — стадия done', q.stage === 'done');
  check('по прибытии городской друг благодарит (2 реплики)', q.talking && q.lines === DONE_LINES && DONE_LINES.length === 2);
}
