// ═══════════════════════════════════════════════════════════════
// POPUP.JS — Claude Prompt Runner v4.0
// Features: multi-prompt, stop/resume/reset, session limit timer
// ═══════════════════════════════════════════════════════════════

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let timerInterval = null;

// ── Tabs ──
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Dynamic prompt fields ──
let currentPromptCount = 1;

function renderPromptFields(count, savedPrompts) {
  const container = $('#promptFields');
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const div = document.createElement('div');
    div.className = 'field';
    const required = i === 0;
    div.innerHTML = `
      <label>Prompt ${i + 1}${required ? ' (requires {{VARIABLE}})' : ' ({{VARIABLE}} optional)'}</label>
      <textarea class="prompt-input prompt-multi" id="promptInput_${i}" placeholder="${
        i === 0
          ? 'Paste your main prompt here...\n\nUse {{VARIABLE}} as the placeholder.'
          : `Follow-up prompt ${i + 1}...\n\n{{VARIABLE}} is optional here.`
      }"></textarea>
    `;
    container.appendChild(div);
    const ta = $(`#promptInput_${i}`);
    if (savedPrompts && savedPrompts[i]) ta.value = savedPrompts[i];
    ta.addEventListener('input', () => {
      clearTimeout(window._t);
      window._t = setTimeout(saveAllPrompts, 800);
    });
  }
  currentPromptCount = count;
  updateStats();
}

function collectPrompts() {
  const prompts = [];
  for (let i = 0; i < currentPromptCount; i++) {
    const el = $(`#promptInput_${i}`);
    prompts.push(el ? el.value.trim() : '');
  }
  return prompts;
}

function saveAllPrompts() {
  chrome.storage.local.set({ prompts: collectPrompts() });
  updateStats();
}

function updateStats() {
  const prompts = collectPrompts();
  const filled = prompts.filter(p => p.length > 0).length;
  const has = prompts[0]?.includes('{{VARIABLE}}');
  const totalChars = prompts.reduce((s, p) => s + p.length, 0);
  $('#promptStats').textContent = `${filled}/${currentPromptCount} prompts filled · ${totalChars.toLocaleString()} chars${
    has ? ' · placeholder ✓' : prompts[0]?.length ? ' · ⚠ prompt 1 missing {{VARIABLE}}' : ''
  }`;
}

// ── Load saved state ──
chrome.storage.local.get(['prompts', 'masterPrompt', 'delay', 'timeout', 'countries', 'runState', 'promptCount', 'limitResumeAt', 'pollIntervalMin', 'discordWebhook', 'stopOnNoDownload', 'discordAlertNoDownload', 'defaultPrompt'], d => {
  const count = d.promptCount || 1;
  $('#promptCountInput').value = count;

  let savedPrompts = d.prompts;
  if (!savedPrompts && d.masterPrompt) {
    savedPrompts = [d.masterPrompt];
  }

  renderPromptFields(count, savedPrompts || []);

  if (d.delay)           $('#delayInput').value        = d.delay;
  if (d.timeout)         $('#timeoutInput').value      = d.timeout;
  if (d.countries)       $('#countriesInput').value    = d.countries;
  if (d.pollIntervalMin)  $('#pollIntervalInput').value  = d.pollIntervalMin;
  if (d.discordWebhook)  $('#discordWebhookInput').value = d.discordWebhook;

  // Download behavior settings
  if (d.stopOnNoDownload)       $('#stopOnNoDownload').checked = true;
  if (d.discordAlertNoDownload) $('#discordAlertNoDownload').checked = true;
  if (d.defaultPrompt)          $('#defaultPromptInput').value = d.defaultPrompt;
  toggleDefaultPromptField();

  // Restore UI based on saved state
  if (d.runState) {
    const st = d.runState;
    if (st.status === 'running' && st.running) {
      restoreRunningUI(st);
    } else if (st.status === 'paused_limit') {
      restorePausedLimitUI(st, d.limitResumeAt);
    } else if (st.status === 'paused_no_tab') {
      restorePausedNoTabUI(st);
    } else if (st.status === 'paused') {
      restorePausedUI(st);
    } else if (st.status === 'completed') {
      // Completed — show start button
    }
  }
});

