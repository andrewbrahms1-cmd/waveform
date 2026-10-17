// Short-time Fourier transform: Hann window + in-place radix-2 FFT.

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe;        im[a] += tIm;
        [cRe, cIm] = [cRe * wRe - cIm * wIm, cRe * wIm + cIm * wRe];
      }
    }
  }
}

/** Mix all channels of an AudioBuffer to mono over [startSec, endSec). */
export function monoSlice(buffer, startSec, endSec) {
  const s = Math.floor(startSec * buffer.sampleRate);
  const e = Math.min(buffer.length, Math.floor(endSec * buffer.sampleRate));
  const out = new Float32Array(Math.max(0, e - s));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[s + i] / buffer.numberOfChannels;
  }
  return out;
}

/**
 * Compute a magnitude spectrogram in dB.
 * @param {Float32Array} samples  mono signal
 * @param {number} windowSize     power of two
 * @param {number} hop            samples between frames
 * @returns {{ frames: Float32Array[], bins: number }}  frames[t][k] = dB
 */
export function stft(samples, windowSize, hop) {
  const hann = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));

  const bins = windowSize / 2;
  const frames = [];
  const re = new Float32Array(windowSize), im = new Float32Array(windowSize);
  // Pad short signals so we always get at least one frame.
  const count = Math.max(1, Math.floor((samples.length - windowSize) / hop) + 1);

  for (let f = 0; f < count; f++) {
    const off = f * hop;
    for (let i = 0; i < windowSize; i++) {
      re[i] = (samples[off + i] || 0) * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    const db = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]) / bins;
      db[k] = 20 * Math.log10(mag + 1e-10);
    }
    frames.push(db);
  }
  return { frames, bins };
}
