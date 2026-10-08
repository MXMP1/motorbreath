import { mulberry32, makeFbm2D } from '../core/noise.js';

// Дистанция до ровного коридора: 0 внутри прямоугольника, дальше — расстояние до него.
// Весь рельеф строится по этой величине: в коридоре плоско (город, лагерь, дорога),
// наружу — сначала холмы долины, затем хребет гор по краям карты.
export function corridorDistance(cfg, x, z) {
  return Math.hypot(
    Math.max(0, Math.abs(x) - cfg.corridorHalfW),
    Math.max(0, Math.abs(z) - cfg.corridorHalfL),
  );
}

// Аналитическая функция рельефа: высота(x, z) строится шумом, а не хранится в массиве.
// Плюсы: физика может сэмплить землю в любой точке O(1), без рейкастов по мешу.
export function createHeightmap(cfg) {
  // cfg: { seed, corridorHalfW, corridorHalfL, hillStart, hillRange,
  //        mountainStart, mountainRange, mountainHeight, hillHeight }
  const rng = mulberry32(cfg.seed >>> 0);
  const fbmHills = makeFbm2D(rng, 4, 2, 0.5);
  const fbmRidge = makeFbm2D(rng, 3, 2.1, 0.55);
  const fbmDetail = makeFbm2D(rng, 3, 2, 0.5);

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function heightAt(x, z) {
    const r = corridorDistance(cfg, x, z);

    // коридор: идеально ровный; холмы долины раскатываются уже за его краем
    const valleyK = smoothstep(cfg.hillStart, cfg.hillStart + cfg.hillRange, r);
    let h = (fbmHills(x * 0.012, z * 0.012) * 2 - 1) * cfg.hillHeight * valleyK;

    // хребет гор по краям карты: ridged-шум даёт хребты, детальный — каменную крошку
    const mK = smoothstep(cfg.mountainStart, cfg.mountainStart + cfg.mountainRange, r);
    if (mK > 0) {
      const ridge = 1 - Math.abs(fbmRidge(x * 0.015, z * 0.015) * 2 - 1);
      h += Math.pow(mK, 1.4) * (
        cfg.mountainHeight * (0.45 + 0.55 * ridge) +
        (fbmDetail(x * 0.05, z * 0.05) * 2 - 1) * 6
      );
    }
    return h;
  }

  // Крутизна склона в точке: |grad h| (rise/run). Используется для расстановки и фильтра рельефа.
  function slopeAt(x, z, eps = 2) {
    const hx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps);
    const hz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps);
    return Math.hypot(hx, hz);
  }

  return { heightAt, slopeAt };
}
