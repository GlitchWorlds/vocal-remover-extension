/**
 * Smart Adaptive Vocal Remover — Audio Engine (v3.0.0 Dual-Engine Architecture)
 *
 * Engines:
 * 1. MODE 'spectral' (Spectral Studio Engine):
 *    - Real-time STFT (Short-Time Fourier Transform) Overlap-Add (OLA) analysis.
 *    - Frame size 2048, hop size 512 (75% overlap) with Hann windowing.
 *    - Frequency-domain spectral pan discrimination: isolates and zeroes center-panned vocal bins
 *      in the vocal range (130 Hz - 7000 Hz) while leaving stereo instruments (guitars, piano, synths)
 *      and low-end/high-end (kick drum, bass, cymbals) 100% untouched.
 *    - Bit-exact bypass at strength = 0.
 *
 * 2. MODE 'dsp' (Fast Crossover Engine):
 *    - 3-Band Linkwitz-Riley 4th order (LR4) crossover.
 *    - Bass (<130Hz) and Treble (>7000Hz) passed in pure stereo.
 *    - In-phase center vocal subtraction on vocal band.
 *    - Adaptive YIN pitch notching for residual fundamental and harmonics.
 *    - True linear dry/wet matrix with bit-exact bypass at strength = 0.
 */

'use strict';

let audioCtx = null;
let mediaStream = null;
let nodes = null;
let strength = 1.0;
let currentMode = 'spectral'; // 'spectral' or 'dsp'
let capturing = false;
let pollTimer = null;

const ANALYSER_FFT = 4096;
const PITCH_MIN = 75;
const PITCH_MAX = 1100;
const YIN_THRESHOLD = 0.15;
const UPDATE_INTERVAL_MS = 75;

const F_BASS_CROSSOVER = 130;
const F_TREBLE_CROSSOVER = 7000;

let currentF0 = 0;
let currentConf = 0;
let smoothedF0 = 0;
let lastStatusSent = 0;

function noteFromFreq(f) {
  if (!f || f < 20) return '';
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midi = Math.round(69 + 12 * Math.log2(f / 440));
  return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// ── YIN Pitch Detection ──
function detectPitch(buf, sampleRate) {
  const tauMin = Math.floor(sampleRate / PITCH_MAX);
  const tauMax = Math.floor(sampleRate / PITCH_MIN);
  const half = Math.floor(buf.length / 2);
  if (tauMax >= half) return { f0: 0, conf: 0 };

  const d = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * (tau - tauMin + 1)) / running : 1;
  }

  let tauEstimate = -1;
  for (let tau = tauMin + 1; tau <= tauMax; tau++) {
    if (cmnd[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate < 0) {
    let best = tauMin, bestVal = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < bestVal) {
        bestVal = cmnd[tau];
        best = tau;
      }
    }
    if (bestVal < 0.35) tauEstimate = best;
    else return { f0: 0, conf: 0 };
  }

  let tau = tauEstimate;
  if (tau > tauMin && tau < tauMax) {
    const s0 = cmnd[tau - 1], s1 = cmnd[tau], s2 = cmnd[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-12) tau += (s2 - s0) / denom;
  }

  const f0 = sampleRate / tau;
  const conf = Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]));
  return { f0, conf };
}

// ── Radix-2 Cooley-Tukey FFT ──
function createFFT(n) {
  const cosTable = new Float32Array(n / 2);
  const sinTable = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosTable[i] = Math.cos(-2 * Math.PI * i / n);
    sinTable[i] = Math.sin(-2 * Math.PI * i / n);
  }
  const bitRev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let rev = 0, x = i;
    for (let j = 0; j < Math.log2(n); j++) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    bitRev[i] = rev;
  }
  return {
    transform(real, imag) {
      for (let i = 0; i < n; i++) {
        const j = bitRev[i];
        if (j > i) {
          const tr = real[i]; real[i] = real[j]; real[j] = tr;
          const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
        }
      }
      for (let s = 1; s <= Math.log2(n); s++) {
        const m = 1 << s;
        const halfM = m >> 1;
        const step = n / m;
        for (let k = 0; k < n; k += m) {
          for (let j = 0; j < halfM; j++) {
            const wr = cosTable[j * step];
            const wi = sinTable[j * step];
            const tIndex = k + j + halfM;
            const tr = wr * real[tIndex] - wi * imag[tIndex];
            const ti = wr * imag[tIndex] + wi * real[tIndex];
            const uIndex = k + j;
            real[tIndex] = real[uIndex] - tr;
            imag[tIndex] = imag[uIndex] - ti;
            real[uIndex] += tr;
            imag[uIndex] += ti;
          }
        }
      }
    },
    inverse(real, imag) {
      for (let i = 0; i < n; i++) imag[i] = -imag[i];
      this.transform(real, imag);
      for (let i = 0; i < n; i++) {
        real[i] /= n;
        imag[i] = -imag[i] / n;
      }
    }
  };
}

