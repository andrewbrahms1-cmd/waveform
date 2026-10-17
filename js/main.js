// App wiring: file upload -> decode -> waveform + player controls.
import { Waveform } from './waveform.js';
import { Player } from './player.js';
import { setupStft } from './stft-panel.js';

const $ = (id) => document.getElementById(id);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const player = new Player();
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

let currentBuffer = null;

const waveform = new Waveform($('waveform'), $('overview'), {
  onSeek: (f) => {
    // Clicking clears any selection and seeks.
    clearSelection();
    player.seek(f * player.duration);
  },
  onSelect: ({ start, end }) => {
    const region = { start: start * player.duration, end: end * player.duration };
    player.setRegion(region);
    $('selection-info').textContent = `${fmt(region.start)} – ${fmt(region.end)}`;
    player.seek(region.start);
    stftPanel.onSelectionChange(region);
  },
  onViewChange: ({ start, end }) => {
    const z = 1 / (end - start);
    $('zoom-level').textContent = `${z < 10 ? z.toFixed(1) : Math.round(z)}×`;
    $('zoom-out').disabled = $('zoom-fit').disabled = end - start >= 1;
  },
});

// STFT panel reads the decoded buffer lazily.
const stftPanel = setupStft(() => currentBuffer);

player.onTick = (t) => {
  $('current').textContent = fmt(t);
  waveform.setProgress(player.duration ? t / player.duration : 0);
};
player.audio.addEventListener('play', () => { $('play').textContent = '❚❚'; $('play').ariaLabel = 'Pause'; });
player.audio.addEventListener('pause', () => { $('play').textContent = '▶'; $('play').ariaLabel = 'Play'; });
player.audio.addEventListener('ended', () => player.onTick(player.time));

function clearSelection() {
  player.setRegion(null);
  waveform.setSelection(null);
  $('selection-info').textContent = '';
  stftPanel.onSelectionChange(null);
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('audio')) return;
  $('file-label').textContent = 'Loading…';
  try {
    const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
    player.pause();
    player.load(URL.createObjectURL(file));
    clearSelection();
    $('player').hidden = false;
    currentBuffer = buffer;
    stftPanel.reset();
    waveform.setBuffer(buffer);
    $('duration').textContent = fmt(buffer.duration);
    player.onTick(0);
    $('file-label').textContent = file.name;
  } catch {
    $('file-label').textContent = 'Could not decode that file. Try another.';
  }
}

// Upload: click or drag & drop
$('file-input').addEventListener('change', (e) => loadFile(e.target.files[0]));
const dz = $('dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('dragover');
  loadFile(e.dataTransfer.files[0]);
});

// Controls
$('play').addEventListener('click', () => player.toggle());
$('stop').addEventListener('click', () => player.stop());
$('clear').addEventListener('click', clearSelection);
$('loop').addEventListener('change', (e) => { player.loop = e.target.checked; });
$('zoom-in').addEventListener('click', () => waveform.zoom(2));
$('zoom-out').addEventListener('click', () => waveform.zoom(0.5));
$('zoom-fit').addEventListener('click', () => waveform.fit());

// Theme: follows the system until the user picks one with the toggle.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light')) === 'dark';
function syncTheme() {
  $('theme').textContent = isDark() ? '☀' : '☾';
  $('theme').ariaLabel = isDark() ? 'Switch to light mode' : 'Switch to dark mode';
  waveform.refreshColors();
}
$('theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  syncTheme();
});
darkQuery.addEventListener('change', syncTheme);
syncTheme();
// Canvas text doesn't re-render by itself when web fonts arrive, so repaint once they have.
document.fonts?.ready.then(() => waveform.draw());

const ZOOM_KEYS = { '=': () => waveform.zoom(2), '+': () => waveform.zoom(2), '-': () => waveform.zoom(0.5), '0': () => waveform.fit() };

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !$('player').hidden && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    player.toggle();
  } else if (ZOOM_KEYS[e.key] && !$('player').hidden && e.target.tagName !== 'INPUT' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    ZOOM_KEYS[e.key]();
  }
});
