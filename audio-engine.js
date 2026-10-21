/**
 * Smart Adaptive Vocal Remover — Audio Engine (Offscreen Document)
 *
 * Arsitektur Audio DSP Real-Time (Web Audio API):
 *
 * 1. MID / SIDE MATRIX DECOMPOSITION:
 *    - Left & Right dipecah menjadi:
 *      * Mid = (L + R) / 2  (konten center: vokal utama, bass, kick)
 *      * Side = (L - R) / 2 (konten stereo: gitar panned, synth, reverb lebar)
 *    - Side dilewatkan 100% tanpa distorsi, menjaga lebar instrumen stereo.
 *
 * 2. VOCAL SIDECHAIN FILTER UNTUK PITCH TRACKING:
 *    - Sinyal Mid dicabangkan ke sidechain filter (2-stage 4th order Highpass 110Hz + Lowpass 1400Hz).
 *    - Sub-bass, kick drum, dan cymbals dibuang dari path analisis agar algoritma YIN
 *      mengunci murni frekuensi fundamental vokal penyanyi (f0), bukan instrumen bass.
 *
 * 3. REAL-TIME PITCH-ADAPTIVE HARMONIC COMB FILTER:
 *    - Algoritma YIN mendeteksi f0 penyanyi (75 Hz - 1100 Hz).
 *    - 14 harmonic notch biquad filter diposisikan otomatis ke f0, 2f0, 3f0, ..., 14f0.
 *    - Notch bergerak halus (parameter automation via setTargetAtTime) mengikuti nada & vibrato penyanyi.
 *
 * 4. VOCAL FORMANT SUPPRESSION + BASS PRESERVATION:
 *    - Mid band vokal (200 Hz - 5000 Hz) diredam secara drastis (-20 s/d -30 dB).
 *    - Low-shelf filter pada 130 Hz memulihkan kick drum & bass guitar agar beat tetap bertenaga.
 *    - High-shelf filter pada 7500 Hz menjaga kejernihan treble dan cymbals.
 *    - Fixed formant cuts di 750 Hz, 1300 Hz, 2500 Hz, dan 3500 Hz mengeliminasi sisa resonansi vokal.
 *
 * 5. STEREO RECONSTRUCTION & DYNAMICS LIMITER:
 *    - Stereo direkonstruksi: Out_L = Mid' + Side, Out_R = Mid' - Side.
 *    - Melewati DynamicsCompressor limiter transparan untuk mencegah clipping.
 */

'use strict';

let audioCtx = null;
let mediaStream = null;
let nodes = null;
let strength = 0.85; // Default 85%
let capturing = false;
let pollTimer = null;

// Parameter DSP
const ANALYSER_FFT = 4096;
const COMB_COUNT = 14;      // Jumlah harmonik yang dilacak
const PITCH_MIN = 75;       // Hz (Bass / Baritone)
const PITCH_MAX = 1100;     // Hz (Soprano)
const YIN_THRESHOLD = 0.15;
const UPDATE_INTERVAL_MS = 75; // Update pitch setiap 75ms untuk responsivitas tinggi

const FORMANT_CUTS = [
  { f: 750,  q: 1.2, w: 1.0 }, // F1 vowel formant
  { f: 1300, q: 1.2, w: 1.2 }, // F2 vowel formant
  { f: 2500, q: 1.3, w: 1.1 }, // Singer's formant
  { f: 3500, q: 1.4, w: 0.9 }, // High articulation
];

let currentF0 = 0;
let currentConf = 0;
let smoothedF0 = 0;
let lastStatusSent = 0;

