import * as THREE from 'three';

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

  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
