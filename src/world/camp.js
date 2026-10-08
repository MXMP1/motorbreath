import * as THREE from 'three';
import { mergeGeometries } from './merge.js';
import { SHELL, makeBodyGeometry } from './npc.js';

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const HEAD_STAND = 1.66; // центр головы стоящего — как у городских NPC
const HEAD_SIT = 1.18;   // голова сидящего на земле
const TENT_HALF = 2.1;   // половина ширины палатки до гребня, м (внутри — стол и друг)
const TENT_TOP = 2.3;    // высота гребня палатки, м: стоящий человек помещается
const TENT_DEPTH = 4.2;  // глубина палатки, м
const TENT_WALL = 0.55;  // ширина коллайдера-стены вдоль ската: середина прохода открыта
const HEAD_TURN = 2.2;   // насколько голова отворачивается от тела, рад

// Лагерь на стороне карты напротив города: палатка, кострище и вешалки с бельём.
// Тут респаун игрока; позже — место первых квестов.
// Рядом живут дружелюбные: двое у костра и один у палатки сидят, один стоит у вешалок.
// Когда игрок подходит ближе lookRange, их головы поворачиваются за ним.
export class Camp {
  constructor(cfg, world) {
    this.cfg = cfg.camp;
    this.city = cfg.city; // городской друг стоит в центре города — элемент задания
    this.palette = cfg.palette;
    this.world = world; // нужна карта высот: все объекты лагеря садятся на рельеф
    this.group = new THREE.Group();
    this.colliders = []; // палатка, столбы и полоса белья — сквозь них не пройти
    this.friends = [];   // дружелюбные: позиция, поза и угол головы
    this.coverBoxes = []; // коробки для грида укрытий: сквозь палатку NPC не видит игрока

    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._t = 0; // время для огня: пламя и свет костра ходят по синусам

    this._buildTent();
    this._buildCampfire();
    this._buildRacks();
    this._buildFriends();

    // тени от костра: их рисуют только объекты лагеря — дёшево и читаемо у огня
    if (this.cfg.fireShadows) this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.group.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
    for (const m of this.flame.children) m.castShadow = false; // само пламя тень не бросает
  }

  _groundAt(x, z) {
    const lift = this.world.cityLift ? this.world.cityLift(x, z) : 0; // горожанин — на покрытии
    return this.world.heightmap.heightAt(x, z) + lift;
  }

