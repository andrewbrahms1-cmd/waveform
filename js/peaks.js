// Multi-resolution min/max/RMS summary of an AudioBuffer. Lets the waveform be
// drawn at one column per device pixel at any zoom level without rescanning
// every sample on each redraw.

const BASE = 64; // samples per block at the finest summary level

export class Peaks {
  constructor(buffer) {
    this.length = buffer.length;
    this.channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) this.channels.push(buffer.getChannelData(c));

    // Level 0: one block per BASE raw samples (sq = sum of squares, for RMS).
    const n = Math.ceil(this.length / BASE);
    let level = { min: new Float32Array(n), max: new Float32Array(n), sq: new Float32Array(n) };
    for (let b = 0; b < n; b++) {
      let mn = Infinity, mx = -Infinity, sq = 0;
      for (let i = b * BASE, e = Math.min(this.length, i + BASE); i < e; i++) {
        const v = this.sample(i);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sq += v * v;
      }
      level.min[b] = mn; level.max[b] = mx; level.sq[b] = sq;
    }

    // Each level above merges pairs of blocks from the one below.
    this.levels = [level];
    while (level.min.length > 1) {
      const m = Math.ceil(level.min.length / 2);
      const next = { min: new Float32Array(m), max: new Float32Array(m), sq: new Float32Array(m) };
      for (let i = 0; i < m; i++) {
        const a = 2 * i, b = Math.min(a + 1, level.min.length - 1);
        next.min[i] = Math.min(level.min[a], level.min[b]);
        next.max[i] = Math.max(level.max[a], level.max[b]);
        next.sq[i] = level.sq[a] + (b !== a ? level.sq[b] : 0);
      }
      this.levels.push(next);
      level = next;
    }
  }

  /** Mono (channel-averaged) value of sample i. */
  sample(i) {
    const chs = this.channels;
    let v = 0;
    for (let c = 0; c < chs.length; c++) v += chs[c][i];
    return v / chs.length;
  }

  /**
   * Summarise samples [start, end) into n equal-width columns.
   * Columns past the end of the audio get min > max and should be skipped.
   * @returns {{ min: Float32Array, max: Float32Array, rms: Float32Array }}
   */
  columns(start, end, n) {
    const min = new Float32Array(n), max = new Float32Array(n), rms = new Float32Array(n);
    const spp = (end - start) / n; // samples per column
    // Use blocks of at most ~1/8 of a column, so rounding column edges to block
    // edges stays well under a pixel; read raw samples when zoomed in further.
    const L = spp < BASE * 4 ? -1
      : Math.min(this.levels.length - 1, Math.max(0, Math.floor(Math.log2(spp / BASE / 8))));
    const lvl = this.levels[L];
    const block = L < 0 ? 1 : BASE * 2 ** L;
    const count = L < 0 ? this.length : lvl.min.length;

    for (let x = 0; x < n; x++) {
      const i0 = Math.floor((start + x * spp) / block);
      const i1 = Math.min(count, Math.max(i0 + 1, Math.floor((start + (x + 1) * spp) / block)));
      let mn = Infinity, mx = -Infinity, sq = 0;
      for (let i = i0; i < i1; i++) {
        if (L < 0) {
          const v = this.sample(i);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sq += v * v;
        } else {
          if (lvl.min[i] < mn) mn = lvl.min[i];
          if (lvl.max[i] > mx) mx = lvl.max[i];
          sq += lvl.sq[i];
        }
      }
      const samples = Math.min(this.length, i1 * block) - i0 * block;
      min[x] = mn; max[x] = mx;
      rms[x] = samples > 0 ? Math.sqrt(sq / samples) : 0;
    }
    return { min, max, rms };
  }
}
