import * as THREE from 'three';

// Маркер «!» над целью квеста: спрайт с пиксельной текстурой 32×32, рисуется
// поверх мира (depthTest выключен), покачивается над целью. Цель задаёт quest.
export class Markers {
  constructor(cfg) {
    this.group = new THREE.Group();
    const mat = new THREE.SpriteMaterial({
      map: makeExclaimTexture(),
      depthTest: false,   // видно сквозь стены — маркер не теряется
      transparent: true,
      fog: true,          // туман гасит его вдали вместе с миром
    });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(0.9, 0.9, 0.9);
    this.sprite.renderOrder = 3; // поверх отладочного веера зрения (renderOrder 2)
    this.sprite.visible = false;
    this.group.add(this.sprite);
    this._t = 0;
  }

  addTo(scene) { scene.add(this.group); }

  // pos — { x, y, z } или null (спрятать). Покачивание — по синусу, детерминированно.
  update(pos, dt) {
    this._t += dt;
    if (!pos) {
      this.sprite.visible = false;
      return;
    }
    this.sprite.visible = true;
    this.sprite.position.set(pos.x, pos.y + Math.sin(this._t * 3) * 0.12, pos.z);
  }

  dispose() {
    this.sprite.material.map.dispose();
    this.sprite.material.dispose();
  }
}

// «!» на canvas 32×32: жёлтый восклицательный знак, NEAREST — пиксельный стиль.
function makeExclaimTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 32, 32);
  g.fillStyle = '#111318';       // тёмная подложка-обводка
  g.fillRect(11, 3, 10, 21);
  g.fillRect(11, 25, 10, 5);
  g.fillStyle = '#f2c53d';       // жёлтый знак
  g.fillRect(13, 5, 6, 17);
  g.fillRect(13, 26, 6, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}