// ── Prompt count change ──
$('#promptCountInput').addEventListener('change', () => {
  const count = Math.max(1, Math.min(20, parseInt($('#promptCountInput').value) || 1));
  $('#promptCountInput').value = count;
  const current = collectPrompts();
  chrome.storage.local.set({ promptCount: count });
  renderPromptFields(count, current);
});

// ── Prompt panel buttons ──
$('#btnSavePrompt').addEventListener('click', () => {
  saveAllPrompts();
  flash();
});
$('#btnClearPrompt').addEventListener('click', () => {
  for (let i = 0; i < currentPromptCount; i++) {
    const el = $(`#promptInput_${i}`);
    if (el) el.value = '';
  }
  chrome.storage.local.set({ prompts: [] });
  updateStats();
});

// ── Settings ──
$('#btnSaveSettings').addEventListener('click', () => {
  const count = Math.max(1, Math.min(20, parseInt($('#promptCountInput').value) || 1));
  const stopChecked = $('#stopOnNoDownload').checked;
  chrome.storage.local.set({
    delay:          parseInt($('#delayInput').value)          || 5,
    timeout:        parseInt($('#timeoutInput').value)        || 600,
    pollIntervalMin: Math.max(5, Math.min(120, parseInt($('#pollIntervalInput').value) || 30)),
    promptCount:    count,
    stopOnNoDownload: stopChecked,
    discordAlertNoDownload: $('#discordAlertNoDownload').checked,
    defaultPrompt: stopChecked ? '' : $('#defaultPromptInput').value.trim(),
  }, () => {
    if (stopChecked) $('#defaultPromptInput').value = '';
    flash();
  });
  if (count !== currentPromptCount) {
    const current = collectPrompts();
    renderPromptFields(count, current);
  }
});

// ── Run / Stop / Resume / Reset / Try Now ──
$('#btnStart').addEventListener('click', startRun);
$('#btnStop').addEventListener('click', stopRun);
$('#btnResume').addEventListener('click', resumeRun);
$('#btnReset').addEventListener('click', resetRun);
$('#btnTryNow').addEventListener('click', resumeRun);

// ── Clear download history ──
if ($('#btnClearDownloads')) {
  $('#btnClearDownloads').addEventListener('click', clearDownloadHistory);
}

// ── Discord webhook ──
$('#btnSaveWebhook').addEventListener('click', () => {
  const url = $('#discordWebhookInput').value.trim();
  chrome.storage.local.set({ discordWebhook: url }, flash);
});

$('#btnTestWebhook').addEventListener('click', () => {
  const url = $('#discordWebhookInput').value.trim();
  if (!url) return setStatus('Enter a webhook URL first', 'error');
  chrome.runtime.sendMessage({ action: 'TEST_DISCORD', webhookUrl: url }, res => {
    if (res?.ok) setStatus('Test message sent to Discord', 'done');
    else         setStatus('Discord test failed — check the URL', 'error');
  });
});

// ── Download behavior settings ──
function toggleDefaultPromptField() {
  const stopChecked = $('#stopOnNoDownload').checked;
  $('#defaultPromptInput').disabled = stopChecked;
  $('#defaultPromptGroup').style.opacity = stopChecked ? '0.4' : '1';
}

$('#stopOnNoDownload').addEventListener('change', toggleDefaultPromptField);

