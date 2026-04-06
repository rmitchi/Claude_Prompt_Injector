// ═══════════════════════════════════════════════════════════════
// BACKGROUND.JS — Claude Prompt Runner v4.1
// Service worker: polls for session limit reset at configurable interval
// ═══════════════════════════════════════════════════════════════

const POLL_ALARM = 'cpr-limit-poll';

async function getPollMs() {
  const { pollIntervalMin } = await chrome.storage.local.get(['pollIntervalMin']);
  return (pollIntervalMin || 30) * 60 * 1000;
}

// ── Alarm listener ──
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM) return;

  console.log('[CPR-BG] Poll alarm fired — checking session limit');

  const { runState } = await chrome.storage.local.get(['runState']);
  if (!runState || runState.status !== 'paused_limit') {
    console.log('[CPR-BG] No paused_limit run — clearing alarm');
    chrome.alarms.clear(POLL_ALARM);
    return;
  }

  // Find a claude.ai tab
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (!tabs.length) {
    console.log('[CPR-BG] No claude.ai tab found — stopping');
    chrome.alarms.clear(POLL_ALARM);
    await chrome.storage.local.set({ limitResumeAt: null });
    runState.status  = 'paused_no_tab';
    runState.running = false;
    await chrome.storage.local.set({ runState });
    try { chrome.runtime.sendMessage({ action: 'NO_TAB_FOR_POLL' }).catch(() => {}); } catch (_) {}
    return;
  }

  const tab = tabs[0];

  // Inject content script (no-op if already loaded)
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (_) {}
  await new Promise(r => setTimeout(r, 400));

  // Ask content script if limit is still active
  let limitDetected = true; // assume still limited on comm failure
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { action: 'CHECK_LIMIT' });
    limitDetected = resp?.limitDetected ?? true;
  } catch (e) {
    console.log('[CPR-BG] Could not reach content script:', e.message);
  }

  if (!limitDetected) {
    // ── Limit cleared — resume ──
    console.log('[CPR-BG] Limit cleared — resuming');
    await chrome.storage.local.set({ limitResumeAt: null });

    await chrome.tabs.update(tab.id, { url: 'https://claude.ai/new', active: true });
    await new Promise(r => setTimeout(r, 3000));

    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));

    runState.status  = 'running';
    runState.running = true;
    await chrome.storage.local.set({ runState });

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'RESUME_RUN', data: runState });
      console.log('[CPR-BG] Resume sent to content script');
    } catch (e) {
      console.log('[CPR-BG] Failed to send resume:', e.message);
    }
    try { chrome.runtime.sendMessage({ action: 'LIMIT_CLEARED_RESUMING' }).catch(() => {}); } catch (_) {}

  } else {
    // ── Still limited — schedule next poll ──
    console.log('[CPR-BG] Still limited — scheduling next poll');
    const pollMs = await getPollMs();
    const nextAt = Date.now() + pollMs;
    chrome.alarms.create(POLL_ALARM, { when: nextAt });
    await chrome.storage.local.set({ limitResumeAt: nextAt });
    try { chrome.runtime.sendMessage({ action: 'POLL_STILL_LIMITED', nextAt }).catch(() => {}); } catch (_) {}
  }
});

// ── Messages from popup/content ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'SET_LIMIT_ALARM') {
    (async () => {
      const pollMs = await getPollMs();
      const nextAt = Date.now() + pollMs;
      chrome.alarms.create(POLL_ALARM, { when: nextAt });
      chrome.storage.local.set({ limitResumeAt: nextAt });
      console.log('[CPR-BG] Poll alarm set for', new Date(nextAt).toLocaleTimeString());
      sendResponse({ resumeAt: nextAt });
    })();
    return true;
  }

  if (msg.action === 'CLEAR_LIMIT_ALARM') {
    chrome.alarms.clear(POLL_ALARM);
    chrome.storage.local.set({ limitResumeAt: null });
    console.log('[CPR-BG] Poll alarm cleared');
    sendResponse({ ok: true });
    return true;
  }

  return true;
});
