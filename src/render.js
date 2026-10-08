import * as THREE from 'three';

// Рендерер: честный low-res (рисуем в маленький буфер, CSS растягивает),
// сцена, камера и базовый свет. Разрешение перебирается клавишей V.
export class Render {
  constructor(canvas, cfg) {
    this.cfg = cfg;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1); // пиксели — это пиксели
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap; // тени рисует только костёр лагеря — минимальная карта

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(cfg.palette.sky);
    this.scene.fog = new THREE.Fog(cfg.palette.fog, cfg.render.fogNear, cfg.render.fogFar);

    this.camera = new THREE.PerspectiveCamera(cfg.camera.fov, 1, cfg.camera.near, cfg.camera.far);
    this.camera.rotation.order = 'YXZ'; // обязательный порядок осей для FPS-обзора

    this.scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x4a4a3f, 1.0));
    const sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
    sun.position.set(60, 100, 35);
    this.scene.add(sun);

    this.resIndex = cfg.render.defaultRes;
    this._aspect = 1;
    this._size = new THREE.Vector2();

    window.addEventListener('resize', () => this.applyResolution());
    this.applyResolution();
  }

  get aspect() { return this._aspect; }

  // Размер буфера в пикселях (для HUD).
  get size() {
    this.renderer.getSize(this._size);
    return this._size;
  }

  applyResolution() {
    this._aspect = window.innerWidth / window.innerHeight;
    const h = this.cfg.render.resHeights[this.resIndex];
    const w = Math.max(2, Math.round(h * this._aspect));
    this.renderer.setSize(w, h, false); // рисуем в маленький буфер, CSS растягивает
    this.camera.aspect = this._aspect;
    this.camera.updateProjectionMatrix();
  }

  // V: следующее разрешение из списка.
  cycleResolution() {
    this.resIndex = (this.resIndex + 1) % this.cfg.render.resHeights.length;
    this.applyResolution();
  }
}
