import { mulberry32, makeFbm2D } from '../core/noise.js';

// Аналитическая функция рельефа: высота(x, z) строится шумом, а не хранится в массиве.
// Плюсы: физика может сэмплить землю в любой точке O(1), без рейкастов по мешу.
export function createHeightmap(cfg) {
  // cfg: { seed, size, flatRadius, mountainStart, mountainHeight, hillHeight }
  const rng = mulberry32(cfg.seed >>> 0);
  const fbmHills = makeFbm2D(rng, 4, 2, 0.5);
  const fbmRidge = makeFbm2D(rng, 3, 2.1, 0.55);
  const fbmDetail = makeFbm2D(rng, 3, 2, 0.5);

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  const ringEnd = cfg.mountainStart + (cfg.size * 0.5 - cfg.mountainStart) * 0.85;

  function heightAt(x, z) {
    const r = Math.hypot(x, z);

    // долина: мелкие холмы, полностью выглаженные у спавна
    const valleyK = smoothstep(16, cfg.flatRadius, r);
    let h = (fbmHills(x * 0.012, z * 0.012) * 2 - 1) * cfg.hillHeight * valleyK;

    // кольцо гор по краям: ridged-шум даёт хребты, детальный шум — каменную крошку
    const mK = smoothstep(cfg.mountainStart, ringEnd, r);
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
