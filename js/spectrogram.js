// Renders STFT output onto a canvas with a colormap and simple axes.

const DB_RANGE = 90;     // dynamic range shown below the peak, in dB
export const AXIS_W = 54; // left gutter for frequency labels (CSS px)
export const AXIS_H = 18; // bottom gutter for time labels (CSS px)

/** Dark-blue → purple → orange → yellow colormap, t in 0..1. */
function colormap(t) {
  const stops = [[13, 8, 50], [84, 15, 109], [187, 55, 84], [249, 142, 9], [252, 255, 164]];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((c, j) => c + (stops[i + 1][j] - c) * f);
}
const LUT = Array.from({ length: 256 }, (_, i) => colormap(i / 255));

/** A 1/2/5 × 10^n step giving roughly `count` ticks across `span`. */
function niceStep(span, count) {
  const raw = span / count, pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
}

/** Label with just enough decimals to tell neighbouring ticks apart; "k" only for coarse steps. */
function fmtHz(hz, step) {
  if (hz >= 1000 && step >= 10) return `${(hz / 1000).toFixed(Math.max(0, Math.ceil(-Math.log10(step / 1000))))}k`;
  return hz.toFixed(Math.max(0, Math.ceil(-Math.log10(step))));
}

/**
 * Colour the visible band into an image with one column per frame. When there
 * are more bins than pixel rows, each row shows the loudest bin it covers, so
 * any FFT size fits; otherwise there is one row per bin, cropped when drawn.
 * @returns {{ image: OffscreenCanvas, sy: number, sh: number }}  source rows to draw
 */
function bandImage({ frames, bins, max }, klo, khi, rows) {
  const F = frames.length, min = max - DB_RANGE;
  const pooled = khi - klo > rows;
  const k0 = Math.floor(klo), k1 = Math.min(bins, Math.ceil(khi));
  const R = pooled ? rows : k1 - k0;
  const step = (khi - klo) / R;
  const img = new ImageData(F, R);

  for (let x = 0; x < F; x++) {
    const fr = frames[x];
    for (let r = 0; r < R; r++) {
      let v;
      if (pooled) {
        const i0 = Math.floor(khi - (r + 1) * step), i1 = Math.max(i0 + 1, Math.floor(khi - r * step));
        v = -Infinity;
        for (let k = i0; k < i1; k++) if (fr[k] > v) v = fr[k];
      } else {
        v = fr[k1 - 1 - r]; // top row = highest bin
      }
      const c = LUT[Math.max(0, Math.min(255, Math.round(((v - min) / DB_RANGE) * 255)))];
      const p = (r * F + x) * 4;
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
  }
  const image = new OffscreenCanvas(F, R);
  image.getContext('2d').putImageData(img, 0, 0);
  return pooled ? { image, sy: 0, sh: R } : { image, sy: k1 - khi, sh: khi - klo };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{frames: Float32Array[], bins: number, max: number}} spec  from stft()
 * @param {{sampleRate: number, startSec: number, endSec: number}} meta
 * @param {{lo: number, hi: number}} view  visible frequency range in Hz
 */
export function drawSpectrogram(canvas, spec, { sampleRate, startSec, endSec }, { lo, hi }) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const nyq = sampleRate / 2, plotW = width - AXIS_W, plotH = height - AXIS_H;
  const klo = (lo / nyq) * spec.bins, khi = (hi / nyq) * spec.bins;
  const { image, sy, sh } = bandImage(spec, klo, khi, Math.max(1, Math.round(plotH * dpr)));
  ctx.imageSmoothingEnabled = image.width < plotW; // smooth only when upscaling
  ctx.drawImage(image, 0, sy, image.width, sh, AXIS_W, 0, plotW, plotH);

  // Axes
  ctx.fillStyle = '#888';
  ctx.font = '10px "JetBrains Mono", ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const step = niceStep(hi - lo, 8);
  for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
    const hz = k * step;
    const y = Math.min(plotH - 5, Math.max(5, plotH * (1 - (hz - lo) / (hi - lo))));
    ctx.fillText(fmtHz(hz, step), AXIS_W - 6, y);
  }
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';  ctx.fillText(`${startSec.toFixed(2)}s`, AXIS_W, height);
  ctx.textAlign = 'right'; ctx.fillText(`${endSec.toFixed(2)}s`, width, height);
  ctx.textAlign = 'center'; ctx.fillText('Hz', AXIS_W / 2, height);
}
