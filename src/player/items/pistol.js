import * as THREE from 'three';
import { Item } from './item.js';

// Пистолет: полуавтомат по ЛКМ. Выстрел мгновенный — хитсякан делает main,
// вьюмодель отвечает за отдачу, уход слайда назад и вспышку у дула.
export class PistolItem extends Item {
  constructor(cfg) {
    super({ px: 0.28, py: -0.34, pz: -0.5, rx: -0.06, ry: 0.1, rz: 0 });
    this.cfg = cfg;
    this.label = 'пистолет';
    // поза «в прицеле» (ПКМ): ствол по центру экрана, планки на уровне глаз
    this.aimBase = { px: 0, py: -0.16, pz: -0.46, rx: 0, ry: 0, rz: 0 };

    const steel = new THREE.MeshLambertMaterial({ color: 0x3d4046, flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: 0x24262b, flatShading: true });
    const gripMat = new THREE.MeshLambertMaterial({ color: 0x4f3f2f, flatShading: true });
    const handMat = new THREE.MeshLambertMaterial({ color: 0xc9a07a, flatShading: true });

    // рамка
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.1, 0.34), dark);
    frame.position.set(0, 0.02, -0.05);
    this.group.add(frame);

    // слайд (уезжает назад при отдаче)
    this.slide = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.085, 0.4), steel);
    this.slide.position.set(0, 0.09, -0.07);
    this.group.add(this.slide);

    // ствол-носик и мушка — передняя планка прицела, приземистая
    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.06), dark);
    muzzle.position.set(0, 0.06, -0.3);
    this.group.add(muzzle);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.022, 0.02), dark);
    sight.position.set(0, 0.149, -0.22);
    this.group.add(sight);

    // задние планки на слайде: две стойки с разрезом по центру — целик для ПКМ
    const rearL = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.024, 0.03), dark);
    rearL.position.set(-0.022, 0.06, 0.155);
    this.slide.add(rearL);
    const rearR = rearL.clone();
    rearR.position.x = 0.022;
    this.slide.add(rearR);

    // рукоять под наклоном + основание магазина
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 0.13), gripMat);
    grip.position.set(0, -0.1, 0.08);
    grip.rotation.x = 0.28;
    this.group.add(grip);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.12), dark);
    mag.position.set(0, -0.215, 0.115);
    mag.rotation.x = 0.28;
    this.group.add(mag);

    // рука на рукояти
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.16), handMat);
    hand.position.set(0.005, -0.1, 0.1);
    this.group.add(hand);

    // вспышка у дула: яркий кубик + точечный свет
    this.flash = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.18),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9 }),
    );
    this.flash.position.set(0, 0.06, -0.36);
    this.flash.visible = false;
    this.group.add(this.flash);

    this.flashLight = new THREE.PointLight(0xffd27a, 0, 1.5);
    this.flashLight.position.set(0, 0.06, -0.36);
    this.group.add(this.flashLight);

    this.snapToBase();

    this.cooling = 0;
    this.pendingShot = false;
    this.recoil = 0;
    this.flashT = 0;
    this.shots = 0;
    this.aimK = 0; // 0 — в руке, 1 — полностью в прицеле
    this.onFireAt = null; // вызывается ровно один раз на выстрел
  }

  startPrimary() {
    if (this.cooling > 0) return false;
    const c = this.cfg.pistol;
    this.cooling = c.fireCooldown;
    this.pendingShot = true; // сам выстрел случится на ближайшем update
    this.recoil = 1;
    this.flashT = c.muzzleFlashTime;
    return true;
  }

  update(dt, view) {
    const c = this.cfg.pistol;
    this.cooling = Math.max(0, this.cooling - dt);

    if (this.pendingShot) {
      this.pendingShot = false;
      this.shots++;
      if (this.onFireAt) this.onFireAt();
    }

    // затухание отдачи и вспышки
    this.recoil = Math.max(0, this.recoil - dt / c.recoilTime);
    this.flashT = Math.max(0, this.flashT - dt);
    this.flash.visible = this.flashT > 0;
    this.flashLight.intensity = this.flashT > 0 ? 6 * (this.flashT / c.muzzleFlashTime) : 0;
    // слайд отходит назад в момент выстрела
    this.slide.position.z = -0.07 + this.recoil * 0.07;
    this.slide.position.y = 0.09 + this.recoil * 0.005;

    // ПКМ-прицел: поза плавно съезжает на aimBase — планки по центру экрана
    const aimTarget = view.aim ? 1 : 0;
    this.aimK += (aimTarget - this.aimK) * (1 - Math.exp(-c.aimSpeed * dt));
    if (Math.abs(aimTarget - this.aimK) < 1e-3) this.aimK = aimTarget;
    const k = this.aimK;
    const b = this.base;
    const a = this.aimBase;

    const pose = {
      px: b.px + (a.px - b.px) * k,
      py: b.py + (a.py - b.py) * k + this.recoil * 0.05,
      pz: b.pz + (a.pz - b.pz) * k + this.recoil * 0.09,
      rx: b.rx + (a.rx - b.rx) * k - this.recoil * c.recoil,
      ry: b.ry + (a.ry - b.ry) * k,
      rz: b.rz + (a.rz - b.rz) * k,
    };
    this.applyPose(dt, view, pose);
  }
}