function startRun() {
  const raw = $('#countriesInput').value.trim();
  if (!raw) return setStatus('Enter at least one region', 'error');

  chrome.storage.local.get(['prompts'], d => {
    const prompts = d.prompts || [];
    const filledPrompts = prompts.filter(p => p && p.trim().length > 0);

    if (!filledPrompts.length) return setStatus('No prompts saved', 'error');
    if (!filledPrompts[0].includes('{{VARIABLE}}')) return setStatus('Prompt 1 missing {{VARIABLE}}', 'error');

    const countries = raw.split('\n').map(c => c.trim()).filter(Boolean);
    chrome.storage.local.set({ countries: raw });

    const delay   = parseInt($('#delayInput').value)   || 5;
    const timeout = parseInt($('#timeoutInput').value) || 600;

    const state = {
      running: true,
      status: 'running',
      countries,
      currentIndex: 0,
      currentPromptIndex: 0,
      delay,
      timeout,
      prompts: filledPrompts,
      promptCount: filledPrompts.length,
    };
    chrome.storage.local.set({ runState: state }, async () => {
      showRunningUI(state);
      await sendMsg('START_RUN', state);
    });
  });
}

function stopRun() {
  // Send stop to content script FIRST so it saves progress before we read it
  sendMsg('STOP_RUN', {});

  // Small delay to let content script save its progress, then update status
  setTimeout(() => {
    chrome.storage.local.get(['runState'], d => {
      if (d.runState) {
        // Only update running/status — preserve currentIndex and currentPromptIndex
        // as saved by the content script
        d.runState.running = false;
        d.runState.status = 'paused';
        chrome.storage.local.set({ runState: d.runState });
        renderQueue(d.runState);
        renderProgress(d.runState);
        const ci = d.runState.currentIndex;
        const pi = d.runState.currentPromptIndex || 0;
        setStatus(`Paused at: ${d.runState.countries[ci] || '…'} — prompt ${pi + 1}`, 'paused');
      }
    });
  }, 500);

  chrome.runtime.sendMessage({ action: 'CLEAR_LIMIT_ALARM' }).catch(() => {});
  clearTimerInterval();
  showPausedUI();
}

function resumeRun() {
  chrome.storage.local.get(['runState'], async d => {
    if (!d.runState) return setStatus('No saved progress to resume', 'error');

    const state = d.runState;
    state.running = true;
    state.status = 'running';
    chrome.storage.local.set({ runState: state });

    // Clear limit alarm if any
    chrome.runtime.sendMessage({ action: 'CLEAR_LIMIT_ALARM' }).catch(() => {});
    clearTimerInterval();
    $('#limitBanner').style.display = 'none';

    showRunningUI(state);
    setStatus(`Resuming: ${state.countries[state.currentIndex]} — prompt ${(state.currentPromptIndex || 0) + 1}`, 'running');
    await sendMsg('RESUME_RUN', state);
  });
}

function resetRun() {
  chrome.storage.local.get(['runState'], d => {
    if (d.runState) {
      d.runState.running = false;
      d.runState.status = 'reset';
      d.runState.currentIndex = 0;
      d.runState.currentPromptIndex = 0;
      chrome.storage.local.set({ runState: d.runState });
    }
  });
  sendMsg('STOP_RUN', {});
  chrome.runtime.sendMessage({ action: 'CLEAR_LIMIT_ALARM' }).catch(() => {});
  clearTimerInterval();
  $('#limitBanner').style.display = 'none';
  resetUI();
  setStatus('Progress reset — ready to start fresh', 'idle');
}

function clearDownloadHistory() {
  if (confirm('Clear all download history? This will allow re-downloading previously downloaded responses.')) {
    chrome.storage.local.set({ downloadedHashes: {} }, () => {
      sendMsg('CLEAR_DOWNLOADS', {}).catch(() => {});
      setStatus('Download history cleared', 'idle');
      flash();
    });
  }
}

// ── UI state helpers ──
function showRunningUI(state) {
  $('#btnStart').style.display  = 'none';
  $('#btnResume').style.display = 'none';
  $('#btnStop').style.display   = 'inline-flex';
  $('#btnReset').style.display  = 'none';
  $('#countriesInput').disabled = true;
  $('#progressSection').style.display = 'flex';
  $('#limitBanner').style.display = 'none';
  renderQueue(state);
  renderProgress(state);
}

function showPausedUI() {
  $('#btnStart').style.display  = 'none';
  $('#btnResume').style.display = 'inline-flex';
  $('#btnStop').style.display   = 'none';
  $('#btnReset').style.display  = 'inline-flex';
  $('#countriesInput').disabled = false;
  $('#progressSection').style.display = 'flex';
}

