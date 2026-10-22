/**
 * Smart Adaptive Vocal Remover — Audio Engine (v2.1.0 Architecture)
 *
 * Root Cause & Engineering Solutions:
 * 1. ZERO-DIFFERENCE AT STRENGTH = 0 (TRUE DRY/WET CROSSFADE):
 *    - Masalah sebelumnya: saat fitur ON tapi strength 0, audio tetap melewati filter crossover,
 *      limiter, delay, dan makeup gain, sehingga suara tetap berubah dibandingkan posisi OFF.
 *    - Solusi v2.1.0: Menerapkan True Dry/Wet Gain Matrix.
 *      * Jalur Dry: Input murni tanpa filter, tanpa delay, tanpa limiter, dikalikan (1 - strength).
 *      * Jalur Wet: Pemrosesan penghilang vokal, dikalikan (strength).
 *      * Saat strength = 0: Jalur Dry = 1.0 (100%), Jalur Wet = 0.0 (0%).
 *        Suara yang keluar 100% bit-for-bit identik dengan kondisi OFF tanpa perbedaan sekecil apa pun!
 *      * Saat strength digeser 0% -> 100%: Volume vokal berkurang secara presisi dan proporsional.
 *
 * 2. MENCEGAH LAGU/MUSIK IKUT HILANG (IN-PHASE DIFF + 3-BAND CROSSOVER):
 *    - Masalah sebelumnya: sinyal Side diberi polaritas berlawanan (+Side pada L, -Side pada R).
 *      Saat diputar di speaker laptop/kamar, gelombang +Side dan -Side bertabrakan di udara
 *      sehingga saling menghilangkan (acoustic cancellation). Akibatnya lagunya terasa lenyap!
 *    - Solusi v2.1.0:
 *      * Bass Band (< 130 Hz): Kick drum dan bass guitar 100% UTUH stereo asli.
 *      * Treble Band (> 7000 Hz): Simbal, hi-hat, dan sparkle 100% UTUH stereo asli.
 *      * Vocal Band (130 Hz - 7000 Hz): Center vokal ditiadakan murni via selisih in-phase (L - R) / 2
 *        ke kedua channel stereo, sehingga fasa di udara saling menguatkan (bukan saling mematikan).
 *        Lagu, melodi instrumen, dan ritme musik tetap terdengar keras, tebal, dan jelas!
 *
 * 3. REAL-TIME YIN PITCH RESIDUAL NOTCH:
 *    - Melacak nada fundamental (f0) penyanyi secara adaptif setiap 75 ms untuk menyapu
 *      sisa-sisa vibrato dan resonansi vokal pada jalur Wet.
 */

'use strict';

let audioCtx = null;
let mediaStream = null;
let nodes = null;
let strength = 1.0; // Default 100% removal
let capturing = false;
let pollTimer = null;

// Parameter DSP
const ANALYSER_FFT = 4096;
const PITCH_MIN = 75;       // Hz
const PITCH_MAX = 1100;     // Hz
const YIN_THRESHOLD = 0.15;
const UPDATE_INTERVAL_MS = 75;

const F_BASS_CROSSOVER = 130;    // Hz
const F_TREBLE_CROSSOVER = 7000;  // Hz

let currentF0 = 0;
let currentConf = 0;
let smoothedF0 = 0;
let lastStatusSent = 0;

// Util: konversi frekuensi ke not musik
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

// Helper membuat Linkwitz-Riley 4th order filter (2 cascaded Butterworths Q=0.7071)
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

