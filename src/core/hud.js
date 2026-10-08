// HUD: fps, фреймтайм, позиция, скорость, состояние, разрешение.
// DOM обновляется порциями (раз в 0.15 с), чтобы не тормозить кадр на каждый шаг физики.
export class Hud {
  constructor() {
    this.el = document.getElementById('hud');
    this.hint = document.getElementById('hint');
    this.acc = 0;
    this.fps = 0;
    this.visible = true;
  }

  update(dt, s) {
    const inst = 1 / Math.max(dt, 1e-4);
    this.fps = this.fps === 0 ? inst : this.fps * 0.92 + inst * 0.08;

    this.acc += dt;
    if (this.acc < 0.15) return;
    this.acc = 0;

    this.el.textContent =
      `fps ${this.fps.toFixed(0)}   кадр ${(1000 / this.fps).toFixed(1)} мс\n` +
      `позиция ${s.pos.x.toFixed(1)} ${s.pos.y.toFixed(1)} ${s.pos.z.toFixed(1)}\n` +
      `скорость ${s.speed.toFixed(1)} м/с   ${s.state}\n` +
      `руки: ${s.item} [${s.slot}]   разрешение ${s.res}   сид ${s.seed}\n` +
      `манекены ${s.awake}   баки ${s.bins}   мешки ${s.bags}   качается ${s.swaying}   искры ${s.sparks}`;
  }

  setHintVisible(v) {
    this.hint.classList.toggle('hidden', !v);
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }
}
