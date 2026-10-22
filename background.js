/**
 * Smart Adaptive Vocal Remover — background service worker (MV3)
 *
 * Mengatur siklus hidup audio capture:
 * 1. Mendeteksi tab musik (mengutamakan Spotify open.spotify.com) atau tab aktif.
 * 2. Membuka offscreen document dengan izin USER_MEDIA (AudioContext Web Audio).
 * 3. Meminta streamId via chrome.tabCapture.getMediaStreamId.
 * 4. Mengalirkan streamId ke offscreen document untuk diproses secara real-time.
 */

const OFFSCREEN_PATH = 'offscreen.html';

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Process captured tab audio to remove vocals in real time via dual-engine DSP/STFT',
  });
}

async function stopOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* sudah tertutup */
    }
  }
}

async function getTargetTab() {
  const allTabs = await chrome.tabs.query({});
  // Prioritas 1: tab Spotify yang sedang memutar musik atau terbuka
  const spotify = allTabs.find((t) => t.url && t.url.includes('spotify.com'));
  if (spotify) return spotify;

  // Prioritas 2: tab aktif di jendela yang sedang difokuskan
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTabs && activeTabs.length > 0 && activeTabs[0].id) {
    return activeTabs[0];
  }

  // Prioritas 3: tab aktif apapun
  const anyActive = allTabs.find((t) => t.active);
  if (anyActive) return anyActive;

  return null;
}

async function setBadge(enabled) {
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1db954' }); // Spotify green
  }
}

async function startCapture() {
  const tab = await getTargetTab();
  if (!tab || !tab.id) {
    return { ok: false, error: 'Buka dulu tab Spotify (open.spotify.com) atau tab musik aktif, lalu klik ON.' };
  }

  await ensureOffscreen();

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    return { ok: false, error: 'Gagal mengambil alih audio tab: ' + err.message };
  }

  const settings = await chrome.storage.local.get(['strength', 'mode']);
  const strVal = typeof settings.strength === 'number' ? settings.strength : 1.0;
  const modeVal = settings.mode || 'spectral';

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    tabId: tab.id,
    strength: strVal,
    mode: modeVal,
  });

  await chrome.storage.session.set({ capturing: true, capturedTabId: tab.id });
  await setBadge(true);
  return { ok: true, tabId: tab.id };
}

async function stopCapture() {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' });
  } catch {
    /* offscreen mungkin sudah mati */
  }
  await stopOffscreen();
  await chrome.storage.session.set({ capturing: false, capturedTabId: null, lastPitch: null });
  await setBadge(false);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return;

  if (msg.type === 'SET_ENABLED') {
    (async () => {
      await chrome.storage.local.set({ enabled: !!msg.enabled });
      const result = msg.enabled ? await startCapture() : await stopCapture();
      sendResponse(result);
    })();
    return true; // asynchronous response
  }

  if (msg.type === 'SET_STRENGTH') {
    (async () => {
      await chrome.storage.local.set({ strength: msg.strength });
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'SET_STRENGTH',
        strength: msg.strength,
      }).catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'SET_MODE') {
    (async () => {
      await chrome.storage.local.set({ mode: msg.mode });
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'SET_MODE',
        mode: msg.mode,
      }).catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'GET_STATE') {
    (async () => {
      const local = await chrome.storage.local.get(['enabled', 'strength', 'mode']);
      const session = await chrome.storage.session.get(['capturing', 'lastPitch']);
      sendResponse({
        enabled: local.enabled === true,
        strength: typeof local.strength === 'number' ? local.strength : 1.0,
        mode: local.mode || 'spectral',
        capturing: session.capturing === true,
        lastPitch: session.lastPitch || null,
      });
    })();
    return true;
  }

  if (msg.type === 'PITCH_UPDATE') {
    chrome.storage.session.set({ lastPitch: msg.pitch });
  }
});
