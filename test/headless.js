// Headless-проверка игры: мир, расстановка, коллизии и симуляция — без браузера.
// Запуск: npm test   (node test/headless.js)
// Печатает ok/FAIL по каждому пункту; код выхода 1, если есть провалы.
// Сами проверки живут в test/sections/*.js, общая обвязка — в test/harness.js.
import { makeContext, report } from './harness.js';
import { worldSection } from './sections/world.js';
import { playerSection } from './sections/player.js';
import { streetSection } from './sections/street.js';
import { npcSection } from './sections/npc.js';
import { campSection } from './sections/camp.js';
import { bikeSection } from './sections/bike.js';
import { questSection } from './sections/quest.js';

const ctx = makeContext();

// Порядок секций фиксирован: лагерь до мотоцикла (стоянка проверяется по его коллайдерам).
worldSection(ctx);
playerSection(ctx);
streetSection(ctx);
npcSection(ctx);
campSection(ctx);
bikeSection(ctx);
questSection(ctx);

report();
