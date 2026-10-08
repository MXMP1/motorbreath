import * as THREE from 'three';

// Базовый предмет в руках: группа, поза покоя, покачивание шага и сглаживание позы.
// Наследники строят свою геометрию и меняют позу (замах/отдача) в update().
export class Item {
  constructor(base) {
    this.group = new THREE.Group();
    this.base = base; // { px, py, pz, rx, ry, rz } — поза покоя в руке
    this.bobPhase = 0;
  }

  // Применяет позу с добавкой покачивания при ходьбе и мягким сглаживанием.
  applyPose(dt, view, pose) {
    let { px, py, pz, rx, ry, rz } = pose;

    // покачивание при ходьбе (в прицеле почти незаметно — ствол держим ровно)
    this.bobPhase += dt * view.speed * 1.9;
    const amp = (view.onGround ? Math.min(1, view.speed / 6) : 0.15) * (view.aim ? 0.3 : 1);
    px += Math.cos(this.bobPhase) * 0.01 * amp;
    py += Math.sin(this.bobPhase * 2) * 0.014 * amp;

    const k = 1 - Math.exp(-22 * dt);
    this.group.position.x += (px - this.group.position.x) * k;
    this.group.position.y += (py - this.group.position.y) * k;
    this.group.position.z += (pz - this.group.position.z) * k;
    this.group.rotation.x += (rx - this.group.rotation.x) * k;
    this.group.rotation.y += (ry - this.group.rotation.y) * k;
    this.group.rotation.z += (rz - this.group.rotation.z) * k;
  }

  snapToBase() {
    const b = this.base;
    this.group.position.set(b.px, b.py, b.pz);
    this.group.rotation.set(b.rx, b.ry, b.rz);
  }

  // Переопределяется наследниками.
  startPrimary() { return false; }
  update() {}
}