// ── Spectral Studio Real-Time Engine ──
class FastSpectralEngine {
  constructor(sr = 48000) {
    this.sr = sr;
    this.N = 2048;
    this.hop = 512;
    this.fft = createFFT(this.N);

    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.N));
    }
    this.olaNorm = 1 / 1.5;

    this.pastInL = new Float32Array(this.N - this.hop);
    this.pastInR = new Float32Array(this.N - this.hop);
    this.olaBufL = new Float32Array(this.N);
    this.olaBufR = new Float32Array(this.N);

    this.frameInL = new Float32Array(this.N);
    this.frameInR = new Float32Array(this.N);
    this.rL = new Float32Array(this.N);
    this.iL = new Float32Array(this.N);
    this.rR = new Float32Array(this.N);
    this.iR = new Float32Array(this.N);

    this.binBass = Math.floor(F_BASS_CROSSOVER / (sr / this.N));
    this.binTreble = Math.floor(F_TREBLE_CROSSOVER / (sr / this.N));
  }

  processHop(chunkInL, chunkInR, chunkOutL, chunkOutR, str) {
    if (str <= 0.0001) {
      chunkOutL.set(chunkInL);
      chunkOutR.set(chunkInR);
      return;
    }

    this.frameInL.set(this.pastInL, 0);
    this.frameInL.set(chunkInL, this.N - this.hop);
    this.frameInR.set(this.pastInR, 0);
    this.frameInR.set(chunkInR, this.N - this.hop);

    this.pastInL.copyWithin(0, this.hop);
    this.pastInL.set(chunkInL, this.pastInL.length - this.hop);
    this.pastInR.copyWithin(0, this.hop);
    this.pastInR.set(chunkInR, this.pastInR.length - this.hop);

    for (let i = 0; i < this.N; i++) {
      this.rL[i] = this.frameInL[i] * this.win[i]; this.iL[i] = 0;
      this.rR[i] = this.frameInR[i] * this.win[i]; this.iR[i] = 0;
    }

    this.fft.transform(this.rL, this.iL);
    this.fft.transform(this.rR, this.iR);

    // Spectral Pan Discrimination on vocal frequency band
    for (let k = 1; k < this.N / 2; k++) {
      if (k >= this.binBass && k <= this.binTreble) {
        const magL = Math.sqrt(this.rL[k] * this.rL[k] + this.iL[k] * this.iL[k]);
        const magR = Math.sqrt(this.rR[k] * this.rR[k] + this.iR[k] * this.iR[k]);
        const sumMag = magL + magR + 1e-9;
        const pan = Math.abs(magL - magR) / sumMag;

        // Center factor: 1 at exact center, 0 for panned instruments
        const centerFactor = Math.max(0, 1 - pan * 2.5);
        const gain = (1 - str) + str * Math.max(0, 1 - centerFactor);

        this.rL[k] *= gain; this.iL[k] *= gain;
        this.rR[k] *= gain; this.iR[k] *= gain;
        this.rL[this.N - k] = this.rL[k]; this.iL[this.N - k] = -this.iL[k];
        this.rR[this.N - k] = this.rR[k]; this.iR[this.N - k] = -this.iR[k];
      }
    }

    this.fft.inverse(this.rL, this.iL);
    this.fft.inverse(this.rR, this.iR);

    for (let i = 0; i < this.N; i++) {
      this.olaBufL[i] += this.rL[i] * this.win[i] * this.olaNorm;
      this.olaBufR[i] += this.rR[i] * this.win[i] * this.olaNorm;
    }

    chunkOutL.set(this.olaBufL.subarray(0, this.hop));
    chunkOutR.set(this.olaBufR.subarray(0, this.hop));

    this.olaBufL.copyWithin(0, this.hop);
    this.olaBufL.fill(0, this.N - this.hop);
    this.olaBufR.copyWithin(0, this.hop);
    this.olaBufR.fill(0, this.N - this.hop);
  }

  processBlock(inputL, inputR, outputL, outputR, str) {
    if (str <= 0.0001) {
      outputL.set(inputL);
      outputR.set(inputR);
      return;
    }
    const len = inputL.length;
    for (let offset = 0; offset < len; offset += this.hop) {
      const cInL = inputL.subarray(offset, offset + this.hop);
      const cInR = inputR.subarray(offset, offset + this.hop);
      const cOutL = outputL.subarray(offset, offset + this.hop);
      const cOutR = outputR.subarray(offset, offset + this.hop);
      this.processHop(cInL, cInR, cOutL, cOutR, str);
    }
  }
}

