import * as THREE from 'three';
import { resolveCircleAabb } from '../core/collide.js';
import { mergeGeometries } from '../core/merge.js';

// Мотоцикл: кинематический, без физического движка — те же приёмы, что у игрока
// и NPC: выталкивание круга из коробок плюс высота рельефа. Нос — локальный +z,
// как у NPC: курс yaw, вперёд = (sin, cos). W — газ, S — тормоз (стоя — задний
// ход), A/D — руль: на месте не крутится, нужен ход. Автокоробка: 4 передачи,
// каждая со своим потолком и тягой; L — фара (выкл → ближний → дальний).
// Сам корпус — коллайдер: пешеходы и NPC упираются в железо, как в дом.
export class Motorcycle {
  constructor(cfg, world) {
    this.cfg = cfg.bike;
    this.world = world; // { heightmap, colliders, sizeX, sizeZ, cityLift }
    const p = cfg.palette;
    const c = this.cfg;

    // стоянка у лагеря, носом вдоль длинной дороги к городу (курс из конфига)
    this.home = { x: cfg.camp.x + c.dx, z: cfg.camp.z + c.dz, yaw: c.yaw };
    this.pos = new THREE.Vector3(this.home.x, 0, this.home.z);
    this.pos.y = this.groundAt(this.pos.x, this.pos.z);
    this.yaw = this.home.yaw;
    this.speed = 0;      // м/с вдоль носа: плюс — вперёд
    this.gear = 0;       // передача автокоробки: потолок скорости — gears[gear]
    this.lightMode = 0;  // фара (L): 0 — выкл, 1 — ближний, 2 — дальний
    this.mounted = false;
    this._spin = 0;      // накопленный оборот колёс
    this._lean = 0;      // крен в повороте
    this._steerVis = 0;  // видимый поворот руля
    this.crashEvent = null; // удар об препятствие за этот тик: читает main.js
    this._wobT = 0;      // остаток тряски после удара, с
    this._wobAmp = 0;    // амплитуда тряски, рад
    this._wobPhase = 0;  // фаза синуса тряски

    // корпус — коллайдер для игрока и NPC; себе свои же коробки не мешают
    this.collider = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 1.05 };
    world.colliders.push(this.collider);
    this._solids = world.colliders.filter((b) => b !== this.collider);

    // --- модель: рама, седло и выхлопная — тёмный меш, бак — красный, фара — светлая
    const metalMat = new THREE.MeshLambertMaterial({ color: p.npcGun, flatShading: true });
    const tireMat = new THREE.MeshLambertMaterial({ color: p.npcOutline, flatShading: true });
    const tankMat = new THREE.MeshLambertMaterial({ color: p.clothA, flatShading: true });
    const spokeMat = new THREE.MeshLambertMaterial({ color: p.signPole, flatShading: true });
    this._flashHex = p.flash;
    const lightMat = new THREE.MeshBasicMaterial({ color: p.flash }); // фара: яркая точка, как вспышка
    this.lampMat = lightMat;

    this.group = new THREE.Group();
    const frame = new THREE.BoxGeometry(0.14, 0.12, 1.05);
    frame.translate(0, 0.6, -0.03);
    const seat = new THREE.BoxGeometry(0.32, 0.1, 0.48);
    seat.translate(0, 0.79, -0.4);
    const pipe = new THREE.BoxGeometry(0.06, 0.06, 0.8);
    pipe.translate(0.17, 0.38, -0.42);
    this.group.add(new THREE.Mesh(mergeGeometries([frame, seat, pipe]), metalMat));

    const tank = new THREE.BoxGeometry(0.3, 0.22, 0.44);
    tank.translate(0, 0.78, 0.14);
    this.group.add(new THREE.Mesh(tank, tankMat));

    // рулевая колонка отдельно: руль и переднее колесо поворачиваются на месте
    this.steerGroup = new THREE.Group();
    this.steerGroup.position.set(0, 0, 0.55);
    this.group.add(this.steerGroup);
    const fork = new THREE.BoxGeometry(0.1, 0.56, 0.1);
    fork.translate(0, 0.62, 0.03);
    const bar = new THREE.BoxGeometry(0.64, 0.07, 0.07);
    bar.translate(0, 0.97, -0.02);
    this.steerGroup.add(new THREE.Mesh(mergeGeometries([fork, bar]), metalMat));
    const lamp = new THREE.BoxGeometry(0.16, 0.14, 0.1);
    lamp.translate(0, 0.86, 0.16);
    this.steerGroup.add(new THREE.Mesh(lamp, lightMat));

    // луч фары: пятно вдоль носа, живёт в steerGroup — светит вместе с рулём; L гоняет режимы
    this.lampLight = new THREE.SpotLight(p.flash, c.lightLow, c.lightLowDist, 0.55, 0.4, 1);
    this.lampLight.position.set(0, 0.86, 0.2);
    this.lampLight.target.position.set(0, 0.3, 16);
    this.steerGroup.add(this.lampLight, this.lampLight.target);