// ── Membangun Graph Audio DSP (True Dry/Wet Architecture) ──
function buildGraph(stream) {
  const ctx = audioCtx;
  const source = ctx.createMediaStreamSource(stream);

  // Split input stereo L dan R
  const inSplitter = ctx.createChannelSplitter(2);
  source.connect(inSplitter);

  // ==========================================
  // JALUR 1: PURE DRY PATH (Direct Pass-Through)
  // Tidak ada filter, tidak ada delay, tidak ada kompresi!
  // ==========================================
  const dryGainL = ctx.createGain();
  const dryGainR = ctx.createGain();
  dryGainL.gain.value = Math.max(0, 1.0 - strength);
  dryGainR.gain.value = Math.max(0, 1.0 - strength);

  inSplitter.connect(dryGainL, 0);
  inSplitter.connect(dryGainR, 1);

  // ==========================================
  // JALUR 2: WET PATH (Vocal Removal Processing)
  // ==========================================
  // 1. Crossover Band 1: Bass (< 130 Hz)
  const bassLP_L = createLR4(ctx, 'lowpass', F_BASS_CROSSOVER);
  const bassLP_R = createLR4(ctx, 'lowpass', F_BASS_CROSSOVER);
  const bassHP_L = createLR4(ctx, 'highpass', F_BASS_CROSSOVER);
  const bassHP_R = createLR4(ctx, 'highpass', F_BASS_CROSSOVER);

  inSplitter.connect(bassLP_L.input, 0);
  inSplitter.connect(bassLP_R.input, 1);
  inSplitter.connect(bassHP_L.input, 0);
  inSplitter.connect(bassHP_R.input, 1);

  // 2. Crossover Band 2 & 3: Dari sisa (>130 Hz), split ke Mid (Vocal) dan Treble (>7000 Hz)
  const trebleHP_L = createLR4(ctx, 'highpass', F_TREBLE_CROSSOVER);
  const trebleHP_R = createLR4(ctx, 'highpass', F_TREBLE_CROSSOVER);
  const midLP_L = createLR4(ctx, 'lowpass', F_TREBLE_CROSSOVER);
  const midLP_R = createLR4(ctx, 'lowpass', F_TREBLE_CROSSOVER);

  bassHP_L.output.connect(trebleHP_L.input);
  bassHP_R.output.connect(trebleHP_R.input);
  bassHP_L.output.connect(midLP_L.input);
  bassHP_R.output.connect(midLP_R.input);

  // 3. Vocal Band (Mid Band): Selisih In-Phase (L - R) / 2
  // Vokal center identik di L dan R, sehingga L - R = 0 (100% vokal tereliminasi)
  // Instrumen panned (gitar, keyboard) tetap ada.
  const diffBus = ctx.createGain();
  const halfL = ctx.createGain(); halfL.gain.value = 0.5;
  const negHalfR = ctx.createGain(); negHalfR.gain.value = -0.5;

  midLP_L.output.connect(halfL);
  midLP_R.output.connect(negHalfR);
  halfL.connect(diffBus);
  negHalfR.connect(diffBus);

  // Adaptive Residual Pitch Notching pada bus Diff
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

  // Wet Output Recombination
  // Wet_L = Bass_L + CleanDiff + Treble_L
  // Wet_R = Bass_R + CleanDiff + Treble_R
  // In-phase diff ke kedua telinga: Mencegah acoustic phase cancellation di speaker!
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

  // ==========================================
  // JALUR 3: FINAL MASTER OUTPUT MERGER
  // Out_L = Dry_L + Wet_L
  // Out_R = Dry_R + Wet_R
  // ==========================================
  const outMerger = ctx.createChannelMerger(2);
  dryGainL.connect(outMerger, 0, 0);
  wetL.connect(outMerger, 0, 0);

  dryGainR.connect(outMerger, 0, 1);
  wetR.connect(outMerger, 0, 1);

  outMerger.connect(ctx.destination);

  // ==========================================
  // JALUR ANALISIS PITCH & METER
  // ==========================================
  // Diambil dari center sinyal mid untuk deteksi nada vokal penyanyi
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
    pitchAnalyser, outAnalyser,
  };
}

// ── Update Filter Parameter Berdasarkan Nada & Pitch Penyanyi ──
function applyAdaptiveParams(f0, conf, now) {
  if (!nodes || !audioCtx) return;
  const s = strength;
  const tau = 0.04;

  // 1. Update True Dry/Wet Gains
  // At s = 0: dry = 1.0, wet = 0.0 (BIT-EXACT DIRECT PASS-THROUGH)
  // At s = 1: dry = 0.0, wet = 1.0 (100% VOCAL REMOVAL)
  const targetDry = Math.max(0, 1.0 - s);
  const targetWet = s;

  nodes.dryGainL.gain.setTargetAtTime(targetDry, now, tau);
  nodes.dryGainR.gain.setTargetAtTime(targetDry, now, tau);
  nodes.wetL.gain.setTargetAtTime(targetWet, now, tau);
  nodes.wetR.gain.setTargetAtTime(targetWet, now, tau);

  // 2. Adaptive Residual Pitch Notching
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

// ── Polling Loop Deteksi Pitch ──
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

    // Pitch smoothing logic
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

    // Hitung level output (RMS)
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

// ── Lifecycle Capture ──
async function startCapture(streamId, newStrength) {
  await stopCapture();
  if (typeof newStrength === 'number') strength = newStrength;

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

// ── Runtime Messaging ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId, msg.strength)
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

  if (msg.type === 'GET_ENGINE_STATUS') {
    sendResponse({ ok: true, capturing, f0: smoothedF0, conf: currentConf });
  }
});
