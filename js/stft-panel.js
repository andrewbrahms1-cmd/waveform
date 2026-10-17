// UI controller for the STFT section: window/overlap controls, Analyze button, rendering, frequency zoom.
import { stft, monoSlice, nextPow2 } from './stft.js';
import { drawSpectrogram, AXIS_H } from './spectrogram.js';

const MAX_FRAMES = 2000;    // cap columns so very long selections stay responsive
const MAX_PIXELS = 2 ** 23; // cap frames × bins, which bounds memory and redraw cost
const WORK_BUDGET = 5e7;    // cap FFT butterflies per analysis (~150–200 ms)
const MIN_SPAN_HZ = 1;      // deepest frequency zoom always reaches at least this band…
const MIN_BINS_VISIBLE = 8; // …or 8 bins, if the FFT is fine enough to go further
const SLIDER_STEPS = 1000;  // resolution of the log-scaled window slider
const DEFAULT_WINDOW = 2048;
const NO_SELECTION_MAX = 32768; // slider range before anything is selected

/** @param {() => AudioBuffer|null} getBuffer */
export function setupStft(getBuffer) {
  const $ = (id) => document.getElementById(id);
  const win = $('win'), num = $('win-num'), ovl = $('ovl'), btn = $('analyze');
  const status = $('stft-status'), wrap = $('spec-wrap'), canvas = $('spectrogram'), hint = $('spec-hint');
  const zoomBtns = [$('fzoom-out'), $('fzoom-in'), $('fzoom-fit')];

  let region = null;   // { start, end } in seconds
  let last = null;     // last result, for redraw on resize/zoom
  let view = null;     // visible frequency range { lo, hi } in Hz; kept across re-analysis
  let wanted = DEFAULT_WINDOW; // chosen window length; clamped to the selection when used
  let debounce, raf = 0;

  /** Longest allowed window: the whole selection, in samples. */
  function maxWindow() {
    const buf = getBuffer();
    if (!buf || !region) return NO_SELECTION_MAX;
    const s = Math.floor(region.start * buf.sampleRate);
    const e = Math.min(buf.length, Math.floor(region.end * buf.sampleRate));
    return Math.max(2, e - s);
  }
  const windowSize = () => Math.max(2, Math.min(wanted, maxWindow()));

  // The slider is log-scaled from 2 to the max so it's usable whether the max is 100 or 10 million.
  win.min = 0; win.max = SLIDER_STEPS; win.step = 1;
  const toPos = (n, max) => (max > 2 ? Math.round((SLIDER_STEPS * Math.log(n / 2)) / Math.log(max / 2)) : 0);
  const fromPos = (p, max) => Math.round(2 * (max / 2) ** (p / SLIDER_STEPS));

  function updateLabels() {
    const buf = getBuffer();
    const ms = buf ? (windowSize() / buf.sampleRate) * 1000 : null;
    const dur = ms === null ? '' : ms >= 1000 ? ` · ${(ms / 1000).toFixed(2)} s` : ` · ${ms.toFixed(ms < 1 ? 2 : 1)} ms`;
    $('win-out').textContent = `samples${dur}`;
    $('ovl-out').textContent = `${ovl.value}%`;
  }

  /** Push the effective window length into the slider and number box. */
  function syncWindowControls({ keepNumber = false } = {}) {
    const max = maxWindow();
    num.max = max;
    win.value = toPos(windowSize(), max);
    if (!keepNumber) num.value = windowSize();
    updateLabels();
  }

  function redraw() {
    if (!last || wrap.hidden) return;
    drawSpectrogram(canvas, last.spec, last.meta, view);
    const z = last.nyq / (view.hi - view.lo);
    $('fzoom-level').textContent = `${z < 10 ? z.toFixed(1) : Math.round(z)}×`;
    $('fzoom-out').disabled = $('fzoom-fit').disabled = z <= 1;
  }
  const scheduleRedraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); };

  /** Set the visible band, clamped to 0..Nyquist and the zoom limit. */
  function setView(lo, hi) {
    if (!last) return;
    const { nyq } = last, minSpan = Math.min(MIN_SPAN_HZ, (MIN_BINS_VISIBLE * nyq) / last.spec.bins);
    const span = Math.min(nyq, Math.max(minSpan, hi - lo));
    lo = Math.min(nyq - span, Math.max(0, lo));
    view = { lo, hi: lo + span };
    scheduleRedraw();
  }

  /** Zoom by `factor` (>1 = in), keeping frequency `at` fixed on screen. */
  function zoom(factor, at = (view.lo + view.hi) / 2) {
    if (!last) return;
    const span = view.hi - view.lo, next = span / factor;
    const lo = at - (at - view.lo) * (next / span);
    setView(lo, lo + next);
  }

  /** Frequency (Hz) under a pointer event, and the plot height in CSS px. */
  function freqAt(e) {
    const r = canvas.getBoundingClientRect(), plotH = r.height - AXIS_H;
    const f = Math.min(1, Math.max(0, (e.clientY - r.top) / plotH));
    return { hz: view.hi - f * (view.hi - view.lo), plotH };
  }

  function analyze() {
    const buf = getBuffer();
    if (!buf || !region) return;
    const n = windowSize(), meta = { sampleRate: buf.sampleRate, startSec: region.start, endSec: region.end };
    const samples = monoSlice(buf, region.start, region.end);
    let hop = Math.max(1, Math.round(n * (1 - ovl.value / 100)));
    // Enlarge hop if needed so frame count, image size and FFT work all stay bounded.
    const fftSize = Math.max(2, nextPow2(n)), perFrame = fftSize * Math.log2(fftSize);
    const maxFrames = Math.max(1, Math.min(MAX_FRAMES, Math.floor(MAX_PIXELS / (fftSize / 2)), Math.floor(WORK_BUDGET / perFrame)));
    const minHop = Math.ceil((samples.length - n) / maxFrames);
    const capped = minHop > hop;
    if (capped) hop = minHop;

    const run = () => {
      const t0 = performance.now();
      const spec = stft(samples, n, hop);
      last = { spec, meta, nyq: buf.sampleRate / 2 };
      wrap.hidden = hint.hidden = false;
      zoomBtns.forEach((b) => { b.disabled = false; });
      view ??= { lo: 0, hi: last.nyq };
      setView(view.lo, view.hi); // re-clamp for the new bin count
      redraw();

      const df = buf.sampleRate / spec.fftSize, dt = (hop / buf.sampleRate) * 1000;
      status.textContent =
        `${spec.frames.length} frames × ${spec.bins} bins · FFT ${spec.fftSize} · Δf ${df < 1 ? df.toFixed(3) : df.toFixed(1)} Hz · hop ${dt.toFixed(1)} ms` +
        (capped ? ' (hop increased to stay responsive)' : '') +
        ` · ${(performance.now() - t0).toFixed(0)} ms`;
    };
    // Only a single huge frame can exceed the budget; say so before the page stalls on it.
    if (perFrame > WORK_BUDGET) {
      status.textContent = `Analyzing (FFT ${fftSize})…`;
      setTimeout(run, 20);
    } else run();
  }

  // Controls: update labels instantly; re-run analysis (debounced) if already showing.
  const scheduleAnalyze = () => {
    if (!last) return;
    clearTimeout(debounce);
    debounce = setTimeout(analyze, 150);
  };
  win.addEventListener('input', () => {
    wanted = fromPos(Number(win.value), maxWindow());
    num.value = windowSize();
    updateLabels();
    scheduleAnalyze();
  });
  num.addEventListener('input', () => {
    const v = Math.round(Number(num.value));
    if (!Number.isFinite(v) || v < 2) return; // empty or still being typed
    wanted = v;
    syncWindowControls({ keepNumber: true });
    scheduleAnalyze();
  });
  num.addEventListener('change', () => syncWindowControls()); // show the clamped value once editing ends
  ovl.addEventListener('input', () => { updateLabels(); scheduleAnalyze(); });
  btn.addEventListener('click', analyze);
  new ResizeObserver(redraw).observe(canvas);

  // Frequency zoom: buttons, scroll or pinch at the cursor, drag to pan, double-click to reset.
  $('fzoom-in').addEventListener('click', () => zoom(2));
  $('fzoom-out').addEventListener('click', () => zoom(0.5));
  $('fzoom-fit').addEventListener('click', () => last && setView(0, last.nyq));
  canvas.addEventListener('dblclick', () => last && setView(0, last.nyq));
  canvas.addEventListener('wheel', (e) => {
    if (!last) return;
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    zoom(Math.exp(-Math.max(-100, Math.min(100, dy)) * 0.005), freqAt(e).hz);
  }, { passive: false });

  let drag = null; // { y, view } at pointerdown
  canvas.addEventListener('pointerdown', (e) => {
    if (!last || e.button !== 0) return;
    drag = { y: e.clientY, view };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { lo, hi } = drag.view, dHz = ((e.clientY - drag.y) / freqAt(e).plotH) * (hi - lo);
    setView(lo + dHz, hi + dHz);
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  syncWindowControls();
  btn.disabled = true;
  zoomBtns.forEach((b) => { b.disabled = true; });

  return {
    onSelectionChange(r) {
      region = r;
      syncWindowControls();
      btn.disabled = !r;
      if (!r) status.textContent = 'Select a section of the waveform, then click Analyze.';
    },
    reset() {
      region = null; last = null; view = null;
      wrap.hidden = hint.hidden = true;
      btn.disabled = true;
      zoomBtns.forEach((b) => { b.disabled = true; });
      syncWindowControls();
      status.textContent = 'Select a section of the waveform, then click Analyze.';
    },
  };
}
