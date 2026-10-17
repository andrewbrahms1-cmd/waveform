// Renders STFT output onto a canvas with a colormap and simple axes.

const DB_RANGE = 90; // dynamic range shown below the peak, in dB
const AXIS_W = 44;   // left gutter for frequency labels (CSS px)
const AXIS_H = 18;   // bottom gutter for time labels (CSS px)

/** Dark-blue → purple → orange → yellow colormap, t in 0..1. */
function colormap(t) {
  const stops = [[13, 8, 50], [84, 15, 109], [187, 55, 84], [249, 142, 9], [252, 255, 164]];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((c, j) => c + (stops[i + 1][j] - c) * f);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{frames: Float32Array[], bins: number}} spec
 * @param {{sampleRate: number, startSec: number, endSec: number}} meta
 */
export function drawSpectrogram(canvas, { frames, bins }, { sampleRate, startSec, endSec }) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  // Normalise relative to the loudest bin.
  let max = -Infinity;
  for (const fr of frames) for (const v of fr) if (v > max) max = v;
  const min = max - DB_RANGE;

  // Paint one pixel per (frame, bin) into an offscreen image, then scale it.
  const img = new ImageData(frames.length, bins);
  frames.forEach((fr, x) => {
    for (let k = 0; k < bins; k++) {
      const [r, g, b] = colormap((fr[k] - min) / DB_RANGE);
      const p = ((bins - 1 - k) * frames.length + x) * 4; // low freqs at bottom
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
  });
  const off = new OffscreenCanvas(frames.length, bins);
  off.getContext('2d').putImageData(img, 0, 0);

  const plotW = width - AXIS_W, plotH = height - AXIS_H;
  ctx.imageSmoothingEnabled = frames.length < plotW; // smooth only when upscaling
  ctx.drawImage(off, AXIS_W, 0, plotW, plotH);

  // Axes
  ctx.fillStyle = '#888';
  ctx.font = '10px system-ui, sans-serif';
  const nyq = sampleRate / 2;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const hz = (nyq * i) / 4;
    const y = Math.min(plotH - 5, Math.max(5, plotH - (plotH * i) / 4));
    ctx.fillText(hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${hz | 0}`, AXIS_W - 6, y);
  }
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';  ctx.fillText(`${startSec.toFixed(2)}s`, AXIS_W, height);
  ctx.textAlign = 'right'; ctx.fillText(`${endSec.toFixed(2)}s`, width, height);
  ctx.textAlign = 'center'; ctx.fillText('Hz', AXIS_W / 2, height);
}