function restoreRunningUI(state) {
  showRunningUI(state);
  setStatus(`Running: ${state.countries[state.currentIndex] || '…'}`, 'running');
}

function restorePausedUI(state) {
  showPausedUI();
  $('#progressSection').style.display = 'flex';
  renderQueue(state);
  renderProgress(state);
  setStatus(`Paused at: ${state.countries[state.currentIndex] || '…'} — prompt ${(state.currentPromptIndex || 0) + 1}`, 'paused');
}

function restorePausedNoTabUI(state) {
  showPausedUI();
  $('#progressSection').style.display = 'flex';
  renderQueue(state);
  renderProgress(state);
  setStatus('Claude tab was closed during limit wait — open claude.ai then Resume', 'error');
}

function restorePausedLimitUI(state, limitResumeAt) {
  showPausedUI();
  $('#progressSection').style.display = 'flex';
  renderQueue(state);
  renderProgress(state);

  if (limitResumeAt && limitResumeAt > Date.now()) {
    showLimitTimer(limitResumeAt);
    setStatus(`Session limit hit at: ${state.countries[state.currentIndex] || '…'}`, 'paused');
  } else {
    setStatus(`Session limit passed — click Resume`, 'paused');
  }
}

function resetUI() {
  $('#btnStart').style.display  = 'inline-flex';
  $('#btnResume').style.display = 'none';
  $('#btnStop').style.display   = 'none';
  $('#btnReset').style.display  = 'none';
  $('#countriesInput').disabled = false;
  $('#progressSection').style.display = 'none';
  $('#countryQueue').style.display    = 'none';
  $('#limitBanner').style.display     = 'none';
}

function renderQueue(state) {
  const q = $('#countryQueue');
  q.style.display = 'block';
  const pc = state.promptCount || 1;
  const isPaused = state.status === 'paused' || state.status === 'paused_limit';
  q.innerHTML = state.countries.map((c, i) => {
    let cls, detail = '';
    if (i < state.currentIndex) {
      cls = 'ci-done';
    } else if (i === state.currentIndex && (state.running || isPaused)) {
      cls = isPaused ? 'ci-paused' : 'ci-active';
      if (pc > 1) detail = ` <span style="opacity:0.6;font-size:10px;">(prompt ${(state.currentPromptIndex || 0) + 1}/${pc})</span>`;
    } else {
      cls = 'ci-pending';
    }
    return `<div class="country-item ${cls}"><span class="ci-dot"></span>${c}${detail}</div>`;
  }).join('');
}

function renderProgress(state) {
  const total = state.countries.length;
  const pc = state.promptCount || 1;
  const doneUnits = state.currentIndex * pc + (state.currentPromptIndex || 0);
  const totalUnits = total * pc;
  const pct = totalUnits ? Math.round(doneUnits / totalUnits * 100) : 0;
  $('#progressFill').style.width = pct + '%';
  if (pc > 1) {
    $('#progressText').textContent = `${state.currentIndex}/${total} countries · prompt ${(state.currentPromptIndex || 0) + 1}/${pc}`;
  } else {
    $('#progressText').textContent = `${state.currentIndex} / ${total}`;
  }
}

// ── Limit timer ──
function showLimitTimer(resumeAt) {
  $('#limitBanner').style.display = 'block';
  clearTimerInterval();
  updateTimerDisplay(resumeAt);
  timerInterval = setInterval(() => updateTimerDisplay(resumeAt), 1000);
}

function updateTimerDisplay(resumeAt) {
  const diff = resumeAt - Date.now();
  if (diff <= 0) {
    $('#limitTimer').textContent = 'Checking…';
    clearTimerInterval();
    return;
  }
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  $('#limitTimer').textContent = `${m}m ${String(s).padStart(2,'0')}s`;
}

function clearTimerInterval() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function setStatus(text, type = 'idle') {
  const el = $('#statusText');
  el.textContent = text;
  el.className   = `status-${type}`;
}

