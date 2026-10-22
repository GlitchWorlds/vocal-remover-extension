const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '../audio-engine.js');
const src = fs.readFileSync(srcPath, 'utf8');

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
  if (err < 0.03 && conf > 0.8) {
    pass++;
    console.log(`PASS target=${f.toFixed(1)}Hz got=${f0.toFixed(1)}Hz err=${(err*100).toFixed(2)}% conf=${conf.toFixed(2)}`);
  } else {
    fail++;
    console.error(`FAIL target=${f} got=${f0} err=${err} conf=${conf}`);
  }
}

// Noise test: white noise tidak boleh memicu f0 dengan conf tinggi
let falsePos = 0;
for (let i = 0; i < 20; i++) {
  const noise = new Float32Array(N);
  for (let j = 0; j < N; j++) noise[j] = (Math.random() - 0.5) * 0.2;
  const { f0, conf } = detectPitch(noise, sr);
  if (f0 > 0 && conf > 0.7) falsePos++;
}
console.log(`Noise-only false positives (conf>0.7): ${falsePos}/20 (want 0)`);

// Silence test
const silence = new Float32Array(N);
const resSilence = detectPitch(silence, sr);
console.log(`Silence: f0=${resSilence.f0} conf=${resSilence.conf} (want conf<=0)`);

console.log(`\nPitch tests: ${pass} pass, ${fail} fail`);
if (fail > 0 || falsePos > 2) process.exit(1);
