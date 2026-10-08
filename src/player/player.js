import * as THREE from 'three';
import { resolveCircleAabb, groundHeightAt } from '../core/collide.js';

const UP = new THREE.Vector3(0, 1, 0);

// Кинематический контроллер от первого лица.
// Порядок за тик: ввод -> разгон -> горизонтальный шаг + выталкивание из домов ->
// проверка крутого склона -> вертикальный шаг + прилипание к земле.
export class Player {
  constructor(camera, cfg, world) {
    this.camera = camera;
    this.cfg = cfg.player;
    this.world = world; // { heightmap, colliders, size }
    // точка респауна — лагерь на стороне карты напротив города
    this.spawn = { x: cfg.camp.x + cfg.camp.spawnDx, z: cfg.camp.z + cfg.camp.spawnDz };

    this.pos = new THREE.Vector3(); // ноги игрока
    this.vel = new THREE.Vector3();
    this.onGround = false;
    this.crouching = false;
    this.eye = cfg.player.eyeHeight;
    this.hSpeed = 0;
    this.state = 'стоя';
    this.maxHp = cfg.player.maxHp;
    this.hp = this.maxHp;
    this.regenDelay = 0;

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();

    this.respawn();
  }

  get height() {
    return this.crouching ? this.cfg.crouchHeight : this.cfg.standHeight;
  }

  respawn() {
    this.pos.set(this.spawn.x, 0, this.spawn.z);
    this.pos.y = this.world.heightmap.heightAt(this.spawn.x, this.spawn.z);
    this.vel.set(0, 0, 0);
    this.onGround = true;
    this.crouching = false;
    this.eye = this.cfg.eyeHeight;
    this.hp = this.maxHp; // новый мир или смерть — здоровье полное
    this.regenDelay = 0;
    this.syncCamera();
  }

  // Урон от NPC: пауза регена; на нуле — респавн на спавне с полным здоровьем.
  damage(amount) {
    if (amount <= 0) return;
    this.hp -= amount;
    this.regenDelay = this.cfg.regenDelay;
    if (this.hp <= 0) this.respawn();
  }

  setWorld(world) {
    this.world = world;
    this.respawn();
  }

  syncCamera() {
    this.camera.position.set(this.pos.x, this.pos.y + this.eye, this.pos.z);
  }

  update(dt, input) {
    const c = this.cfg;

    // направление взгляда, спроецированное на горизонталь
    this.camera.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    else this._fwd.normalize();
    this._right.crossVectors(this._fwd, UP).normalize();

    const wish = this._wish.set(0, 0, 0);
    if (input.forward) wish.add(this._fwd);
    if (input.back) wish.sub(this._fwd);
    if (input.right) wish.add(this._right);
    if (input.left) wish.sub(this._right);
    const moving = wish.lengthSq() > 0;
    if (moving) wish.normalize();

    this.crouching = !!input.crouch;

    const sprinting = input.sprint && moving && !this.crouching;
    const targetSpeed = this.crouching ? c.crouchSpeed : sprinting ? c.sprintSpeed : c.walkSpeed;

    // разгон к целевой скорости
    const accel = (this.onGround ? c.accel : c.airAccel) * dt;
    this.vel.x = approach(this.vel.x, wish.x * targetSpeed, accel);
    this.vel.z = approach(this.vel.z, wish.z * targetSpeed, accel);
    if (this.onGround && !moving) {
      const f = Math.exp(-c.friction * dt);
      this.vel.x *= f;
      this.vel.z *= f;
    }

    // прыжок и гравитация
    if (input.jump && this.onGround) {
      this.vel.y = c.jumpSpeed;
      this.onGround = false;
    }
    this.vel.y -= c.gravity * dt;

    // ---- горизонтальный шаг
    const oldX = this.pos.x;
    const oldZ = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    const res = resolveCircleAabb(this.pos.x, this.pos.z, c.radius, this.pos.y, this.height, this.world.colliders);
    if (res.hit) {
      this.pos.x = res.x;
      this.pos.z = res.z;
      this.vel.x *= 0.3; // трёмся о стену
      this.vel.z *= 0.3;
    }

    // границы мира
    const limX = this.world.sizeX / 2 - 3;
    const limZ = this.world.sizeZ / 2 - 3;
    this.pos.x = Math.max(-limX, Math.min(limX, this.pos.x));
    this.pos.z = Math.max(-limZ, Math.min(limZ, this.pos.z));

    // ---- крутой склон = стена, а не лестница
    const terrNew = this.world.heightmap.heightAt(this.pos.x, this.pos.z);
    const terrOld = this.world.heightmap.heightAt(oldX, oldZ);
    const horizDist = Math.hypot(this.pos.x - oldX, this.pos.z - oldZ);
    if (this.onGround && horizDist > 1e-6) {
      const rise = terrNew - Math.max(terrOld, this.pos.y);
      if (rise > c.maxSlopeRise * horizDist + 0.02) {
        this.pos.x = oldX;
        this.pos.z = oldZ;
        this.vel.x *= 0.5;
        this.vel.z *= 0.5;
      }
    }

    // ---- вертикальный шаг: земля, крыши, прилипание при спуске
    this.pos.y += this.vel.y * dt;
    const terrainHere = this.world.heightmap.heightAt(this.pos.x, this.pos.z);
    const ground = groundHeightAt(
      this.pos.x, this.pos.z, terrainHere,
      this.world.colliders, this.pos.y, c.stepHeight, c.radius * 0.9,
    );
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      if (this.vel.y < 0) this.vel.y = 0;
      this.onGround = true;
    } else if (this.onGround && this.vel.y <= 0 && this.pos.y - ground < 0.5) {
      this.pos.y = ground;
      this.vel.y = 0;
    } else {
      this.onGround = this.pos.y - ground < 0.06;
    }

    // ---- глаза: плавный переход высоты при приседе
    const targetEye = this.crouching ? c.crouchEyeHeight : c.eyeHeight;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 10);

    // ---- здоровье: медленно восстанавливается после паузы без урона
    if (this.regenDelay > 0) this.regenDelay = Math.max(0, this.regenDelay - dt);
    else if (this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + c.regen * dt);

    this.hSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.state = !this.onGround ? 'воздух'
      : this.crouching ? 'присед'
      : sprinting ? 'бег'
      : moving ? 'шаг' : 'стоя';

    this.syncCamera();
  }
}

function approach(v, target, maxDelta) {
  const d = target - v;
  if (Math.abs(d) <= maxDelta) return target;
  return v + Math.sign(d) * maxDelta;
}

// Качение камеры от попадания: сторона удара задаёт знаки рывков.
// Игрок получает удар «оттуда» — камера уходит в противоположную сторону:
// сзади — кивок вниз, спереди — вверх, справа/слева — рывок и крен.
// Чистая функция — гоняется headless-тестом.
export function hurtKick(fromX, fromZ, px, pz, fwdX, fwdZ, hurt) {
  const dx = fromX - px;
  const dz = fromZ - pz;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d;
  const nz = dz / d;
  const len = Math.hypot(fwdX, fwdZ) || 1;
  const fx = fwdX / len;
  const fz = fwdZ / len;
  const side = nx * -fz + nz * fx; // плюс — удар пришёл справа от взгляда
  const front = nx * fx + nz * fz; // плюс — удар пришёл спереди
  return { yaw: side * hurt.yaw, pitch: front * hurt.pitch, roll: side * hurt.roll };
}
