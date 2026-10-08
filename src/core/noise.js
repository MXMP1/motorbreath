// Детерминированный PRNG: один и тот же сид даёт один и тот же мир.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Квинтик-сглаживание Перлина: t*(t*(t*(t*(t*6-15)+10)))
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// Value-noise 2D в диапазоне [0,1]. Без зависимостей — годится и для node.
export function makeValueNoise2D(rng) {
  const size = 256;
  const base = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [base[i], base[j]] = [base[j], base[i]];
  }
  const perm = new Uint8Array(size * 2);
  for (let i = 0; i < size * 2; i++) perm[i] = base[i & 255];

  const hash = (ix, iy) => perm[(perm[ix & 255] + (iy & 255)) & 255] / 255;

  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fade(fx);
    const v = fade(fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

// Фрактальный шум (сумма октав) в диапазоне [0,1].
export function makeFbm2D(rng, octaves = 4, lacunarity = 2, gain = 0.5) {
  const noise = makeValueNoise2D(rng);
  return (x, y) => {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };
}
