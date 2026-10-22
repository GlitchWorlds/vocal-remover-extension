/**
 * Popup UI — Adaptive Vocal Remover (v3.0.0 Dual-Engine)
 * Toggle on/off, engine mode selector, strength slider, live pitch & level meter.
 */

const toggle = document.getElementById('toggle');
const toggleLabel = document.getElementById('toggleLabel');
const engineBadge = document.getElementById('engineBadge');
const btnSpectral = document.getElementById('btnSpectral');
const btnDsp = document.getElementById('btnDsp');
const pitchReadout = document.getElementById('pitchReadout');
const pitchBar = document.getElementById('pitchBar');
const levelReadout = document.getElementById('levelReadout');
const levelBar = document.getElementById('levelBar');
const strengthInput = document.getElementById('strength');
const strengthValue = document.getElementById('strengthValue');
const statusLine = document.getElementById('statusLine');

// PITCH_MIN/MAX harus sinkron dengan audio-engine.js (75–1100 Hz)
const PITCH_MIN = 75;
const PITCH_MAX = 1100;
let currentMode = 'spectral';

function setStatus(text, isError) {
  statusLine.textContent = text;
  statusLine.style.color = isError ? '#f87171' : '';
}

function updateModeUI(mode) {
  currentMode = mode || 'spectral';
  const isSpectral = currentMode === 'spectral';
  btnSpectral.classList.toggle('active', isSpectral);
  btnDsp.classList.toggle('active', !isSpectral);
  engineBadge.textContent = isSpectral ? 'Spectral' : 'Fast DSP';
}

function applyState(state) {
  toggle.checked = state.enabled;
  toggleLabel.textContent = state.enabled ? 'ON' : 'OFF';
  toggleLabel.classList.toggle('on', state.enabled);
  strengthInput.value = Math.round(state.strength * 100);
  strengthValue.textContent = Math.round(state.strength * 100) + '%';
  updateModeUI(state.mode);

  if (!state.enabled) {
    setStatus('Klik toggle untuk mulai di tab Spotify aktif.');
    pitchReadout.textContent = '—';
    pitchBar.style.width = '0%';
    levelBar.style.width = '0%';
    levelReadout.textContent = '—';
  } else {
    setStatus('Remover aktif. Putar lagu di tab Spotify.');
  }
}

async function init() {
  const state = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
  if (state) applyState(state);
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  toggle.disabled = true;
  setStatus(enabled ? 'Mengaktifkan…' : 'Menonaktifkan…');
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'SET_ENABLED', enabled });
  toggle.disabled = false;
  if (!res || !res.ok) {
    toggle.checked = !enabled;
    setStatus((res && res.error) || 'Gagal mengubah status.', true);
    return;
  }
  applyState({ enabled, strength: strengthInput.value / 100, mode: currentMode });
  if (enabled) {
    setStatus('Remover aktif. Pastikan lagu diputar di tab Spotify yang sama.');
  }
});

btnSpectral.addEventListener('click', async () => {
  if (currentMode === 'spectral') return;
  updateModeUI('spectral');
  await chrome.runtime.sendMessage({ target: 'background', type: 'SET_MODE', mode: 'spectral' });
});

btnDsp.addEventListener('click', async () => {
  if (currentMode === 'dsp') return;
  updateModeUI('dsp');
  await chrome.runtime.sendMessage({ target: 'background', type: 'SET_MODE', mode: 'dsp' });
});

let strengthTimer = null;
strengthInput.addEventListener('input', () => {
  const pct = Number(strengthInput.value);
  strengthValue.textContent = pct + '%';
  clearTimeout(strengthTimer);
  strengthTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ target: 'background', type: 'SET_STRENGTH', strength: pct / 100 });
  }, 120);
});

// Live meter dari storage.session (diisi background dari PITCH_UPDATE offscreen)
chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.lastPitch) return;
  const p = changes.lastPitch.newValue;
  renderPitch(p);
});

function renderPitch(p) {
  if (!p) {
    pitchReadout.textContent = '—';
    pitchBar.style.width = '0%';
    levelBar.style.width = '0%';
    levelReadout.textContent = '—';
    return;
  }
  if (p.f0 > 0) {
    const pct = Math.max(0, Math.min(1,
      (Math.log(p.f0 / PITCH_MIN) / Math.log(PITCH_MAX / PITCH_MIN))));
    pitchBar.style.width = (pct * 100).toFixed(0) + '%';
    pitchReadout.textContent = `${p.note || ''} ${p.f0} Hz · ${p.conf}%`;
  } else {
    pitchBar.style.width = '0%';
    pitchReadout.textContent = 'no vocal pitch';
  }
  const lvlPct = Math.min(100, Math.round((20 * Math.log10(Math.max(p.level, 1e-6)) + 60) / 60 * 100));
  levelBar.style.width = Math.max(0, lvlPct) + '%';
  levelReadout.textContent = lvlPct > 0 ? lvlPct + '%' : 'silent';
}

init();
