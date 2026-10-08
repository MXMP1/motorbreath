import * as THREE from 'three';
import { mergeGeometries } from '../core/merge.js';
import { Friends } from './friends.js';

const TENT_HALF = 2.1;   // половина ширины палатки до гребня, м (внутри — стол и друг)
const TENT_TOP = 2.3;    // высота гребня палатки, м: стоящий человек помещается
const TENT_DEPTH = 4.2;  // глубина палатки, м
const TENT_WALL = 0.55;  // ширина коллайдера-стены вдоль ската: середина прохода открыта

// Лагерь на стороне карты напротив города: палатка, кострище и вешалки с бельём.
// Тут респаун игрока; позже — место первых квестов. Рядом живут дружелюбные —
// они вынесены в Friends, а лагерь отдаёт их наружу как свои поля.
export class Camp {
  constructor(cfg, world) {
    this.cfg = cfg.camp;
    this.city = cfg.city; // городской друг стоит в центре города — элемент задания
    this.palette = cfg.palette;
    this.world = world; // нужна карта высот: все объекты лагеря садятся на рельеф
    this.group = new THREE.Group();
    this.colliders = []; // палатка, столбы и полоса белья — сквозь них не пройти
    this.coverBoxes = []; // коробки для грида укрытий: сквозь палатку NPC не видит игрока
    this._t = 0; // время для огня: пламя и свет костра ходят по синусам

    this._buildTent();
    this._buildCampfire();
    this._buildRacks();
    this.people = new Friends(cfg, world, this.group, {
      tent: this.tent,
      fire: this.campfire,
      city: { cx: this.city.cx, cz: this.city.cz },
    });

    // тени от костра: их рисуют только объекты лагеря — дёшево и читаемо у огня
    if (this.cfg.fireShadows) this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.group.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
    for (const m of this.flame.children) m.castShadow = false; // само пламя тень не бросает
  }

  // ---------- дружелюбные: наружу отдаём их как поля лагеря ----------
  get friends() { return this.people.list; }
  get parts() { return this.people.parts; }
  get sitBody() { return this.people.sitBody; }
  get sitShell() { return this.people.sitShell; }
  get standBody() { return this.people.standBody; }
  get standShell() { return this.people.standShell; }
  get rideBody() { return this.people.rideBody; }
  get rideShell() { return this.people.rideShell; }
  get head() { return this.people.head; }
  get headShell() { return this.people.headShell; }
  get faces() { return this.people.faces; }

  interact(f) { return this.people.interact(f); }
  friendOf(object, instanceId) { return this.people.friendOf(object, instanceId); }
  // урон другу от враждебных NPC (спутник квеста): здоровье и падение
  damage(f, amount) { return this.people.damage(f, amount); }
  // сброс (R): друзья снова живы и на местах — квест можно пройти заново
  resetFriends() { this.people.resetAll(); }
  // авария: пассажира выбило из седла — дальше он лежит и встаёт сам
  ejectPassenger(b, fx, fz, speed, side) { return this.people.ejectPassenger(b, fx, fz, speed, side); }

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
    const big = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.6, 0.46), flameMat);
    const side1 = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.26), coreMat);
    side1.position.set(-0.24, -0.1, 0.15);
    const side2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.28, 0.2), coreMat);
    side2.position.set(0.22, -0.12, -0.13);
    this.flame.add(big, side1, side2);
    this._fireBase = gy + 0.5;
    this.flame.position.set(x, this._fireBase, z);
    this.group.add(this.flame);

    // свет костра: тёплый, мерцает; тени (по кнобу fireShadows) рисуют только
    // объекты лагеря — минимальная карта 256, пиксельный BasicShadowMap
    this.fireLight = new THREE.PointLight(this.palette.fire, c.fireLight, c.fireDist, c.fireDecay);
    this.fireLight.position.set(x, gy + 1.15, z);
    if (c.fireShadows) {
      this.fireLight.castShadow = true;
      this.fireLight.shadow.mapSize.set(256, 256);
      this.fireLight.shadow.camera.near = 0.3;
      this.fireLight.shadow.camera.far = c.fireDist;
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

  update(dt, p, bike) {
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

    this.people.update(dt, p, bike);
  }
}
