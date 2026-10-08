// DOM-слой квеста: плашка диалога, строка цели с компасом и субтитр.
// Строка цели живёт ВНЕ #hud — HUD гаснет по F3, а цель должна быть видна всегда.
// Обновления кэшируются: текст в DOM пишется только когда реально изменился.

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

export class QuestUI {
  constructor() {
    this.objective = document.getElementById('objective');
    this.objArrow = document.getElementById('objective-arrow');
    this.objText = document.getElementById('objective-text');
    this.objDist = document.getElementById('objective-dist');
    this.subtitle = document.getElementById('subtitle');
    this.dialogue = document.getElementById('dialogue');
    this.dSpeaker = document.getElementById('dialogue-speaker');
    this.dText = document.getElementById('dialogue-text');
    this.dHint = document.getElementById('dialogue-hint');
    this._obj = null;
    this._sub = null;
    this._speaker = null;
    this._text = null;
  }

  // Субтитр друга в палатке: всплывает один раз и гаснет сам (без подсказки).
  setSubtitle(text) {
    const t = text || '';
    if (t === this._sub) return;
    this._sub = t;
    this.subtitle.textContent = t;
    this.subtitle.classList.toggle('on', !!t);
  }

  // Диалог: говорящий + реплика + подсказка «E — дальше» (на последней — «закрыть»).
  showDialogue(line, isLast) {
    this.dialogue.classList.add('on');
    if (line) {
      if (line.who !== this._speaker) {
        this._speaker = line.who;
        this.dSpeaker.textContent = line.who;
      }
      if (line.text !== this._text) {
        this._text = line.text;
        this.dText.textContent = line.text;
      }
    }
    this.dHint.textContent = isLast ? 'E — закрыть' : 'E — дальше';
  }

  hideDialogue() {
    this.dialogue.classList.remove('on');
    this._speaker = null;
    this._text = null;
  }

  // Строка цели: текст, стрелка-компас и дистанция до цели.
  setObjective(text, arrow, dist) {
    const t = text || '';
    if (t !== this._obj) {
      this._obj = t;
      this.objText.textContent = t;
    }
    this.objArrow.textContent = t ? (arrow || '') : '';
    this.objDist.textContent = (t && dist != null) ? `${dist.toFixed(0)} м` : '';
    this.objective.classList.toggle('on', !!t);
  }

  // Стрелка из 8 направлений: куда цель относительно курса камеры.
  // dirX/dirZ — курс камеры (world), toX/toZ — вектор на цель.
  static arrowFor(dirX, dirZ, toX, toZ) {
    const len = Math.hypot(toX, toZ);
    if (len < 1e-6) return '';
    const camAng = Math.atan2(dirX, dirZ);
    const tgtAng = Math.atan2(toX, toZ);
    const rel = Math.atan2(Math.sin(tgtAng - camAng), Math.cos(tgtAng - camAng)); // −π..π
    const idx = (Math.round(rel / (Math.PI / 4)) % 8 + 8) % 8; // 0 = прямо по курсу
    return ARROWS[idx];
  }
}