// Helper filter Linkwitz-Riley 4th order
function createLR4(ctx, type, freq) {
  const f1 = ctx.createBiquadFilter();
  f1.type = type;
  f1.frequency.value = freq;
  f1.Q.value = 0.70710678;

  const f2 = ctx.createBiquadFilter();
  f2.type = type;
  f2.frequency.value = freq;
  f2.Q.value = 0.70710678;

  f1.connect(f2);
  return { input: f1, output: f2 };
}

// ── Graph Audio DSP & Spectral Selector ──
function buildGraph(stream) {
  const ctx = audioCtx;
  const source = ctx.createMediaStreamSource(stream);

  const inSplitter = ctx.createChannelSplitter(2);
  source.connect(inSplitter);

  // ==========================================
  // JALUR 1: FAST DSP ENGINE
  // ==========================================
  const dryGainL = ctx.createGain();
  const dryGainR = ctx.createGain();
  dryGainL.gain.value = Math.max(0, 1.0 - strength);
  dryGainR.gain.value = Math.max(0, 1.0 - strength);

  inSplitter.connect(dryGainL, 0);
  inSplitter.connect(dryGainR, 1);

  const bassLP_L = createLR4(ctx, 'lowpass', F_BASS_CROSSOVER);
  const bassLP_R = createLR4(ctx, 'lowpass', F_BASS_CROSSOVER);
  const bassHP_L = createLR4(ctx, 'highpass', F_BASS_CROSSOVER);
  const bassHP_R = createLR4(ctx, 'highpass', F_BASS_CROSSOVER);

  inSplitter.connect(bassLP_L.input, 0);
  inSplitter.connect(bassLP_R.input, 1);
  inSplitter.connect(bassHP_L.input, 0);
  inSplitter.connect(bassHP_R.input, 1);

  const trebleHP_L = createLR4(ctx, 'highpass', F_TREBLE_CROSSOVER);
  const trebleHP_R = createLR4(ctx, 'highpass', F_TREBLE_CROSSOVER);
  const midLP_L = createLR4(ctx, 'lowpass', F_TREBLE_CROSSOVER);
  const midLP_R = createLR4(ctx, 'lowpass', F_TREBLE_CROSSOVER);

  bassHP_L.output.connect(trebleHP_L.input);
  bassHP_R.output.connect(trebleHP_R.input);
  bassHP_L.output.connect(midLP_L.input);
  bassHP_R.output.connect(midLP_R.input);

  const diffBus = ctx.createGain();
  const halfL = ctx.createGain(); halfL.gain.value = 0.5;
  const negHalfR = ctx.createGain(); negHalfR.gain.value = -0.5;
  midLP_L.output.connect(halfL);
  midLP_R.output.connect(negHalfR);
  halfL.connect(diffBus);
  negHalfR.connect(diffBus);

  const notchF0 = ctx.createBiquadFilter();
  notchF0.type = 'peaking';
  notchF0.frequency.value = 220;
  notchF0.Q.value = 4.0;
  notchF0.gain.value = 0;

  const notch2F0 = ctx.createBiquadFilter();
  notch2F0.type = 'peaking';
  notch2F0.frequency.value = 440;
  notch2F0.Q.value = 4.0;
  notch2F0.gain.value = 0;

  diffBus.connect(notchF0);
  notchF0.connect(notch2F0);
  const cleanDiff = notch2F0;

  const wetL = ctx.createGain();
  const wetR = ctx.createGain();
  wetL.gain.value = strength;
  wetR.gain.value = strength;

  bassLP_L.output.connect(wetL);
  cleanDiff.connect(wetL);
  trebleHP_L.output.connect(wetL);

  bassLP_R.output.connect(wetR);
  cleanDiff.connect(wetR);
  trebleHP_R.output.connect(wetR);

  const dspOutL = ctx.createGain();
  const dspOutR = ctx.createGain();
  dryGainL.connect(dspOutL);
  wetL.connect(dspOutL);
  dryGainR.connect(dspOutR);
  wetR.connect(dspOutR);

  // ==========================================
  // JALUR 2: SPECTRAL STUDIO ENGINE (ScriptProcessor STFT)
  // ==========================================
  const spectralEngine = new FastSpectralEngine(ctx.sampleRate);
  const scriptNode = ctx.createScriptProcessor(2048, 2, 2);

  scriptNode.onaudioprocess = (e) => {
    const inL = e.inputBuffer.getChannelData(0);
    const inR = e.inputBuffer.getChannelData(1);
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    spectralEngine.processBlock(inL, inR, outL, outR, strength);
  };

  source.connect(scriptNode);
  const spectralSplitter = ctx.createChannelSplitter(2);
  scriptNode.connect(spectralSplitter);

  // Crossfade selector antara DSP dan Spectral Studio
  const dspMasterL = ctx.createGain();
  const dspMasterR = ctx.createGain();
  const spectralMasterL = ctx.createGain();
  const spectralMasterR = ctx.createGain();

  const isSpectral = currentMode === 'spectral';
  dspMasterL.gain.value = isSpectral ? 0 : 1;
  dspMasterR.gain.value = isSpectral ? 0 : 1;
  spectralMasterL.gain.value = isSpectral ? 1 : 0;
  spectralMasterR.gain.value = isSpectral ? 1 : 0;

  dspOutL.connect(dspMasterL);
  dspOutR.connect(dspMasterR);
  spectralSplitter.connect(spectralMasterL, 0);
  spectralSplitter.connect(spectralMasterR, 1);

  const outMerger = ctx.createChannelMerger(2);
  dspMasterL.connect(outMerger, 0, 0);
  spectralMasterL.connect(outMerger, 0, 0);
  dspMasterR.connect(outMerger, 0, 1);
  spectralMasterR.connect(outMerger, 0, 1);

  outMerger.connect(ctx.destination);

  // Pitch Analyser
  const midCenter = ctx.createGain();
  const halfC_L = ctx.createGain(); halfC_L.gain.value = 0.5;
  const halfC_R = ctx.createGain(); halfC_R.gain.value = 0.5;
  midLP_L.output.connect(halfC_L);
  midLP_R.output.connect(halfC_R);
  halfC_L.connect(midCenter);
  halfC_R.connect(midCenter);

  const scHP = ctx.createBiquadFilter();
  scHP.type = 'highpass';
  scHP.frequency.value = 110;
  scHP.Q.value = 0.7071;

  const scLP = ctx.createBiquadFilter();
  scLP.type = 'lowpass';
  scLP.frequency.value = 1400;
  scLP.Q.value = 0.7071;

  midCenter.connect(scHP);
  scHP.connect(scLP);

  const pitchAnalyser = ctx.createAnalyser();
  pitchAnalyser.fftSize = ANALYSER_FFT;
  pitchAnalyser.smoothingTimeConstant = 0.1;
  scLP.connect(pitchAnalyser);

  const outAnalyser = ctx.createAnalyser();
  outAnalyser.fftSize = 2048;
  outMerger.connect(outAnalyser);

  return {
    source, inSplitter,
    dryGainL, dryGainR,
    wetL, wetR,
    notchF0, notch2F0,
    scriptNode,
    dspMasterL, dspMasterR,
    spectralMasterL, spectralMasterR,
    pitchAnalyser, outAnalyser,
  };
}

