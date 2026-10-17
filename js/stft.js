// Short-time Fourier transform: Hann window + in-place radix-2 FFT.

/** Smallest power of two >= n. */
export const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/** cos/sin of -2πk/n for k < n/2, shared by every butterfly stage. */
function twiddles(n) {
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  return { cos, sin };
}

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
function fft(re, im, { cos, sin }) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const wRe = cos[k * stride], wIm = sin[k * stride];
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe;        im[a] += tIm;
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
 * Compute a magnitude spectrogram in dB. Any window length >= 2 is allowed;
 * each frame is zero-padded up to the next power of two for the FFT.
 * @param {Float32Array} samples  mono signal
 * @param {number} windowSize     samples per frame
 * @param {number} hop            samples between frames
 * @returns {{ frames: Float32Array[], bins: number, fftSize: number, max: number }}
 *   frames[t][k] = dB; max = loudest value, for normalising the display
 */
export function stft(samples, windowSize, hop) {
  // Periodic Hann (divides by N, not N - 1), which stays non-zero even for N = 2.
  const hann = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / windowSize));

  const fftSize = Math.max(2, nextPow2(windowSize));
  const bins = fftSize / 2;
  const tw = twiddles(fftSize);
  const frames = [];
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
  // Pad short signals so we always get at least one frame.
  const count = Math.max(1, Math.floor((samples.length - windowSize) / hop) + 1);
  let max = -Infinity;

  for (let f = 0; f < count; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = i < windowSize ? (samples[off + i] || 0) * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im, tw);
    const db = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      // Normalise by window length (not FFT size) so levels don't shift with padding.
      const mag = Math.hypot(re[k], im[k]) / (windowSize / 2);
      db[k] = 20 * Math.log10(mag + 1e-10);
      if (db[k] > max) max = db[k];
    }
    frames.push(db);
  }
  return { frames, bins, fftSize, max };
}