  // Палатка: два ската и задняя стенка-треугольник, вход смотрит в лагерь.
  // Внутри — стол у задней стенки; вход открыт, внутрь можно зайти.
  _buildTent() {
    const c = this.cfg;
    const x = c.x + 2;
    const z = c.z - 7;
    const gy = this._groundAt(x, z);
    this.tent = { x, z, gy, half: TENT_HALF, top: TENT_TOP, depth: TENT_DEPTH };

    const mat = new THREE.MeshLambertMaterial({ color: this.palette.tent, flatShading: true });
    const slope = Math.hypot(TENT_HALF, TENT_TOP);
    const alpha = Math.atan2(TENT_TOP, TENT_HALF);

    const left = new THREE.Mesh(new THREE.BoxGeometry(slope, 0.06, TENT_DEPTH), mat);
    left.position.set(x - TENT_HALF / 2, gy + TENT_TOP / 2, z);
    left.rotation.z = alpha;
    this.group.add(left);

    const right = new THREE.Mesh(left.geometry, mat);
    right.position.set(x + TENT_HALF / 2, gy + TENT_TOP / 2, z);
    right.rotation.z = -alpha;
    this.group.add(right);

    // задняя стенка: треугольник из трёх вершин, виден с обеих сторон
    const backGeo = new THREE.BufferGeometry();
    backGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -TENT_HALF, 0, 0, TENT_HALF, 0, 0, 0, TENT_TOP, 0,
    ], 3));
    backGeo.computeVertexNormals();
    const back = new THREE.Mesh(backGeo, new THREE.MeshLambertMaterial({
      color: this.palette.tentDark, flatShading: true, side: THREE.DoubleSide,
    }));
    back.position.set(x, gy, z - TENT_DEPTH / 2);
    this.group.add(back);

    // стены-коллайдеры вдоль скатов и задник: вход с юга открыт, внутрь можно войти
    const half = TENT_DEPTH / 2;
    this.colliders.push({
      minX: x - TENT_HALF - 0.12, maxX: x - TENT_HALF + TENT_WALL,
      minZ: z - half - 0.1, maxZ: z + half + 0.1,
      minY: gy - 0.5, maxY: gy + TENT_TOP,
    });
    this.colliders.push({
      minX: x + TENT_HALF - TENT_WALL, maxX: x + TENT_HALF + 0.12,
      minZ: z - half - 0.1, maxZ: z + half + 0.1,
      minY: gy - 0.5, maxY: gy + TENT_TOP,
    });
    this.colliders.push({
      minX: x - TENT_HALF - 0.12, maxX: x + TENT_HALF + 0.12,
      minZ: z - half - 0.1, maxZ: z - half + 0.45,
      minY: gy - 0.5, maxY: gy + TENT_TOP,
    });
    // сквозь палатку враждебные не видят игрока — как сквозь дом
    this.coverBoxes.push({
      minX: x - TENT_HALF - 0.12, maxX: x + TENT_HALF + 0.12,
      minZ: z - half - 0.1, maxZ: z + half + 0.1,
    });

    // стол в дальней части палатки: за ним сидит пятый друг, лицом к входу
    const table = [];
    const top = new THREE.BoxGeometry(1.5, 0.06, 0.7);
    top.translate(x, gy + 0.52, z - 0.55);
    table.push(top);
    for (const dx of [-0.62, 0.62]) {
      const leg = new THREE.BoxGeometry(0.12, 0.52, 0.6);
      leg.translate(x + dx, gy + 0.26, z - 0.55);
      table.push(leg);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(table),
      new THREE.MeshLambertMaterial({ color: this.palette.trunk, flatShading: true })));
    this.colliders.push({ // стол тоже не пропускает: сидящий — за ним, ноги под столешницей
      minX: x - 0.78, maxX: x + 0.78,
      minZ: z - 0.95, maxZ: z - 0.15,
      minY: gy - 0.5, maxY: gy + 0.6,
    });
  }

  // Кострище: кольцо камней, пепел с тлеющими углями и пара поленьев.
  _buildCampfire() {
    const c = this.cfg;
    const x = c.x - 2;
    const z = c.z + 2;
    const gy = this._groundAt(x, z);
    this.campfire = { x, z };

    const stones = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.35;
      const g = new THREE.BoxGeometry(0.3, 0.22, 0.3);
      g.rotateY(a * 1.7);
      g.translate(x + Math.cos(a) * 0.85, gy + 0.08, z + Math.sin(a) * 0.85);
      stones.push(g);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(stones),
      new THREE.MeshLambertMaterial({ color: this.palette.rock, flatShading: true })));

    const ash = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.07, 1.05),
      new THREE.MeshLambertMaterial({ color: this.palette.ash, flatShading: true }));
    ash.position.set(x, gy + 0.035, z);
    this.group.add(ash);

    const coals = [];
    const spots = [[-0.22, 0.16, 1.9], [0.18, -0.2, -2.6], [0.05, 0.24, 0.7]];
    for (const [dx, dz, sp] of spots) {
      const g = new THREE.BoxGeometry(0.17, 0.09, 0.17);
      g.rotateY(sp);
      g.translate(x + dx, gy + 0.1, z + dz);
      coals.push(g);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(coals),
      new THREE.MeshLambertMaterial({ color: this.palette.ember, flatShading: true })));

    const logs = [];
    const logSpots = [[1.05, 0.45, 0.5], [-0.95, -0.7, -0.3]];
    for (const [dx, dz, ry] of logSpots) {
      const g = new THREE.CylinderGeometry(0.07, 0.07, 0.95, 5);
      g.rotateZ(Math.PI / 2);
      g.rotateY(ry);
      g.translate(x + dx, gy + 0.08, z + dz);
      logs.push(g);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(logs),
      new THREE.MeshLambertMaterial({ color: this.palette.trunk, flatShading: true })));

    // пламя: три кубика — в update «дышат» по синусам; дёшево и живо
    this.flame = new THREE.Group();
    const flameMat = new THREE.MeshBasicMaterial({ color: this.palette.fire });
    const coreMat = new THREE.MeshBasicMaterial({ color: this.palette.fireCore });
    const big = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.38, 0.3), flameMat);
    const side1 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), coreMat);
    side1.position.set(-0.16, -0.06, 0.1);
    const side2 = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.18, 0.13), coreMat);
    side2.position.set(0.15, -0.08, -0.09);
    this.flame.add(big, side1, side2);
    this._fireBase = gy + 0.35;
    this.flame.position.set(x, this._fireBase, z);
    this.group.add(this.flame);

    // свет костра: тёплый, мерцает; тени (по кнобу fireShadows) рисуют только
    // объекты лагеря — минимальная карта 256, пиксельный BasicShadowMap
    this.fireLight = new THREE.PointLight(this.palette.fire, c.fireLight, 14, 2);
    this.fireLight.position.set(x, gy + 1.05, z);
    if (c.fireShadows) {
      this.fireLight.castShadow = true;
      this.fireLight.shadow.mapSize.set(256, 256);
      this.fireLight.shadow.camera.near = 0.3;
      this.fireLight.shadow.camera.far = 14;
      this.fireLight.shadow.bias = -0.004;
    }
    this.group.add(this.fireLight);
  }

  // Вешалки с бельём: две стойки с перекладиной и три тряпки вразнобой.
  _buildRacks() {
    const c = this.cfg;
    const x = c.x + 5;
    const z = c.z + 6;
    const gy = this._groundAt(x, z);

    const poles = [];
    for (const dx of [-1.4, 1.4]) {
      const p = new THREE.BoxGeometry(0.09, 2.2, 0.09);
      p.translate(x + dx, gy + 1.1, z);
      poles.push(p);
    }
    const bar = new THREE.BoxGeometry(2.95, 0.08, 0.08);
    bar.translate(x, gy + 2.16, z);
    poles.push(bar);
    this.group.add(new THREE.Mesh(mergeGeometries(poles),
      new THREE.MeshLambertMaterial({ color: this.palette.trunk, flatShading: true })));

    const cloths = [this.palette.clothA, this.palette.clothB, this.palette.clothC];
    const clothX = [-0.85, 0.05, 0.9];
    for (let i = 0; i < cloths.length; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.95, 0.03),
        new THREE.MeshLambertMaterial({ color: cloths[i], flatShading: true }));
      m.position.set(x + clothX[i], gy + 1.62, z);
      m.rotation.y = (i - 1) * 0.1;
      m.rotation.z = (i - 1) * 0.05;
      this.group.add(m);
    }

    for (const dx of [-1.4, 1.4]) {
      this.colliders.push({
        minX: x + dx - 0.1, maxX: x + dx + 0.1,
        minZ: z - 0.1, maxZ: z + 0.1,
        minY: gy - 0.4, maxY: gy + 2.2,
      });
    }
    this.colliders.push({ // полоса белья тоже не пропускает
      minX: x - 1.25, maxX: x + 1.25,
      minZ: z - 0.08, maxZ: z + 0.08,
      minY: gy + 1.05, maxY: gy + 2.1,
    });
  }

  // Дружелюбные: тела — статичные instanced-меши, головы — свои матрицы (следят за игроком).
  _buildFriends() {
    const c = this.cfg;
    const fx = c.x - 2; // ориентир взгляда в покое — костёр
    const fz = c.z + 2;
    const t = this.tent;
    const list = [
      { x: c.x + 3.2, z: c.z - 3.8, sit: true },           // у входа в палатку
      { x: c.x - 3.3, z: c.z + 1.1, sit: true },           // у костра слева
      { x: c.x - 0.6, z: c.z + 3.3, sit: true },           // у костра справа
      { x: c.x + 3.8, z: c.z + 4.7, sit: false },          // у вешалок
      { x: t.x, z: t.z - 1.35, sit: true, yaw: 0 },        // в палатке за столом, лицом к входу
      { x: this.city.cx, z: this.city.cz, sit: false, yaw: Math.PI / 2 }, // в центре города: элемент задания
    ];
    for (const f of list) {
      f.y = this._groundAt(f.x, f.z);
      if (f.yaw === undefined) f.yaw = Math.atan2(fx - f.x, fz - f.z); // в покое смотрят на костёр
      f.headYaw = 0; // доворот головы к игроку поверх поворота тела
      f.headY = f.sit ? HEAD_SIT : HEAD_STAND;
    }
    this.friends = list;

    const nSit = list.filter((f) => f.sit).length;
    const nStand = list.length - nSit;
    const bodyMat = new THREE.MeshLambertMaterial({ color: this.palette.friendBody, flatShading: true });
    const headMat = new THREE.MeshLambertMaterial({ color: this.palette.npcHead, flatShading: true });
    const shellMat = new THREE.MeshBasicMaterial({ color: this.palette.npcOutline, side: THREE.BackSide });

    this.sitBody = new THREE.InstancedMesh(makeSitGeometry(), bodyMat, nSit);
    this.sitShell = new THREE.InstancedMesh(makeSitGeometry(SHELL), shellMat, nSit);
    this.standBody = new THREE.InstancedMesh(makeBodyGeometry(), bodyMat, nStand);
    this.standShell = new THREE.InstancedMesh(makeBodyGeometry(SHELL), shellMat, nStand);
    this.head = new THREE.InstancedMesh(makeFriendHead(), headMat, list.length);
    this.headShell = new THREE.InstancedMesh(makeFriendHead(SHELL), shellMat, list.length);
    this.head.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.headShell.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.parts = [this.sitBody, this.sitShell, this.standBody, this.standShell, this.head, this.headShell];
    for (const m of this.parts) {
      m.frustumCulled = false; // инстансы разбросаны — автосфера отсечения врёт
      this.group.add(m);
    }

    // тела ставятся один раз: позы статичны
    let si = 0;
    let ti = 0;
    for (const f of list) {
      const idx = f.sit ? si++ : ti++;
      const body = f.sit ? this.sitBody : this.standBody;
      const shell = f.sit ? this.sitShell : this.standShell;
      this._q.setFromAxisAngle(UP, f.yaw);
      this._p.set(f.x, f.y, f.z);
      this._m.compose(this._p, this._q, ONE);
      body.setMatrixAt(idx, this._m);
      shell.setMatrixAt(idx, this._m);
    }
    this._syncHeads();
  }

  // Игрок рядом — головы поворачиваются на него; ушёл — возвращаются к костру.
  update(dt, p) {
    const c = this.cfg;
    this._t += dt;

    // огонь: пламя дрожит, свет мерцает — детерминированно, без rng
    const t = this._t;
    this.flame.position.y = this._fireBase + 0.05 * Math.sin(t * 9.1) + 0.02 * Math.sin(t * 23.7);
    const fc = this.flame.children;
    fc[0].scale.set(
      1 + 0.16 * Math.sin(t * 13.7),
      1 + 0.28 * Math.sin(t * 11.3 + 1.2),
      1 + 0.16 * Math.sin(t * 12.1 + 2.1),
    );
    fc[1].scale.y = 1 + 0.5 * Math.sin(t * 17.3 + 0.7);
    fc[2].scale.y = 1 + 0.5 * Math.sin(t * 19.1 + 2.8);
    this.fireLight.intensity = c.fireLight * (0.95 + 0.22 * Math.sin(t * 15.3) * Math.sin(t * 7.7 + 1.3));

    const k = 1 - Math.exp(-c.lookSpeed * dt);
    for (const f of this.friends) {
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      let want = 0;
      if (dx * dx + dz * dz < c.lookRange * c.lookRange) {
        let d = Math.atan2(dx, dz) - f.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d)); // кратчайший разворот
        want = d < -HEAD_TURN ? -HEAD_TURN : d > HEAD_TURN ? HEAD_TURN : d;
      }
      f.headYaw += (want - f.headYaw) * k;
    }
    this._syncHeads();
  }

  _syncHeads() {
    const n = this.friends.length;
    for (let i = 0; i < n; i++) {
      const f = this.friends[i];
      this._q.setFromAxisAngle(UP, f.yaw + f.headYaw);
      this._p.set(f.x, f.y + f.headY, f.z);
      this._m.compose(this._p, this._q, ONE);
      this.head.setMatrixAt(i, this._m);
      this.headShell.setMatrixAt(i, this._m);
    }
    this.head.instanceMatrix.needsUpdate = true;
    this.headShell.instanceMatrix.needsUpdate = true;
  }
}

// Сидящее тело: таз, торс и вытянутые вперёд ноги; происхождение — на земле.
function makeSitGeometry(inflate = 0) {
  const hips = new THREE.BoxGeometry(0.46 + inflate, 0.3 + inflate, 0.42 + inflate);
  hips.translate(0, 0.3, 0.02);
  const torso = new THREE.BoxGeometry(0.52 + inflate, 0.6 + inflate, 0.32 + inflate);
  torso.translate(0, 0.72, 0);
  const legs = new THREE.BoxGeometry(0.4 + inflate, 0.24 + inflate, 0.62 + inflate);
  legs.translate(0, 0.14, 0.35);
  return mergeGeometries([hips, torso, legs]);
}

// Голова дружелюбного: геометрия вокруг шеи — матрица задаёт и позицию, и поворот.
function makeFriendHead(inflate = 0) {
  return new THREE.BoxGeometry(0.3 + inflate, 0.3 + inflate, 0.3 + inflate);
}