function applyEngineMode(mode) {
  currentMode = mode;
  if (!nodes || !audioCtx) return;
  const now = audioCtx.currentTime;
  const tau = 0.05;
  const isSpectral = currentMode === 'spectral';

  nodes.dspMasterL.gain.setTargetAtTime(isSpectral ? 0 : 1, now, tau);
  nodes.dspMasterR.gain.setTargetAtTime(isSpectral ? 0 : 1, now, tau);
  nodes.spectralMasterL.gain.setTargetAtTime(isSpectral ? 1 : 0, now, tau);
  nodes.spectralMasterR.gain.setTargetAtTime(isSpectral ? 1 : 0, now, tau);
}

function applyAdaptiveParams(f0, conf, now) {
  if (!nodes || !audioCtx) return;
  const s = strength;
  const tau = 0.04;

  const targetDry = Math.max(0, 1.0 - s);
  const targetWet = s;

  nodes.dryGainL.gain.setTargetAtTime(targetDry, now, tau);
  nodes.dryGainR.gain.setTargetAtTime(targetDry, now, tau);
  nodes.wetL.gain.setTargetAtTime(targetWet, now, tau);
  nodes.wetR.gain.setTargetAtTime(targetWet, now, tau);

  const effectiveF0 = f0 > 0 ? f0 : smoothedF0;
  const nyquist = audioCtx.sampleRate / 2;

  if (s > 0.05 && effectiveF0 >= PITCH_MIN && effectiveF0 <= PITCH_MAX && conf >= 0.25) {
    const notchDepth = -(12 + 10 * s) * Math.max(0.4, conf);
    nodes.notchF0.frequency.setTargetAtTime(effectiveF0, now, tau);
    nodes.notchF0.gain.setTargetAtTime(notchDepth, now, tau);

    if (effectiveF0 * 2 < nyquist * 0.94) {
      nodes.notch2F0.frequency.setTargetAtTime(effectiveF0 * 2, now, tau);
      nodes.notch2F0.gain.setTargetAtTime(notchDepth * 0.85, now, tau);
    } else {
      nodes.notch2F0.gain.setTargetAtTime(0, now, tau);
    }
  } else {
    nodes.notchF0.gain.setTargetAtTime(0, now, tau * 2);
    nodes.notch2F0.gain.setTargetAtTime(0, now, tau * 2);
  }
}

