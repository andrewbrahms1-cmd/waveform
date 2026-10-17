// UI controller for the STFT section: sliders, Analyze button, rendering.
import { stft, monoSlice } from './stft.js';
import { drawSpectrogram } from './spectrogram.js';

const MAX_FRAMES = 2000; // cap columns so very long selections stay responsive

/** @param {() => AudioBuffer|null} getBuffer */
export function setupStft(getBuffer) {
  const $ = (id) => document.getElementById(id);
  const win = $('win'), ovl = $('ovl'), btn = $('analyze');
  const status = $('stft-status'), wrap = $('spec-wrap'), canvas = $('spectrogram');

  let region = null;   // { start, end } in seconds
  let last = null;     // last result, for redraw on resize
  let debounce;

  const windowSize = () => 2 ** Number(win.value);

  function updateLabels() {
    const buf = getBuffer();
    const n = windowSize();
    const ms = buf ? ` · ${((n / buf.sampleRate) * 1000).toFixed(1)} ms` : '';
    $('win-out').textContent = `${n} samples${ms}`;
    $('ovl-out').textContent = `${ovl.value}%`;
  }

  function analyze() {
    const buf = getBuffer();
    if (!buf || !region) return;
    const n = windowSize();
    const samples = monoSlice(buf, region.start, region.end);
    let hop = Math.max(1, Math.round(n * (1 - ovl.value / 100)));
    // Enlarge hop if needed to respect the frame cap.
    const minHop = Math.ceil((samples.length - n) / MAX_FRAMES);
    const capped = minHop > hop;
    if (capped) hop = minHop;

    const t0 = performance.now();
    const spec = stft(samples, n, hop);
    last = { spec, meta: { sampleRate: buf.sampleRate, startSec: region.start, endSec: region.end } };
    wrap.hidden = false;
    drawSpectrogram(canvas, last.spec, last.meta);

    const df = buf.sampleRate / n, dt = (hop / buf.sampleRate) * 1000;
    status.textContent =
      `${spec.frames.length} frames × ${spec.bins} bins · Δf ${df.toFixed(1)} Hz · hop ${dt.toFixed(1)} ms` +
      (capped ? ' (hop increased for long selection)' : '') +
      ` · ${(performance.now() - t0).toFixed(0)} ms`;
  }

  // Sliders: update labels instantly; re-run analysis (debounced) if already showing.
  for (const s of [win, ovl]) {
    s.addEventListener('input', () => {
      updateLabels();
      if (!last) return;
      clearTimeout(debounce);
      debounce = setTimeout(analyze, 150);
    });
  }
  btn.addEventListener('click', analyze);
  new ResizeObserver(() => last && !wrap.hidden && drawSpectrogram(canvas, last.spec, last.meta)).observe(canvas);

  updateLabels();
  btn.disabled = true;

  return {
    onSelectionChange(r) {
      region = r;
      btn.disabled = !r;
      if (!r) status.textContent = 'Select a section of the waveform, then click Analyze.';
    },
    reset() {
      region = null; last = null;
      wrap.hidden = true;
      btn.disabled = true;
      updateLabels();
      status.textContent = 'Select a section of the waveform, then click Analyze.';
    },
  };
}
