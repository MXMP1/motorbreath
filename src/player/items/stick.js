import * as THREE from 'three';
import { Item } from './item.js';

// Палка: замах по ЛКМ — разгон назад-вверх, затем рубящий удар вниз-вперёд.
export class StickItem extends Item {
  constructor(cfg) {
    super({ px: 0.4, py: -0.52, pz: -0.72, rx: -0.3, ry: 0.22, rz: -0.55 });
    this.cfg = cfg;
    this.label = 'палка';

    const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a6238, flatShading: true });
    const knobMat = new THREE.MeshLambertMaterial({ color: 0x6e4d2c, flatShading: true });
    const handMat = new THREE.MeshLambertMaterial({ color: 0xc9a07a, flatShading: true });

    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.95, 0.055), woodMat);
    shaft.position.y = 0.42;
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.2, 0.11), knobMat);
    knob.position.y = 0.92;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.17, 0.14), handMat);
    hand.position.y = 0.05;
    this.group.add(shaft, knob, hand);
    this.snapToBase();

    this.swinging = false;
    this.t = 0;
    this.hitDone = false;
    this.swings = 0;
    this.onHitAt = null; // вызывается ровно один раз в момент удара
  }

  startPrimary() {
    if (this.swinging) return false;
    this.swinging = true;
    this.t = 0;
    this.hitDone = false;
    return true;
  }

  update(dt, view) {
    const c = this.cfg.stick;
    const pose = { ...this.base };

    if (this.swinging) {
      this.t += dt;
      const p = Math.min(1, this.t / c.swingTime);
      const wind = Math.min(-1, p / 0.35);          // первая фаза: замах
      const strike = p <= 0.35 ? 0 : easeOutCubic((p - 0.35) / 0.65); // вторая: удар
      pose.rx = this.base.rx - 0.85 * wind - 2.1 * strike;
      pose.rz = this.base.rz + 0.45 * wind + 0.8 * strike;
      pose.ry = this.base.ry - 0.1 * wind - 0.15 * strike;
      pose.py = this.base.py + 0.1 * wind + 0.18 * strike;
      pose.pz = this.base.pz + 0.05 * wind - 0.1 * strike;

      if (!this.hitDone && p >= c.hitFraction) {
        this.hitDone = true;
        this.swings++;
        if (this.onHitAt) this.onHitAt();
      }
      if (p >= 1) this.swinging = false;
    }

    this.applyPose(dt, view, pose);
  }
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