function startPolling() {
  stopPolling();
  const buf = new Float32Array(nodes.pitchAnalyser.fftSize);

  pollTimer = setInterval(() => {
    if (!audioCtx || !nodes) return;
    const now = audioCtx.currentTime;

    nodes.pitchAnalyser.getFloatTimeDomainData(buf);
    const { f0, conf } = detectPitch(buf, audioCtx.sampleRate);
    currentF0 = f0;
    currentConf = conf;

    if (f0 > 0 && conf >= 0.25) {
      if (smoothedF0 === 0) {
        smoothedF0 = f0;
      } else {
        const ratio = f0 / smoothedF0;
        if (ratio > 0.75 && ratio < 1.35) {
          smoothedF0 = smoothedF0 * 0.55 + f0 * 0.45;
        } else if (conf > 0.65) {
          smoothedF0 = f0;
        }
      }
    } else {
      smoothedF0 *= 0.96;
    }

    applyAdaptiveParams(smoothedF0, conf, now);

    const lvl = new Float32Array(nodes.outAnalyser.fftSize);
    nodes.outAnalyser.getFloatTimeDomainData(lvl);
    let sum = 0;
    for (let i = 0; i < lvl.length; i++) sum += lvl[i] * lvl[i];
    const rms = Math.sqrt(sum / lvl.length);

    const ts = Date.now();
    if (ts - lastStatusSent > 400) {
      lastStatusSent = ts;
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'PITCH_UPDATE',
        pitch: {
          f0: Math.round(smoothedF0),
          note: noteFromFreq(smoothedF0),
          conf: Math.round(conf * 100),
          level: rms,
        },
      }).catch(() => {});
    }
  }, UPDATE_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function startCapture(streamId, newStrength, mode) {
  await stopCapture();
  if (typeof newStrength === 'number') strength = newStrength;
  if (mode) currentMode = mode;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  nodes = buildGraph(mediaStream);
  applyEngineMode(currentMode);
  capturing = true;
  startPolling();

  for (const track of mediaStream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      capturing = false;
      chrome.runtime.sendMessage({ target: 'background', type: 'PITCH_UPDATE', pitch: null }).catch(() => {});
    });
  }
}

async function stopCapture() {
  stopPolling();
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) t.stop();
    mediaStream = null;
  }
  nodes = null;
  if (audioCtx) {
    try { await audioCtx.close(); } catch {}
    audioCtx = null;
  }
  capturing = false;
  currentF0 = 0;
  smoothedF0 = 0;
  currentConf = 0;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId, msg.strength, msg.mode)
      .then(() => sendResponse({ ok: true, capturing: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), capturing: false }));
    return true;
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture()
      .then(() => sendResponse({ ok: true, capturing: false }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === 'SET_STRENGTH') {
    strength = msg.strength;
    if (audioCtx && nodes) {
      applyAdaptiveParams(smoothedF0, Math.max(0.35, currentConf), audioCtx.currentTime);
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'SET_MODE') {
    applyEngineMode(msg.mode);
    sendResponse({ ok: true, mode: currentMode });
  }

  if (msg.type === 'GET_ENGINE_STATUS') {
    sendResponse({ ok: true, capturing, f0: smoothedF0, conf: currentConf, mode: currentMode });
  }
});
