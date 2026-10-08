// Ввод: клавиатура + мышь. Без DOM-зависимостей кроме событий на document,
// которые подвешиваются из main.js.
export class Input {
  constructor(controls) {
    this.controls = controls; // PointerLockControls — чтобы знать, захвачена ли мышь
    this.keys = new Set();
    this.pressed = [];        // нажатия за кадр (для хоткеев V/F3/R/G)
    this.attackQueued = false;
    this.rmb = false;         // ПКМ удерживается: прицел пистолета

    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed.push(e.code);
      this.keys.add(e.code);
      // не даём пробелу скроллить страницу, а F3 — открывать поиск браузера
      if (e.code === 'Space' || e.code === 'F3') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.rmb = false; });

    window.addEventListener('mousedown', (e) => {
      if (!this.controls.isLocked) return;
      if (e.button === 0) this.attackQueued = true;
      else if (e.button === 2) this.rmb = true; // ПКМ: пистолет в прицел
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rmb = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // колесо мыши — перебор слотов (только при захваченной мыши)
    window.addEventListener('wheel', (e) => {
      if (!this.controls.isLocked) return;
      this.pressed.push(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    }, { passive: true });
  }

  get forward() { return this.keys.has('KeyW'); }
  get back() { return this.keys.has('KeyS'); }
  get left() { return this.keys.has('KeyA'); }
  get right() { return this.keys.has('KeyD'); }
  get sprint() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }
  get crouch() { return this.keys.has('KeyC'); }
  get jump() { return this.keys.has('Space'); }

  // Список нажатий за текущий тик (очищается).
  consumePressed() {
    const list = this.pressed;
    this.pressed = [];
    return list;
  }

  consumeAttack() {
    const a = this.attackQueued;
    this.attackQueued = false;
    return a;
  }
}
