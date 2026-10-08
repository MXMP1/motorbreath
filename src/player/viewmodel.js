import * as THREE from 'three';
import { StickItem } from './items/stick.js';
import { PistolItem } from './items/pistol.js';

// Слой вьюмодели: своя сцена с камерой поверх мира (предмет не проваливается в стены).
// Хранит предметы в руках, переключает их с анимацией «убрал-достал»,
// принимает ЛКМ и раздаёт его текущему предмету.
export class Viewmodel {
  constructor(cfg) {
    this.cfg = cfg;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 5);

    this.scene.add(new THREE.HemisphereLight(0xe8eef8, 0x55514a, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(1.2, 2, 1.5);
    this.scene.add(key);

    // предметы: id -> { item, wrap }. wrap несёт анимацию переключения,
    // item двигает только свою внутреннюю группу (поза, отдача, покачивание).
    this.items = new Map();
    this.register('stick', new StickItem(cfg));
    this.register('pistol', new PistolItem(cfg));

    this.currentId = null;
    this.pendingId = null;
    this.switchT = 0;
    this.switched = false;
  }

  register(id, item) {
    const wrap = new THREE.Group();
    wrap.add(item.group);
    wrap.visible = false;
    this.scene.add(wrap);
    this.items.set(id, { item, wrap });
  }

  has(id) { return this.items.has(id); }
  get(id) { return this.items.get(id)?.item ?? null; }
  get current() { return this.items.get(this.currentId)?.item ?? null; }

  // Первый выбор — мгновенно; смена предмета — с анимацией уборки-доставания.
  // Выбор текущего предмета во время смены отменяет смену.
  select(id) {
    const entry = this.items.get(id);
    if (!entry) return false;

    if (id === this.currentId) {
      if (this.pendingId) {
        this.items.get(this.pendingId).wrap.visible = false;
        this.pendingId = null;
        this.switched = false;
        this.switchT = 0;
        entry.wrap.visible = true;
        entry.wrap.position.y = 0;
        entry.item.snapToBase();
        return true;
      }
      return false;
    }
    if (this.pendingId !== null) return false; // уже переключаемся — ждём конца

    if (this.currentId === null) {
      this.currentId = id;
      entry.wrap.visible = true;
      return true;
    }

    this.pendingId = id;
    this.switchT = this.cfg.hands.switchTime;
    this.switched = false;
    return true;
  }

  startPrimary() {
    if (this.pendingId !== null) return false; // руки заняты переключением
    return this.current ? this.current.startPrimary() : false;
  }

  update(dt, view) {
    if (this.pendingId !== null) {
      const total = Math.max(1e-4, this.cfg.hands.switchTime);
      this.switchT -= dt;
      const p = Math.min(1, 1 - Math.max(0, this.switchT) / total); // 0..1
      const lower = p < 0.5 ? p * 2 : (1 - p) * 2; // предмет ныряет и поднимается

      if (!this.switched && p >= 0.5) { // в нижней точке меняем предмет
        this.items.get(this.currentId).wrap.visible = false;
        this.items.get(this.pendingId).wrap.visible = true;
        this.switched = true;
      }
      const activeEntry = this.switched ? this.items.get(this.pendingId) : this.items.get(this.currentId);
      activeEntry.wrap.position.y = -lower * this.cfg.hands.lowerDepth;

      if (this.switchT <= 0) {
        const old = this.items.get(this.currentId);
        this.currentId = this.pendingId;
        this.pendingId = null;
        this.switched = false;
        this.switchT = 0;
        old.wrap.position.y = 0;
        this.items.get(this.currentId).wrap.position.y = 0;
      }
    }

    for (const { item } of this.items.values()) item.update(dt, view);
  }

  // Два прохода: мир (с очисткой), затем вьюмодель поверх (только очистка depth).
  // show=false — вьюмодель скрыта (в седле мотоцикла): рисуется только мир.
  render(renderer, scene, camera, aspect, show = true) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    if (!show) return;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
}
