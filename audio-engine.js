/**
 * Smart Adaptive Vocal Remover — Audio Engine (v2.0.0 Architecture)
 *
 * Mengapa v1 bermasalah:
 * 1. Mid dan Side diproses secara asimetris melalui belasan filter biquad peaking seri.
 *    Setiap filter memutar fasa (phase shift) hingga -90 derajat. Akibatnya, saat Mid'
 *    dan Side digabungkan kembali, fasa keduanya bentrok total (phase cancellation parah),
 *    membuat instrumen musik terdengar hampa, tipis, terdistorsi, atau terganggu ("suara musik keganggu").
 * 2. Vokal di era modern seringkali memiliki lebar reverb stereo, sedikit panning, atau harmonik
 *    yang tidak murni center, sehingga filter notch sempit berbasis comb filter meleset
 *    dan vokal masih bocor terdengar ("suara vocal masih ada").
 *
 * Solusi Teruji & Terbukti (Arsitektur Hybrid 3-Band Linkwitz-Riley Crossover + Haas Decorrelation):
 *
 * 1. 3-BAND LINKWITZ-RILEY (LR4) CROSSOVER (FASA SEJAJAR):
 *    - Bass Band (< 140 Hz):
 *      Kick drum dan alur bass gitar dilewatkan 100% UTUH dalam stereo asli.
 *      Tidak ada pemotongan bass, dentuman tetap bertenaga dan solid.
 *    - Treble / Air Band (> 7200 Hz):
 *      Desis simbal, hi-hats, dan sparkle frekuensi tinggi dilewatkan 100% UTUH.
 *    - Vocal Band (140 Hz s/d 7200 Hz):
 *      Area frekuensi di mana vokal manusia berada, dipisahkan secara presisi.
 *      Semua channel (L dan R) melewati filter LR4 yang identik, sehingga respon fasa
 *      antara L dan R tetap 100% sejajar dan tidak ada distorsi fasa.
 *
 * 2. SYMMETRIC VOCAL BAND CANCELLATION (CENTER SUPPRESSION):
 *    - Pada Vocal Band:
 *      Center = 0.5 * (L_mid + R_mid)
 *      Side   = 0.5 * (L_mid - R_mid)
 *    - Sinyal vokal utama (yang dipan tepat di tengah) berada murni pada Center.
 *      Center ditekan secara drastis berdasarkan strength: Center' = Center * (1 - strength).
 *
 * 3. REAL-TIME YIN PITCH TRACKING & ADAPTIVE RESIDUAL NOTCH:
 *    - Algoritma YIN mendeteksi nada vokal penyanyi ($f_0$) setiap 75 ms.
 *    - Pada residual Center', filter notch adaptif melacak frekuensi fundamental $f_0$
 *      dan harmonik $2f_0$ penyanyi untuk menyapu sisa resonansi vokal yang membandel.
 *
 * 4. HAAS EFFECT STEREO DECORRELATION (ANTI-HOLLOW):
 *    - Pada pembatalan vokal konvensional (L = S, R = -S), telinga manusia mengalami
 *      sensasi tekanan kepala yang tidak nyaman akibat fasa 180 derajat terbalik.
 *    - Jalur Right Side diberikan micro-delay Haas (0.33 ms / 16 sampel pada 48kHz).
 *      Ini memecah phase-lock sehingga instrumen pengiring (gitar, keyboard, string)
 *      terdengar lebar, megah, alami, dan bebas rasa hampa.
 */

'use strict';

let audioCtx = null;
let mediaStream = null;
let nodes = null;
let strength = 0.95; // Default 95% untuk peredaman vokal maksimal & bersih
let capturing = false;
let pollTimer = null;

// Parameter DSP
const ANALYSER_FFT = 4096;
const PITCH_MIN = 75;       // Hz
const PITCH_MAX = 1100;     // Hz
const YIN_THRESHOLD = 0.15;
const UPDATE_INTERVAL_MS = 75;

