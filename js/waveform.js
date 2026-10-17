// Waveform rendering, zoom/pan and mouse selection on a <canvas>, plus an
// overview strip showing which part of the file is in view.
import { Peaks } from './peaks.js';

const RULER = 18;               // CSS px at the top reserved for time labels
const MAX_PX_PER_SAMPLE = 16;   // deepest zoom, in CSS px per sample
const TICK_SPACING = 90;        // target CSS px between ruler labels
const TICK_STEPS = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function fmtTime(t, decimals) {
  const m = Math.floor(t / 60), s = (t - m * 60).toFixed(decimals);
  return `${m}:${s.padStart(decimals ? decimals + 3 : 2, '0')}`;
}

function readColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  return {
    wave: { peak: get('--wave'), rms: get('--wave-rms') },
    played: { peak: get('--accent-soft'), rms: get('--accent') },
    sel: get('--sel'), grid: get('--grid'), muted: get('--muted'), fg: get('--fg'), accent: get('--accent'),
    dim: get('--dim'),
  };
}

/** Min/max envelope with an inner RMS band, one column per device pixel. */
function paintEnvelope(ctx, cols, top, H, { peak, rms }) {
  const mid = (top + H) / 2, amp = ((H - top) / 2) * 0.92;
  const peakPath = new Path2D(), rmsPath = new Path2D();
  for (let x = 0; x < cols.min.length; x++) {
    const mn = cols.min[x], mx = cols.max[x];
    if (!(mx >= mn)) continue; // past the end of the audio
    const y1 = mid - mx * amp, y2 = mid - mn * amp;
    peakPath.rect(x, y1, 1, Math.max(1, y2 - y1));
    const rt = Math.min(cols.rms[x], mx), rb = Math.max(-cols.rms[x], mn);
    if (rt > rb) rmsPath.rect(x, mid - rt * amp, 1, (rt - rb) * amp);
  }
  ctx.fillStyle = peak; ctx.fill(peakPath);
  ctx.fillStyle = rms; ctx.fill(rmsPath);
}