function flash() {
  const el = $('#savedFlash');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

// ── Message to content script ──
async function sendMsg(action, data) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes('claude.ai')) {
    setStatus('Open claude.ai first', 'error');
    resetUI();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action, data });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 200));
      await chrome.tabs.sendMessage(tab.id, { action, data });
    } catch(e) {
      setStatus('Reload the Claude page and try again', 'error');
      resetUI();
    }
  }
}

// ── Messages from content script ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'COUNTRY_STARTED') {
    chrome.storage.local.get(['runState'], d => {
      if (!d.runState) return;
      d.runState.currentIndex = msg.index;
      d.runState.currentPromptIndex = 0;
      chrome.storage.local.set({ runState: d.runState });
      renderQueue(d.runState);
      renderProgress(d.runState);
      setStatus(`Sending: ${msg.country}`, 'running');
    });
  }
  if (msg.action === 'PROMPT_STARTED') {
    chrome.storage.local.get(['runState'], d => {
      if (!d.runState) return;
      d.runState.currentPromptIndex = msg.promptIndex;
      chrome.storage.local.set({ runState: d.runState });
      renderQueue(d.runState);
      renderProgress(d.runState);
      setStatus(`${msg.country} — prompt ${msg.promptIndex + 1}/${d.runState.promptCount}`, 'running');
    });
  }
  if (msg.action === 'COUNTRY_WAITING') {
    setStatus(`Waiting: ${msg.country}`, 'running');
  }
  if (msg.action === 'COUNTRY_DONE') {
    chrome.storage.local.get(['runState'], d => {
      if (!d.runState) return;
      d.runState.currentIndex = msg.index + 1;
      d.runState.currentPromptIndex = 0;
      chrome.storage.local.set({ runState: d.runState });
      renderQueue(d.runState);
      renderProgress(d.runState);
      setStatus(`✓ ${msg.country} — waiting ${d.runState.delay}s…`, 'done');
    });
  }
  if (msg.action === 'ALL_DONE') {
    chrome.storage.local.get(['runState'], d => {
      if (!d.runState) return;
      d.runState.running      = false;
      d.runState.status       = 'completed';
      d.runState.currentIndex = d.runState.countries.length;
      d.runState.currentPromptIndex = 0;
      chrome.storage.local.set({ runState: d.runState });
      renderQueue(d.runState);
      renderProgress(d.runState);
    });
    setStatus(`✅ All ${msg.total} done!`, 'done');
    resetUI();
    $('#btnStart').style.display = 'inline-flex';
  }
  if (msg.action === 'RUN_ERROR') {
    setStatus(`Error: ${msg.error}`, 'error');
    // On error, show resume + reset so user can retry
    showPausedUI();
  }
  if (msg.action === 'SESSION_LIMIT_HIT') {
    chrome.storage.local.get(['runState', 'limitResumeAt'], d => {
      if (d.runState) {
        renderQueue(d.runState);
        renderProgress(d.runState);
      }
      if (d.limitResumeAt) {
        showLimitTimer(d.limitResumeAt);
      }
    });
    showPausedUI();
    setStatus(`Session limit hit at: ${msg.country} — polling every 30 min`, 'paused');
  }

  if (msg.action === 'NO_TAB_FOR_POLL') {
    clearTimerInterval();
    $('#limitBanner').style.display = 'none';
    showPausedUI();
    setStatus('Claude tab was closed during limit wait — open claude.ai then Resume', 'error');
  }

  if (msg.action === 'POLL_STILL_LIMITED') {
    // Update timer to next poll time
    if (msg.nextAt) showLimitTimer(msg.nextAt);
    chrome.storage.local.get(['runState'], d => {
      const country = d.runState?.countries?.[d.runState?.currentIndex] || '…';
      setStatus(`Still limited at: ${country} — next check scheduled`, 'paused');
    });
  }

  if (msg.action === 'LIMIT_CLEARED_RESUMING') {
    clearTimerInterval();
    $('#limitBanner').style.display = 'none';
    setStatus('Limit cleared — resuming…', 'running');
  }
});
