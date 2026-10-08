// Квест «Вывести Малого»: сопровождение спутника из лагеря в город.
// Чистая логика — ни three, ни DOM, поэтому стадии и условия гоняются headless.
//
// Роли (существующие дружелюбные лагеря):
//   giver      — друг в палатке (сидит за столом): даёт задание;
//   ward       — «Малой» у вешалок: кого ведём, без оружия, его бьют враждебные;
//   cityFriend — друг в центре города: благодарит, когда Малой дошёл.
//
// Стадии: intro → escort → done | failed.

export const INTRO_SUBTITLE = 'Чёрт возьми! Ну сколько же можно, мы не можем здесь сидеть вечно!';

// Диалог у палатки: 6 реплик, «E — дальше».
export const INTRO_LINES = [
  { who: 'друг', text: 'Чёрт возьми! Ну сколько же можно, мы не можем здесь сидеть вечно!' },
  { who: 'Игрок', text: 'Согласен. Дольше торчать в лагере нельзя. Что предлагаешь?' },
  { who: 'друг', text: 'Малой давно рвётся в город. Доведи его туда — живым. Здесь ему не место.' },
  { who: 'Игрок', text: 'Путь неблизкий, а в городе полно вооружённых. Он-то сам драться не умеет.' },
  { who: 'друг', text: 'Поэтому и прошу тебя. У тебя есть мотоцикл — вдвоём проскочите. Береги Малого.' },
  { who: 'Игрок', text: 'Хорошо. Выведу Малого. Ждите нас в городе.' },
];

// Благодарность городского друга по прибытии: 2 реплики.
export const DONE_LINES = [
  { who: 'горожанин', text: 'Вы добрались! Малой, ну ты даёшь — живой и невредимый.' },
  { who: 'горожанин', text: 'Спасибо, что вывел его. Здесь он будет в безопасности.' },
];

export class Quest {
  constructor(cfg, friends, city) {
    this.cfg = cfg.quest;
    this.city = city; // { cx, cz, halfW, halfD } — городская зона прибытия
    this.setFriends(friends);
    this.reset();
  }

  setFriends(friends) {
    this.friends = friends;
    this.giver = friends[4] || null;      // друг в палатке за столом
    this.ward = friends[3] || null;       // «Малой» у вешалок
    this.cityFriend = friends[5] || null; // городской друг
  }

  // Перепривязка после пересборки мира (G): новые друзья, квест с начала.
  attach(world) {
    this.setFriends(world.camp.friends);
    this.reset();
  }

  reset() {
    this.stage = 'intro';
    this.lines = INTRO_LINES;
    this.line = 0;
    this.talking = false;       // открыт ли диалог (движение и стрельба заморожены)
    this.subtitleShown = false; // реплика-субтитр друга бросается один раз
    this.subtitleT = 0;
    this.subtitleText = '';
  }

  // Плашка субтитра: текст, пока не погасла, иначе null.
  get subtitle() {
    return this.subtitleT > 0 ? this.subtitleText : null;
  }

  // E на этом друге во время intro открывает диалог (даже если он сидит).
  canTalkTo(f) {
    return this.stage === 'intro' && f === this.giver;
  }

  nearGiver(pos) {
    if (!pos || !this.giver) return false;
    return Math.hypot(pos.x - this.giver.x, pos.z - this.giver.z) <= this.cfg.giverRange;
  }

  openDialogue() {
    if (this.stage !== 'intro' || this.talking) return false;
    this.lines = INTRO_LINES;
    this.line = 0;
    this.talking = true;
    return true;
  }

  currentLine() {
    return this.talking ? (this.lines[this.line] || null) : null;
  }

  // «E — дальше»: следующая реплика; диалог кончился — закрываем и меняем стадию.
  advance() {
    if (!this.talking) return;
    this.line++;
    if (this.line < this.lines.length) return;
    this.talking = false;
    this.line = 0;
    if (this.stage === 'intro') this._startEscort();
    // done: благодарность закончилась, стадия остаётся done
  }

  _startEscort() {
    this.stage = 'escort';
    if (this.ward) this.ward.mode = 'follow'; // Малой сам идёт за игроком
  }

  get objective() {
    switch (this.stage) {
      case 'intro': return this.talking ? '' : 'Лагерь: поговори с другом в палатке';
      case 'escort': return 'Доведи Малого живым до города';
      case 'done': return 'Малой в безопасности — задание выполнено';
      case 'failed': return 'Задание провалено: Малой погиб';
      default: return '';
    }
  }

  // Куда ставить маркер «!» и компас: друг в палатке на intro, Малой на escort.
  get markerPos() {
    if (this.stage === 'intro' && this.giver) {
      return { x: this.giver.x, y: this.giver.y + 2.1, z: this.giver.z };
    }
    if (this.stage === 'escort' && this.ward && !this.ward.dead) {
      return { x: this.ward.x, y: this.ward.y + 2.3, z: this.ward.z };
    }
    return null;
  }

  inCity(f) {
    if (!f) return false;
    const pad = this.cfg.arrivePad;
    return Math.abs(f.x - this.city.cx) <= this.city.halfW + pad &&
      Math.abs(f.z - this.city.cz) <= this.city.halfD + pad;
  }

  // Тик логики: субтитр у палатки и переходы escort → done | failed.
  update(dt, playerPos) {
    if (this.stage === 'intro') {
      if (!this.subtitleShown && this.nearGiver(playerPos)) {
        this.subtitleShown = true;
        this.subtitleT = this.cfg.subtitleTime;
        this.subtitleText = INTRO_SUBTITLE;
      }
      if (this.subtitleT > 0) this.subtitleT = Math.max(0, this.subtitleT - dt);
      return;
    }
    if (this.stage === 'escort') {
      if (!this.ward || this.ward.dead || this.ward.hp <= 0) {
        this.stage = 'failed';
        return;
      }
      if (this.inCity(this.ward)) {
        this.stage = 'done';
        this.lines = DONE_LINES; // городской друг благодарит
        this.line = 0;
        this.talking = true;
      }
    }
  }
}