// Util: konversi frekuensi ke nama not musik
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

  // 1. Difference function
  const d = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // 2. Cumulative mean normalized difference (CMND)
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * (tau - tauMin + 1)) / running : 1;
  }

  // 3. Absolute thresholding & local minimum
  let tauEstimate = -1;
  for (let tau = tauMin + 1; tau <= tauMax; tau++) {
    if (cmnd[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  // 4. Fallback ke global dip bila di bawah 0.35
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

  // 5. Parabolic interpolation untuk sub-sample accuracy
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

// ── Bangun Graph Audio DSP ──
function buildGraph(stream) {
  const ctx = audioCtx;
  const source = ctx.createMediaStreamSource(stream);

  // --- Step 1: Mid / Side Splitter Matrix ---
  const splitter = ctx.createChannelSplitter(2);
  source.connect(splitter);

  const midBus = ctx.createGain();   // (L + R) / 2
  const sideBus = ctx.createGain();  // (L - R) / 2
  const halfL = ctx.createGain(); halfL.gain.value = 0.5;
  const halfR = ctx.createGain(); halfR.gain.value = 0.5;
  const negHalfR = ctx.createGain(); negHalfR.gain.value = -0.5;

  splitter.connect(halfL, 0);
  splitter.connect(halfR, 1);
  splitter.connect(negHalfR, 1);

  halfL.connect(midBus);
  halfR.connect(midBus);
  halfL.connect(sideBus);
  negHalfR.connect(sideBus);

  // --- Step 2: Vocal Sidechain Filter untuk Pitch Tracking ---
  // Mid -> HP 110Hz (stage 1) -> HP 110Hz (stage 2) -> LP 1300Hz -> pitchAnalyser
  const scHP1 = ctx.createBiquadFilter();
  scHP1.type = 'highpass';
  scHP1.frequency.value = 110;
  scHP1.Q.value = 0.707;

  const scHP2 = ctx.createBiquadFilter();
  scHP2.type = 'highpass';
  scHP2.frequency.value = 110;
  scHP2.Q.value = 0.707;

  const scLP = ctx.createBiquadFilter();
  scLP.type = 'lowpass';
  scLP.frequency.value = 1300;
  scLP.Q.value = 0.707;

  midBus.connect(scHP1);
  scHP1.connect(scHP2);
  scHP2.connect(scLP);

  const pitchAnalyser = ctx.createAnalyser();
  pitchAnalyser.fftSize = ANALYSER_FFT;
  pitchAnalyser.smoothingTimeConstant = 0.1;
  scLP.connect(pitchAnalyser);

  // --- Step 3: Mid Channel Vocal Removal Processing Chain ---
  // Mid Gain Global (dalam, hingga -26 dB)
  const midGain = ctx.createGain();
  const initMidAtten = Math.pow(10, -(12 + 16 * strength) / 20);
  midGain.gain.value = initMidAtten;
  midBus.connect(midGain);

  // Bass Restoration Shelf: Mengembalikan kick & bass gitar di Mid (<130Hz)
  const bassShelf = ctx.createBiquadFilter();
  bassShelf.type = 'lowshelf';
  bassShelf.frequency.value = 130;
  bassShelf.gain.value = (12 + 15 * strength) * 0.95;
  midGain.connect(bassShelf);

  // High Air Shelf: Menjaga cymbals & treble stereo (>7500Hz)
  const highShelf = ctx.createBiquadFilter();
  highShelf.type = 'highshelf';
  highShelf.frequency.value = 7500;
  highShelf.gain.value = (10 + 10 * strength) * 0.65;
  bassShelf.connect(highShelf);

  // Fixed Formant Suppression Cuts
  const formants = [];
  let chainHead = highShelf;
  for (const spec of FORMANT_CUTS) {
    const f = ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = spec.f;
    f.Q.value = spec.q;
    f.gain.value = -(6 + 10 * strength) * spec.w;
    chainHead.connect(f);
    chainHead = f;
    formants.push(f);
  }

  // Adaptive Harmonic Comb Notches (14 harmonik)
  const comb = [];
  for (let i = 0; i < COMB_COUNT; i++) {
    const f = ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = 220 * (i + 1);
    f.Q.value = 5.0;
    f.gain.value = 0; // Default flat sebelum pitch terkunci
    chainHead.connect(f);
    chainHead = f;
    comb.push(f);
  }
  const midOut = chainHead;

  // --- Step 4: Rekonstruksi Stereo (Out = Mid' ± Side) ---
  const merger = ctx.createChannelMerger(2);
  const sidePos = ctx.createGain(); sidePos.gain.value = 1.0;
  const sideNeg = ctx.createGain(); sideNeg.gain.value = -1.0;

  midOut.connect(merger, 0, 0); // Left channel
  midOut.connect(merger, 0, 1); // Right channel

  sideBus.connect(sidePos);
  sidePos.connect(merger, 0, 0); // L = Mid' + Side

  sideBus.connect(sideNeg);
  sideNeg.connect(merger, 0, 1); // R = Mid' - Side

  // --- Step 5: Limiter & Makeup Gain ---
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4.0;
  limiter.knee.value = 6.0;
  limiter.ratio.value = 12.0;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.20;

  const makeup = ctx.createGain();
  makeup.gain.value = 1.0 + strength * 0.35;

  merger.connect(limiter);
  limiter.connect(makeup);
  makeup.connect(ctx.destination);

  // Meter output level
  const outAnalyser = ctx.createAnalyser();
  outAnalyser.fftSize = 2048;
  makeup.connect(outAnalyser);

  return {
    source, splitter, midBus, sideBus, midGain,
    bassShelf, highShelf, formants, comb,
    merger, limiter, makeup, pitchAnalyser, outAnalyser,
  };
}

// ── Update Filter Parameter Berdasarkan Nada & Pitch Penyanyi ──
function applyAdaptiveParams(f0, conf, now) {
  if (!nodes || !audioCtx) return;
  const s = strength;
  const tau = 0.05; // Smoothing transisi anti-klik

  // 1. Mid Gain Vocal Band Attenuation
  // Semakin tinggi strength, semakin dalam vokal diredam (-14dB hingga -28dB)
  const attenDB = -(14 + 14 * s);
  const midGainLinear = Math.pow(10, attenDB / 20);
  nodes.midGain.gain.setTargetAtTime(midGainLinear, now, tau);

  // Bass & High restoration
  nodes.bassShelf.gain.setTargetAtTime(-attenDB * 0.92, now, tau);
  nodes.highShelf.gain.setTargetAtTime(-attenDB * 0.55, now, tau);

  // 2. Fixed Formant Cuts
  for (let i = 0; i < nodes.formants.length; i++) {
    const spec = FORMANT_CUTS[i];
    const depth = -(8 + 12 * s) * spec.w;
    nodes.formants[i].gain.setTargetAtTime(depth, now, tau);
  }

  // 3. Dynamic Harmonic Comb Filter
  const nyquist = audioCtx.sampleRate / 2;
  const effectiveF0 = f0 > 0 ? f0 : smoothedF0;
  const hasConfidentPitch = effectiveF0 >= PITCH_MIN && effectiveF0 <= PITCH_MAX && conf >= 0.25;

  for (let n = 1; n <= COMB_COUNT; n++) {
    const filter = nodes.comb[n - 1];
    const freq = effectiveF0 * n;

    if (!hasConfidentPitch || freq >= nyquist * 0.94) {
      // Saat suara berhenti / pitch tidak yakin, buka notch secara bertahap
      filter.gain.setTargetAtTime(0, now, tau * 2);
      continue;
    }

    // Bobot filter: region vokal utama (200 - 3800 Hz) dipotong dalam
    let weight = 1.0;
    if (freq < 200) weight = 0.45; // Lindungi nada bass
    else if (freq > 4000) weight = 0.60;

    const notchDepth = -(10 + 16 * s) * weight * Math.max(0.4, conf);
    const Q = Math.max(3.0, Math.min(8.5, freq / (effectiveF0 * 0.55)));

    filter.frequency.setTargetAtTime(freq, now, tau);
    filter.Q.setTargetAtTime(Q, now, tau);
    filter.gain.setTargetAtTime(notchDepth, now, tau);
  }

  // Makeup gain
  nodes.makeup.gain.setTargetAtTime(1.0 + s * 0.4, now, tau);
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

    // Pitch smoothing & tracking logic
    if (f0 > 0 && conf >= 0.25) {
      if (smoothedF0 === 0) {
        smoothedF0 = f0;
      } else {
        const ratio = f0 / smoothedF0;
        if (ratio > 0.75 && ratio < 1.35) {
          // Glissando / legato / vibrato normal: smooth tracking
          smoothedF0 = smoothedF0 * 0.55 + f0 * 0.45;
        } else if (conf > 0.65) {
          // Pindah nada baru (melodic step jump): langsung ikuti
          smoothedF0 = f0;
        }
      }
    } else {
      smoothedF0 *= 0.96; // Decay halus saat jeda vokal
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