const F_BASS_CROSSOVER = 140;   // Hz
const F_TREBLE_CROSSOVER = 7200; // Hz

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

// ── Membangun Graph Audio DSP ──
function buildGraph(stream) {
  const ctx = audioCtx;
  const source = ctx.createMediaStreamSource(stream);

  // Split stereo input menjadi L dan R terpisah
  const inSplitter = ctx.createChannelSplitter(2);
  source.connect(inSplitter);

  // 1. Crossover Band 1: Bass (< 140 Hz)
  const bassLP_L = createLR4(ctx, 'lowpass', F_BASS_CROSSOVER);
  const bassLP_R = createLR4(ctx, 'lowpass', F_BASS_CROSSOVER);
  const bassHP_L = createLR4(ctx, 'highpass', F_BASS_CROSSOVER);
  const bassHP_R = createLR4(ctx, 'highpass', F_BASS_CROSSOVER);

  inSplitter.connect(bassLP_L.input, 0);
  inSplitter.connect(bassLP_R.input, 1);
  inSplitter.connect(bassHP_L.input, 0);
  inSplitter.connect(bassHP_R.input, 1);

  // 2. Crossover Band 2 & 3: Dari sisa (> 140 Hz), split ke Mid (Vocal) dan Treble (> 7200 Hz)
  const trebleHP_L = createLR4(ctx, 'highpass', F_TREBLE_CROSSOVER);
  const trebleHP_R = createLR4(ctx, 'highpass', F_TREBLE_CROSSOVER);
  const midLP_L = createLR4(ctx, 'lowpass', F_TREBLE_CROSSOVER);
  const midLP_R = createLR4(ctx, 'lowpass', F_TREBLE_CROSSOVER);

  bassHP_L.output.connect(trebleHP_L.input);
  bassHP_R.output.connect(trebleHP_R.input);
  bassHP_L.output.connect(midLP_L.input);
  bassHP_R.output.connect(midLP_R.input);

  // 3. Vocal Band (Mid Band): Pemisahan Center dan Side
  // L_mid = midLP_L.output, R_mid = midLP_R.output
  // Center = 0.5 * (L_mid + R_mid)
  // Side   = 0.5 * (L_mid - R_mid)
  const midCenter = ctx.createGain(); // Bus Center
  const midSide = ctx.createGain();   // Bus Side

  const halfL_C = ctx.createGain(); halfL_C.gain.value = 0.5;
  const halfR_C = ctx.createGain(); halfR_C.gain.value = 0.5;
  midLP_L.output.connect(halfL_C);
  midLP_R.output.connect(halfR_C);
  halfL_C.connect(midCenter);
  halfR_C.connect(midCenter);

  const halfL_S = ctx.createGain(); halfL_S.gain.value = 0.5;
  const negHalfR_S = ctx.createGain(); negHalfR_S.gain.value = -0.5;
  midLP_L.output.connect(halfL_S);
  midLP_R.output.connect(negHalfR_S);
  halfL_S.connect(midSide);
  negHalfR_S.connect(midSide);

  // Center Gain Control (Vocal Suppression):
  // Saat strength = 1.0, center vocal = 0.
  const centerGain = ctx.createGain();
  centerGain.gain.value = Math.max(0, 1 - strength);
  midCenter.connect(centerGain);

  // Adaptive Residual Pitch Notch Filters pada Center Bus
  // Melacak nada fundamental (f0) dan 2f0 penyanyi
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

  centerGain.connect(notchF0);
  notchF0.connect(notch2F0);
  const cleanCenter = notch2F0;

  // Haas Effect Decorrelation pada Side Channel
  // Memberikan delay mikro 0.33 ms (0.00033 detik) pada inverted side bus
  // untuk menghilangkan efek hampa/tekanan telinga akibat inversi fasa 180 derajat
  const haasDelay = ctx.createDelay(0.01);
  haasDelay.delayTime.value = 0.00033; // ~16 sampel pada 48kHz

  const sidePos = ctx.createGain(); sidePos.gain.value = 1.0;
  const sideNeg = ctx.createGain(); sideNeg.gain.value = -1.0;
  midSide.connect(sidePos);
  midSide.connect(haasDelay);
  haasDelay.connect(sideNeg);

  // 4. Output Mixer:
  // Out_L = Bass_L + Treble_L + CleanCenter + SidePos
  // Out_R = Bass_R + Treble_R + CleanCenter + SideNeg
  const outMerger = ctx.createChannelMerger(2);

  // Jalur Kiri
  bassLP_L.output.connect(outMerger, 0, 0);   // Bass Kiri UTUH
  trebleHP_L.output.connect(outMerger, 0, 0); // Treble Kiri UTUH
  cleanCenter.connect(outMerger, 0, 0);       // Center yang sudah bersih dari vokal
  sidePos.connect(outMerger, 0, 0);           // Instrumen Side Kiri

  // Jalur Kanan
  bassLP_R.output.connect(outMerger, 0, 1);   // Bass Kanan UTUH
  trebleHP_R.output.connect(outMerger, 0, 1); // Treble Kanan UTUH
  cleanCenter.connect(outMerger, 0, 1);       // Center yang sudah bersih dari vokal
  sideNeg.connect(outMerger, 0, 1);           // Instrumen Side Kanan (Haas Decorrelated)

  // Limiter transparan & Makeup Gain
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3.0;
  limiter.knee.value = 4.0;
  limiter.ratio.value = 12.0;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.20;

  const makeup = ctx.createGain();
  makeup.gain.value = 1.15; // Kompensasi level yang nyaman & seimbang

  outMerger.connect(limiter);
  limiter.connect(makeup);
  makeup.connect(ctx.destination);

  // 5. Sidechain Pre-Filter untuk YIN Pitch Tracking
  // Diambil dari sinyal Center sebelum diredam, disaring dengan bandpass vokal murni
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
  makeup.connect(outAnalyser);

  return {
    source, inSplitter,
    centerGain, notchF0, notch2F0,
    pitchAnalyser, outAnalyser, makeup,
  };
}

