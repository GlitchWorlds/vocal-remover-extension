// Test YIN pitch detection dari audio-engine.js dengan sine wave sintetis
const fs = require('fs');
const src = fs.readFileSync(
  'D:/OpenClaw/workspace/master-manager-agent/projects/vocal-remover-extension/audio-engine.js',
  'utf8'
);

// Ekstrak fungsi detectPitch + konstantanya
const constBlock = src.match(/const PITCH_MIN[\s\S]*?const YIN_THRESHOLD = [\d.]+;/)[0];
const funcBlock = src.match(/function detectPitch[\s\S]*?\n}\n/)[0];
eval(constBlock + '\n' + funcBlock);

const sr = 48000;
const N = 4096;

function makeSine(freq, noiseAmp = 0.005) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    buf[i] = Math.sin(2 * Math.PI * freq * i / sr)
      + (Math.random() - 0.5) * 2 * noiseAmp;
  }
  return buf;
}

// Test pitch range penyanyi: bass (E2 ~82Hz) sampai sopran (E6 ~1318, tapi cap 1100)
const testFreqs = [82.4, 110, 146.8, 196, 220, 261.6, 329.6, 440, 523.3, 659.3, 880, 1046.5];
let pass = 0, fail = 0;

for (const f of testFreqs) {
  const { f0, conf } = detectPitch(makeSine(f), sr);
  const err = Math.abs(f0 - f) / f;
  const ok = err < 0.02 && conf > 0.5;
  console.log(`${ok ? 'PASS' : 'FAIL'} target=${f.toFixed(1)}Hz got=${f0.toFixed(1)}Hz err=${(err*100).toFixed(2)}% conf=${conf.toFixed(2)}`);
  ok ? pass++ : fail++;
}

// Noise-only: tidak boleh ada pitch confident (false positive)
let falsePos = 0;
for (let t = 0; t < 20; t++) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) buf[i] = (Math.random() - 0.5) * 2 * 0.3;
  const { conf } = detectPitch(buf, sr);
  if (conf > 0.7) falsePos++;
}
console.log(`Noise-only false positives (conf>0.7): ${falsePos}/20 (want 0)`);

// Silence
const silence = new Float32Array(N);
const r = detectPitch(silence, sr);
console.log(`Silence: f0=${r.f0} conf=${r.conf} (want conf<=0)`);

console.log(`\nPitch tests: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 || falsePos > 0 ? 1 : 0);