    this.wheelFront = this._buildWheel(tireMat, spokeMat);
    this.wheelFront.position.set(0, 0.34, 0.07);
    this.steerGroup.add(this.wheelFront);
    this.wheelRear = this._buildWheel(tireMat, spokeMat);
    this.wheelRear.position.set(0, 0.34, -0.62);
    this.group.add(this.wheelRear);

    // тени костра: как у прочих объектов лагеря
    if (cfg.camp.fireShadows) this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.group.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });

    this.reset();
    this._applyLight();
  }

  // Колесо: покрышка торцом по оси x плюс крест спиц — вращение видно глазом
  _buildWheel(tireMat, spokeMat) {
    const w = new THREE.Group();
    const tire = new THREE.CylinderGeometry(0.34, 0.34, 0.12, 8);
    tire.rotateZ(Math.PI / 2);
    w.add(new THREE.Mesh(tire, tireMat));
    const spokeA = new THREE.BoxGeometry(0.035, 0.62, 0.05);
    const spokeB = new THREE.BoxGeometry(0.035, 0.62, 0.05);
    spokeB.rotateX(Math.PI / 2);
    w.add(new THREE.Mesh(mergeGeometries([spokeA, spokeB]), spokeMat));
    return w;
  }

  groundAt(x, z) {
    const lift = this.world.cityLift ? this.world.cityLift(x, z) : 0;
    return this.world.heightmap.heightAt(x, z) + lift;
  }

  mount() {
    this.mounted = true;
  }

  dismount() {
    this.mounted = false;
    this.speed = 0; // без водителя не катится
    this.gear = 0;  // заглох на первой
  }

  // Авария: водитель вылетел из седла. В отличие от dismount() скорость сохраняем —
  // мотоцикл откатывается от стены и гаснет сам (ветка «без водителя» в update).
  ejectRider() {
    this.mounted = false;
    this.gear = 0;
  }

  // Удар об препятствие: отражаем скорость от нормали стены.
  // nx/nz — куда мотоцикл собирался шагнуть; res — куда его вытолкнул коллайдер.
  _crash(nx, nz, res) {
    const c = this.cfg.crash;
    const speed = this.speed;
    // нормаль — от точки выталкивания: куда нас вытолкнули, оттуда и стена
    let ax = res.x - nx;
    let az = res.z - nz;
    let len = Math.hypot(ax, az);
    if (len < 1e-6) { // выродилось: встали ровно в углу — бьём против носа
      ax = -Math.sin(this.yaw);
      az = -Math.cos(this.yaw);
      len = 1;
    }
    const ux = ax / len;
    const uz = az / len;
    const vx = Math.sin(this.yaw) * speed;
    const vz = Math.cos(this.yaw) * speed;
    const impact = -(vx * ux + vz * uz); // плюс — ехали в стену

    // слабое касание: никакого отскока, просто теряем ход
    if (impact <= c.minImpact) {
      this.speed *= 0.9;
      return { impact, speed, nx: ux, nz: uz, eject: false };
    }

    // нормальную составляющую отражаем с упругостью, касательную — приглушаем
    const vn = vx * ux + vz * uz;
    const tx = vx - vn * ux;
    const tz = vz - vn * uz;
    const rvx = -vn * c.restitution * ux + tx * c.tangentKeep;
    const rvz = -vn * c.restitution * uz + tz * c.tangentKeep;

    // новая скорость — проекция отскока на нос (мотоцикл едет только вдоль курса)
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const fwd = rvx * fx + rvz * fz;
    const cross = rvx * fz - rvz * fx; // боковая составляющая отскока
    this.speed = fwd;
    this.yaw += c.yawKick * Math.atan2(cross, Math.abs(fwd)); // нос доворачивает вбок
    this._wobT = c.wobbleTime;
    this._wobAmp = Math.min(c.wobbleLean, impact * 0.02);
    return { impact, speed, nx: ux, nz: uz, eject: impact >= c.ejectSpeed };
  }

  // Свет фары: L гоняет по кругу выкл → ближний → дальний → выкл.
  toggleLight() {
    this.lightMode = (this.lightMode + 1) % 3;
    this._applyLight();
  }

  _applyLight() {
    const c = this.cfg;
    const low = this.lightMode === 1;
    const on = this.lightMode !== 0;
    this.lampMat.color.setHex(!on ? 0x555a60 : low ? this._flashHex : 0xffffff);
    this.lampLight.visible = on;
    if (on) {
      this.lampLight.intensity = low ? c.lightLow : c.lightHigh;
      this.lampLight.distance = low ? c.lightLowDist : c.lightHighDist;
    }
  }

  // Вернуть мотоцикл на стоянку у лагеря (клавиша R).
  reset() {
    this.pos.set(this.home.x, 0, this.home.z);
    this.pos.y = this.groundAt(this.pos.x, this.pos.z);
    this.yaw = this.home.yaw;
    this.speed = 0;
    this.gear = 0;
    this._spin = 0;
    this._lean = 0;
    this._steerVis = 0;
    this.crashEvent = null;
    this._wobT = 0;
    this._wobAmp = 0;
    this._wobPhase = 0;
    this.sync();
  }

  sync() {
    this.group.position.copy(this.pos);
    // крен — вокруг собственного носа; поверх него тряска после удара (затухает)
    const c = this.cfg.crash;
    const wob = this._wobT > 0
      ? Math.sin(this._wobPhase) * this._wobAmp * (this._wobT / c.wobbleTime)
      : 0;
    this.group.rotation.set(0, this.yaw, this._lean + wob);
    this.wheelFront.rotation.x = this._spin;
    this.wheelRear.rotation.x = this._spin;
    this.steerGroup.rotation.y = this._steerVis;
    const r = this.cfg.radius;
    const b = this.collider;
    b.minX = this.pos.x - r;
    b.maxX = this.pos.x + r;
    b.minZ = this.pos.z - r;
    b.maxZ = this.pos.z + r;
    b.minY = this.pos.y;
    b.maxY = this.pos.y + 1.05;
  }

  // input — клавиши игрока, пока он в седле; null — мотоцикл без водителя.
  update(dt, input) {
    const c = this.cfg;
    if (input && this.mounted) {
      // газ: цель — потолок текущей передачи; выжал её — автокоробка щёлкает вверх
      if (input.forward) {
        const top = c.gears[this.gear];
        this.speed = approach(this.speed, top, c.accels[this.gear] * dt);
        if (this.speed >= top * c.shiftUp && this.gear < c.gears.length - 1) this.gear++;
      } else if (input.back) {
        // S: сначала тормоз, на остановке — задний ход (первая передача)
        if (this.speed > 0.05) this.speed = approach(this.speed, 0, c.brake * dt);
        else this.speed = approach(this.speed, -c.reverseSpeed, c.accels[0] * dt);
      } else {
        this.speed *= Math.exp(-1.1 * dt); // накат: медленно теряет ход
        if (Math.abs(this.speed) < 0.04) this.speed = 0;
      }
      // вниз: провалился ниже 80% прошлой передачи — передача скидывается
      while (this.gear > 0 && this.speed < c.gears[this.gear - 1] * c.shiftDown) this.gear--;
      const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const grip = Math.min(1, 0.25 + Math.abs(this.speed) / 6); // на месте руль не крутит
      this.yaw -= steer * c.steer * grip * dt;
      // крен: вбок, к центру дуги — тем заметнее, чем быстрее ход
      const lean = steer * 0.35 * Math.min(1, Math.abs(this.speed) / 6) * (this.speed >= 0 ? 1 : -1);
      this._lean += (lean - this._lean) * Math.min(1, 6 * dt);
      this._steerVis += (steer * 0.45 - this._steerVis) * Math.min(1, 10 * dt);
    } else {
      // без водителя: остывает и встаёт
      this.speed *= Math.exp(-3 * dt);
      if (Math.abs(this.speed) < 0.04) this.speed = 0;
      this._lean += (0 - this._lean) * Math.min(1, 6 * dt);
      this._steerVis += (0 - this._steerVis) * Math.min(1, 10 * dt);
    }

    // ход вдоль курса + выталкивание из домов, построек и баков
    const nx = this.pos.x + Math.sin(this.yaw) * this.speed * dt;
    const nz = this.pos.z + Math.cos(this.yaw) * this.speed * dt;
    const res = resolveCircleAabb(nx, nz, c.radius, this.pos.y, 1.0, this._solids);
    this.pos.x = res.x;
    this.pos.z = res.z;
    this.crashEvent = res.hit ? this._crash(nx, nz, res) : null;
    if (this._wobT > 0) { // тряска: фаза растёт, амплитуда гаснет со временем
      this._wobT = Math.max(0, this._wobT - dt);
      this._wobPhase += dt * 40;
      if (this._wobT === 0) this._wobPhase = 0;
    }
    const limX = this.world.sizeX / 2 - 3;
    const limZ = this.world.sizeZ / 2 - 3;
    this.pos.x = Math.max(-limX, Math.min(limX, this.pos.x));
    this.pos.z = Math.max(-limZ, Math.min(limZ, this.pos.z));
    this.pos.y = this.groundAt(this.pos.x, this.pos.z);

    this._spin += (this.speed / 0.34) * dt; // колёса крутятся по скорости
    this.sync();
  }
}

function approach(v, target, maxDelta) {
  const d = target - v;
  if (Math.abs(d) <= maxDelta) return target;
  return v + Math.sign(d) * maxDelta;
}