// ── Update Filter Parameter Berdasarkan Nada & Pitch Penyanyi ──
function applyAdaptiveParams(f0, conf, now) {
  if (!nodes || !audioCtx) return;
  const s = strength;
  const tau = 0.04;

  // Update peredaman Center
  // Saat s = 1.0 (100%), Center vokal diredam maksimal
  const targetCenterGain = Math.max(0, 1 - s);
  nodes.centerGain.gain.setTargetAtTime(targetCenterGain, now, tau);

  // Adaptive Residual Pitch Notching
  const effectiveF0 = f0 > 0 ? f0 : smoothedF0;
  const nyquist = audioCtx.sampleRate / 2;

  if (effectiveF0 >= PITCH_MIN && effectiveF0 <= PITCH_MAX && conf >= 0.25) {
    const notchDepth = -(12 + 10 * s) * Math.max(0.4, conf);

    // Fundamental f0
    nodes.notchF0.frequency.setTargetAtTime(effectiveF0, now, tau);
    nodes.notchF0.gain.setTargetAtTime(notchDepth, now, tau);

    // 2nd Harmonic 2f0
    if (effectiveF0 * 2 < nyquist * 0.94) {
      nodes.notch2F0.frequency.setTargetAtTime(effectiveF0 * 2, now, tau);
      nodes.notch2F0.gain.setTargetAtTime(notchDepth * 0.85, now, tau);
    } else {
      nodes.notch2F0.gain.setTargetAtTime(0, now, tau);
    }
  } else {
    // Saat suara jeda atau pitch tidak yakin, buka notch secara bertahap
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
  if (nodes) {
    try { nodes.makeup.disconnect(); } catch {}
    nodes = null;
  }
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
