import * as THREE from 'three';
import { mergeGeometries } from '../core/merge.js';

// Геометрия NPC: чистые билдеры мешей, без состояния.
// Лагерь дружелюбных переиспользует SHELL и makeBodyGeometry для стоящих.

export const SHELL = 0.07; // на сколько тёмный контур раздувает тело, м — силуэт читается вдали

// Тело NPC: куртка + ноги, один слитый меш; происхождение — на уровне ног.
// inflate — раздутие для тёмного контура силуэта (рисуется BackSide).
export function makeBodyGeometry(inflate = 0) {
  const torso = new THREE.BoxGeometry(0.52 + inflate, 0.78 + inflate, 0.3 + inflate);
  torso.translate(0, 1.11, 0);
  const legL = new THREE.BoxGeometry(0.18 + inflate, 0.72 + inflate, 0.2 + inflate);
  legL.translate(-0.13, 0.36, 0);
  const legR = legL.clone();
  legR.translate(0.26, 0, 0);
  return mergeGeometries([torso, legL, legR]);
}

export function makeHeadGeometry(inflate = 0) {
  const head = new THREE.BoxGeometry(0.3 + inflate, 0.3 + inflate, 0.3 + inflate);
  head.translate(0, 1.66, 0);
  return head;
}

// «Лицо»: тёмная полоса глаз на передней грани головы (центр 1.66, грань +z на 0.15).
export function makeFaceGeometry() {
  const face = new THREE.BoxGeometry(0.2, 0.05, 0.04);
  face.translate(0, 1.68, 0.16);
  return face;
}

// Лепесток веера зрения: единичный треугольник-луч угловой ширины span,
// центр — локальный +z. Масштаб инстанса задаёт длину луча, разворот — направление.
export function makeVisionSlice(span) {
  const half = span / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    Math.sin(-half), 0, Math.cos(-half),
    Math.sin(half), 0, Math.cos(half),
  ], 3));
  g.setIndex([0, 1, 2]);
  return g;
}

// Палка: происхождение у кисти, растёт вверх.
export function makeStickGeometry() {
  const g = new THREE.CylinderGeometry(0.035, 0.05, 1.05, 5);
  g.translate(0, 0.5, 0);
  return g;
}

// Пистолет: ствол вперёд и рукоятка вниз, происхождение — у кисти.
export function makeGunGeometry() {
  const barrel = new THREE.BoxGeometry(0.07, 0.09, 0.32);
  barrel.translate(0, 0.03, 0.13);
  const grip = new THREE.BoxGeometry(0.06, 0.16, 0.09);
  grip.translate(0, -0.09, 0.01);
  return mergeGeometries([barrel, grip]);
}
