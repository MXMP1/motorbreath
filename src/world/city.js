import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';

// Городская застройка: дома и дорожные знаки. Единственные модули проекта,
// которые рисуют на canvas — пиксель-текстуры стен и табличек.

// Дома-коробки с процедурными пиксель-текстурами стен (рисуем на canvas, без ассетов).
// Возвращает группу для сцены и список AABB-коллайдеров для физики.
export function createBuildings(list, cfg) {
  const group = new THREE.Group();
  const colliders = [];
  const rng = mulberry32((cfg.seed ^ 0x2545f491) >>> 0);

  const texA = makeWallTexture(cfg, 'A', rng);
  const texB = makeWallTexture(cfg, 'B', rng);
  const roofMat = new THREE.MeshLambertMaterial({ color: cfg.palette.roof, flatShading: true });

  for (const b of list) {
    const base = b.ground - 1.2; // утапливаем фундамент: углы не должны висеть над склоном
    const geo = new THREE.BoxGeometry(b.w, b.h, b.d);

    // окна одного размера на всех домах: повторяем текстуру по размеру стены
    const src = b.kind === 'tall' ? texA : texB;
    const texX = cloneRepeating(src, Math.round(b.w / 5), Math.round(b.h / 4));
    const texZ = cloneRepeating(src, Math.round(b.d / 5), Math.round(b.h / 4));

    const wallX = new THREE.MeshLambertMaterial({ map: texX });
    const wallZ = new THREE.MeshLambertMaterial({ map: texZ });
    // порядок материалов BoxGeometry: +x, -x, +y, -y, +z, -z
    const mesh = new THREE.Mesh(geo, [wallX, wallX, roofMat, roofMat, wallZ, wallZ]);
    mesh.position.set(b.x, base + b.h / 2, b.z);
    group.add(mesh);

    colliders.push({
      minX: b.x - b.w / 2, maxX: b.x + b.w / 2,
      minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2,
      minY: base, maxY: base + b.h,
    });
  }

  return { group, colliders };
}

// Дорожные знаки: столб + квадратная табличка с пиксель-рисунком (canvas 32x32).
// Три типа: «40», пешеходный переход, «!». Табличка — тонкий бокс: «лицо» спереди
// и сзади, боковины серые. Текстуры и материалы общие на все знаки одного типа.
export class Signs {
  constructor(list, cfg) {
    this.group = new THREE.Group();

    const poleMat = new THREE.MeshLambertMaterial({ color: cfg.palette.signPole });
    const sideMat = new THREE.MeshLambertMaterial({ color: 0x7d838a });
    const faceMats = {
      limit: new THREE.MeshLambertMaterial({ map: makeFaceTexture(cfg, 'limit') }),
      crossing: new THREE.MeshLambertMaterial({ map: makeFaceTexture(cfg, 'crossing') }),
      warn: new THREE.MeshLambertMaterial({ map: makeFaceTexture(cfg, 'warn') }),
    };

    const h = cfg.street.signHeight;
    const size = cfg.street.signSize;
    const poleGeo = new THREE.CylinderGeometry(0.035, 0.045, h, 6);
    const plateGeo = new THREE.BoxGeometry(0.08, size, size);

    for (const s of list) {
      const g = new THREE.Group();

      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = h / 2;
      g.add(pole);

      const face = faceMats[s.type] || faceMats.limit;
      // порядок материалов бокса: +x, -x, +y, -y, +z, -z; «лицо» — на широких
      // плоскостях (±x); рёбра таблички (толщина 0.08) серые
      const plate = new THREE.Mesh(plateGeo, [face, face, sideMat, sideMat, sideMat, sideMat]);
      plate.position.y = h - size / 2;
      g.add(plate);

      g.position.set(s.x, s.y, s.z);
      g.rotation.y = s.ry;
      this.group.add(g);
    }
  }
}

function cloneRepeating(src, rx, ry) {
  const tex = src.clone();
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, rx), Math.max(1, ry));
  return tex;
}

// Пиксель-текстура стены 64x64: базовый цвет, потёки, сетка окон (часть горит тёплым светом).
function makeWallTexture(cfg, variant, rng) {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const g = cv.getContext('2d');
  const p = cfg.palette;

  g.fillStyle = variant === 'A' ? p.wallA : p.wallB;
  g.fillRect(0, 0, 64, 64);

  // грязь и потёки
  for (let i = 0; i < 140; i++) {
    g.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
    g.fillRect((rng() * 64) | 0, (rng() * 64) | 0, 1 + ((rng() * 3) | 0), 1);
  }

  // окна 10x8, сетка 4x5 с равными отступами
  const ww = 10, wh = 8, cols = 4, rows = 5;
  const gapX = (64 - cols * ww) / (cols + 1);
  const gapY = (64 - rows * wh) / (rows + 1);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x = Math.round(gapX + rx * (ww + gapX));
      const y = Math.round(gapY + ry * (wh + gapY));
      g.fillStyle = rng() < 0.25 ? p.windowLit : p.windowDark;
      g.fillRect(x, y, ww, wh);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x, y + wh - 1, ww, 1); // тень подоконника
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(x, y, ww, 1); // блик
    }
  }

  return pixelTexture(cv);
}

// Пиксель-табличка 32x32: цвета из палитры, NearestFilter.
function makeFaceTexture(cfg, type) {
  const cv = document.createElement('canvas');
  cv.width = 32;
  cv.height = 32;
  const g = cv.getContext('2d');
  const p = cfg.palette;

  g.fillStyle = p.signWhite;
  g.fillRect(0, 0, 32, 32);

  if (type === 'limit') {
    g.strokeStyle = p.signRed;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(16, 16, 11.5, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = p.signInk;
    g.font = 'bold 13px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('40', 16, 17);
  } else if (type === 'crossing') {
    g.fillStyle = p.signBlue;
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = p.signWhite;
    for (let i = 0; i < 4; i++) g.fillRect(5 + i * 6, 6, 3, 20); // зебра
  } else {
    g.fillStyle = p.signYellow;
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = p.signInk;
    g.fillRect(14, 6, 4, 13); // восклицательный знак
    g.fillRect(14, 23, 4, 4);
  }

  return pixelTexture(cv);
}

// Общая настройка пиксельной текстуры: без сглаживания, sRGB.
function pixelTexture(cv) {
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
