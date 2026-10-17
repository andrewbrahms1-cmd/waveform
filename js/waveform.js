// Waveform rendering + mouse selection on a <canvas>.

/** Reduce an AudioBuffer to `bins` [min, max] peak pairs (channels mixed). */
export function computePeaks(buffer, bins) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const step = buffer.length / bins;
  const peaks = new Array(bins);
  for (let i = 0; i < bins; i++) {
    let min = 0, max = 0;
    const start = Math.floor(i * step), end = Math.floor((i + 1) * step);
    for (let j = start; j < end; j++) {
      let v = 0;
      for (const ch of channels) v += ch[j];
      v /= channels.length;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[i] = [min, max];
  }
  return peaks;
}

export class Waveform {
  constructor(canvas, { onSeek, onSelect }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.buffer = null;
    this.progress = 0;        // 0..1
    this.selection = null;    // { start, end } as 0..1 fractions
    this.#bindPointer();
    new ResizeObserver(() => this.#resize()).observe(canvas);
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    this.#resize();
  }

  setProgress(p) { this.progress = p; this.draw(); }
  setSelection(sel) { this.selection = sel; this.draw(); }

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    // One bar per 3 CSS pixels gives a clean, minimal look.
    if (this.buffer) this.peaks = computePeaks(this.buffer, Math.max(1, Math.floor(width / 3)));
    this.draw();
  }

  draw() {
    const { ctx, canvas, peaks } = this;
    const W = canvas.width, H = canvas.height, mid = H / 2;
    const css = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, W, H);
    if (!peaks) return;

    if (this.selection) {
      const { start, end } = this.selection;
      ctx.fillStyle = css.getPropertyValue('--sel');
      ctx.fillRect(start * W, 0, (end - start) * W, H);
    }

    const barW = W / peaks.length;
    const wave = css.getPropertyValue('--wave');
    const accent = css.getPropertyValue('--accent');
    peaks.forEach(([min, max], i) => {
      const x = i * barW;
      ctx.fillStyle = x / W < this.progress ? accent : wave;
      const h = Math.max(1, (max - min) * mid * 0.9);
      ctx.fillRect(x, mid - max * mid * 0.9, Math.max(1, barW - 1), h);
    });

    // Playhead
    ctx.fillStyle = css.getPropertyValue('--fg');
    ctx.fillRect(this.progress * W - 1, 0, 2, H);
  }

  // Click = seek, drag = select.
  #bindPointer() {
    const frac = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    let anchor = null, dragged = false;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.buffer) return;
      anchor = frac(e); dragged = false;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (anchor === null) return;
      const f = frac(e);
      if (Math.abs(f - anchor) * this.canvas.clientWidth > 4) dragged = true;
      if (dragged) this.setSelection({ start: Math.min(anchor, f), end: Math.max(anchor, f) });
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (anchor === null) return;
      if (dragged) this.onSelect(this.selection);
      else this.onSeek(frac(e));
      anchor = null;
    });
  }
}