/** Individual samples as a connected line, used once there are more pixels than samples. */
function paintSamples(ctx, peaks, s0, spp, top, H, { peak, rms }, dpr) {
  const W = ctx.canvas.width, mid = (top + H) / 2, amp = ((H - top) / 2) * 0.92;
  const i0 = Math.max(0, Math.floor(s0)), i1 = Math.min(peaks.length - 1, Math.ceil(s0 + W * spp));
  const xy = (i) => [(i - s0) / spp, mid - peaks.sample(i) * amp];

  ctx.fillStyle = peak;
  ctx.fillRect(0, mid - dpr / 2, W, dpr); // zero line
  ctx.strokeStyle = rms; ctx.lineWidth = 1.5 * dpr; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) ctx.lineTo(...xy(i));
  ctx.stroke();

  // Mark each sample once they're far enough apart to tell apart.
  if (1 / spp >= 8 * dpr) {
    ctx.fillStyle = rms;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const [x, y] = xy(i);
      ctx.moveTo(x + 2.5 * dpr, y);
      ctx.arc(x, y, 2.5 * dpr, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
}

export class Waveform {
  #dirty = true; // visible-range layers need re-rendering
  #raf = 0;

  constructor(canvas, overview, { onSeek, onSelect, onViewChange = () => {} }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.overview = overview;
    this.octx = overview.getContext('2d');
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onViewChange = onViewChange;
    this.buffer = null;
    this.peaks = null;
    this.progress = 0;              // 0..1
    this.selection = null;          // { start, end } as 0..1 fractions
    this.view = { start: 0, end: 1 }; // visible window, as 0..1 fractions
    this.#bindPointer();
    this.#bindWheel();
    this.#bindOverview();
    const ro = new ResizeObserver(() => this.#resize());
    ro.observe(canvas);
    ro.observe(overview);
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    this.peaks = new Peaks(buffer);
    this.colors = readColors();
    this.view = { start: 0, end: 1 };
    this.#resize();
    this.onViewChange(this.view);
  }

  /** Re-read colours from CSS (e.g. after a theme change) and repaint. */
  refreshColors() {
    if (!this.buffer) return;
    this.colors = readColors();
    this.overviewLayer = null;
    this.#dirty = true;
    this.draw();
  }

  setProgress(p) {
    // Page the view along when the playhead runs off either edge (e.g. playback or loop wrap),
    // but not if the user has already scrolled it out of view.
    const { start, end } = this.view, prev = this.progress;
    if (prev >= start && prev <= end && (p > end || p < start)) this.setView(p, p + this.span);
    this.progress = p;
    this.draw();
  }

  setSelection(sel) { this.selection = sel; this.draw(); }

  get span() { return this.view.end - this.view.start; }

  /** Set the visible window (0..1 fractions), clamped to the file and the zoom limits. */
  setView(start, end) {
    if (!this.buffer) return;
    const span = this.#clampSpan(end - start);
    start = Math.min(1 - span, Math.max(0, start));
    if (start === this.view.start && start + span === this.view.end) return;
    this.view = { start, end: start + span };
    this.#invalidate();
    this.onViewChange(this.view);
  }

  /** Zoom by `factor` (>1 = in), keeping fraction `at` fixed on screen. Defaults to the playhead if visible. */
  zoom(factor, at) {
    if (!this.buffer) return;
    const { start, end } = this.view;
    at ??= this.progress >= start && this.progress <= end ? this.progress : (start + end) / 2;
    const span = this.#clampSpan(this.span / factor);
    const s = at - (at - start) * (span / this.span);
    this.setView(s, s + span);
  }

  pan(delta) { this.setView(this.view.start + delta, this.view.end + delta); }
  fit() { this.setView(0, 1); }

  #clampSpan(span) {
    const minSpan = Math.min(1, this.canvas.clientWidth / MAX_PX_PER_SAMPLE / this.buffer.length);
    return Math.min(1, Math.max(minSpan, span));
  }

  #invalidate() {
    this.#dirty = true;
    if (!this.#raf) this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.draw(); });
  }

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const cv of [this.canvas, this.overview]) {
      const { width, height } = cv.getBoundingClientRect();
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(height * dpr);
    }
    this.overviewLayer = null;
    this.#dirty = true;
    this.draw();
  }

  // Pre-render the visible range twice: unplayed and played colours. Drawing a
  // frame is then just compositing these, so the playhead can move every frame.
  #render() {
    this.#dirty = false;
    this.layers = null;
    const { width: W, height: H } = this.canvas;
    if (!this.peaks || !W || !H) return;
    const dpr = window.devicePixelRatio || 1, top = RULER * dpr;
    const s0 = this.view.start * this.peaks.length;
    const spp = (this.span * this.peaks.length) / W;
    const cols = spp >= 1 && this.peaks.columns(s0, s0 + spp * W, W);
    this.layers = [this.colors.wave, this.colors.played].map((colors) => {
      const layer = new OffscreenCanvas(W, H);
      const ctx = layer.getContext('2d');
      if (cols) paintEnvelope(ctx, cols, top, H, colors);
      else paintSamples(ctx, this.peaks, s0, spp, top, H, colors, dpr);
      return layer;
    });
  }

  draw() {
    if (this.#dirty) this.#render();
    const { ctx, canvas, colors } = this;
    const W = canvas.width, H = canvas.height, dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, W, H);
    if (this.layers) {
      const toX = (f) => ((f - this.view.start) / this.span) * W;

      if (this.selection) {
        const x0 = toX(this.selection.start), x1 = toX(this.selection.end);
        ctx.fillStyle = colors.sel;
        ctx.fillRect(x0, 0, x1 - x0, H);
      }
      this.#drawRuler(dpr);

      // Highlight the selection if there is one, otherwise everything already played.
      ctx.drawImage(this.layers[0], 0, 0);
      const [a, b] = this.selection ? [this.selection.start, this.selection.end] : [0, this.progress];
      const x0 = Math.min(W, Math.max(0, toX(a))), x1 = Math.min(W, Math.max(0, toX(b)));
      if (x1 > x0) ctx.drawImage(this.layers[1], x0, 0, x1 - x0, H, x0, 0, x1 - x0, H);

      // Playhead
      ctx.fillStyle = colors.fg;
      ctx.fillRect(toX(this.progress) - dpr, 0, 2 * dpr, H);
    }
    this.#drawOverview(dpr);
  }

  #drawRuler(dpr) {
    const { ctx, canvas, colors } = this;
    const dur = this.buffer.duration, t0 = this.view.start * dur, t1 = this.view.end * dur;
    const want = ((t1 - t0) / canvas.clientWidth) * TICK_SPACING;
    const step = TICK_STEPS.find((s) => s >= want) ?? TICK_STEPS.at(-1);
    const decimals = step < 0.001 ? 4 : step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let k = Math.ceil(t0 / step); k * step <= t1; k++) {
      const x = Math.round(((k * step - t0) / (t1 - t0)) * canvas.width);
      ctx.fillStyle = colors.grid;
      ctx.fillRect(x, 0, dpr, canvas.height);
      ctx.fillStyle = colors.muted;
      ctx.fillText(fmtTime(k * step, decimals), x + 4 * dpr, (RULER * dpr) / 2);
    }
  }

  #drawOverview(dpr) {
    const { octx: ctx, overview, colors } = this;
    const W = overview.width, H = overview.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.peaks || !W || !H) return;
    if (!this.overviewLayer) {
      this.overviewLayer = new OffscreenCanvas(W, H);
      paintEnvelope(this.overviewLayer.getContext('2d'), this.peaks.columns(0, this.peaks.length, W), 0, H, colors.wave);
    }
    ctx.drawImage(this.overviewLayer, 0, 0);

    // Dim everything outside the visible window and outline the window.
    const x0 = this.view.start * W, x1 = this.view.end * W, lw = 1.5 * dpr;
    ctx.fillStyle = colors.dim;
    ctx.fillRect(0, 0, x0, H);
    ctx.fillRect(x1, 0, W - x1, H);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = lw;
    ctx.strokeRect(x0 + lw / 2, lw / 2, Math.max(lw, x1 - x0 - lw), H - lw);

    ctx.fillStyle = colors.fg;
    ctx.fillRect(this.progress * W - dpr / 2, 0, dpr, H);
  }

  /** Pointer position on the main canvas as a 0..1 fraction of the whole file. */
  #fracAt(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.view.start + clamp01((e.clientX - r.left) / r.width) * this.span;
  }

  // Click = seek, drag = select.
  #bindPointer() {
    let anchor = null, anchorX = 0, dragged = false;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.buffer || e.button !== 0) return;
      anchor = this.#fracAt(e); anchorX = e.clientX; dragged = false;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (anchor === null) return;
      const f = this.#fracAt(e);
      if (Math.abs(e.clientX - anchorX) > 4) dragged = true;
      if (dragged) this.setSelection({ start: Math.min(anchor, f), end: Math.max(anchor, f) });
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (anchor === null) return;
      if (dragged) this.onSelect(this.selection);
      else this.onSeek(this.#fracAt(e));
      anchor = null;
    });
  }

  // Scroll (or trackpad pinch) = zoom at the cursor; Shift + scroll or horizontal swipe = pan.
  #bindWheel() {
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.buffer) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientWidth : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        this.pan(((e.shiftKey ? dy || dx : dx) / this.canvas.clientWidth) * this.span);
      } else {
        this.zoom(Math.exp(-Math.max(-100, Math.min(100, dy)) * 0.005), this.#fracAt(e));
      }
    }, { passive: false });
  }

  // Overview: drag the window to scroll, or click elsewhere to jump there.
  #bindOverview() {
    const cv = this.overview;
    const frac = (e) => { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
    let grab = null; // pointer offset from the window's left edge

    cv.addEventListener('pointerdown', (e) => {
      if (!this.buffer) return;
      const f = frac(e), { start, end } = this.view;
      grab = f >= start && f <= end ? f - start : this.span / 2;
      this.pan(f - grab - start);
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (grab !== null) this.pan(frac(e) - grab - this.view.start);
    });
    const release = () => { grab = null; };
    cv.addEventListener('pointerup', release);
    cv.addEventListener('pointercancel', release);
  }
}
