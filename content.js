// ═══════════════════════════════════════════════════════════════
// CONTENT.JS — Claude Prompt Runner v4.0
// Features: multi-prompt, session limit detection, download click,
//           persistent progress with resume
// ═══════════════════════════════════════════════════════════════

let isRunning  = false;
let shouldStop = false;
let sessionDownloadedHashes = new Set(); // Track downloads in current session only

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'START_RUN')  startRun(msg.data, 0, 0);
  if (msg.action === 'RESUME_RUN') resumeRun(msg.data);
  if (msg.action === 'STOP_RUN')   { shouldStop = true; isRunning = false; }
  if (msg.action === 'CLEAR_DOWNLOADS') clearDownloadTracking();
});

// ─────────────────────────────────────────────────────────────
// RESUME — picks up from saved position
// ─────────────────────────────────────────────────────────────

async function resumeRun(data) {
  const startCountry = data.currentIndex || 0;
  const startPrompt  = data.currentPromptIndex || 0;
  log(`Resuming from country ${startCountry}, prompt ${startPrompt}`);
  startRun(data, startCountry, startPrompt);
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD TRACKING CLEANUP
// ─────────────────────────────────────────────────────────────

function clearDownloadTracking() {
  // Clear only current session's tracking
  sessionDownloadedHashes.clear();
  log('Cleared session download tracking');
}

async function clearAllDownloadHistory() {
  return new Promise(resolve => {
    chrome.storage.local.set({ downloadedHashes: {} }, () => {
      sessionDownloadedHashes.clear();
      log('Cleared all download history');
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────

async function startRun({ countries, prompts, prompt, delay, timeout }, fromCountry, fromPrompt) {
  if (isRunning) return;
  isRunning  = true;
  shouldStop = false;

  // Initialize session download tracking
  sessionDownloadedHashes.clear();

  const promptList = prompts && prompts.length ? prompts : [prompt];

  for (let i = fromCountry; i < countries.length; i++) {
    if (shouldStop) break;

    // Check session limit BEFORE sending any prompt
    if (detectSessionLimit()) {
      log('Session limit detected before sending — pausing');
      await handleSessionLimit(i, 0, countries, promptList, delay, timeout);
      return;
    }

    const country = countries[i];
    const pStart  = (i === fromCountry) ? fromPrompt : 0;

    notify('COUNTRY_STARTED', { country, index: i });
    log(`▶ ${i+1}/${countries.length}: ${country} (${promptList.length} prompt${promptList.length > 1 ? 's' : ''})`);

    for (let p = pStart; p < promptList.length; p++) {
      if (shouldStop) break;

      // Check session limit before each prompt
      if (detectSessionLimit()) {
        log(`Session limit detected before prompt ${p+1} — pausing`);
        await handleSessionLimit(i, p, countries, promptList, delay, timeout);
        return;
      }

      const rawPrompt   = promptList[p];
      const finalPrompt = rawPrompt.replaceAll('{{VARIABLE}}', country);

      notify('PROMPT_STARTED', { country, index: i, promptIndex: p });
      log(`  prompt ${p+1}/${promptList.length}`);

      // Save progress
      await saveProgress(i, p, 'running', countries, promptList, delay, timeout);

      // 0. Mark all existing download buttons so we don't re-click them later
      markExistingDownloadButtons();

      // 1. Find editor
      const editor = await poll(() => findEditor(), 15000);
      if (!editor) return fail('Editor not found. Are you on a claude.ai page?');

      // 2. Inject prompt
      const injected = await inject(editor, finalPrompt);
      if (!injected) return fail(`Could not inject prompt ${p+1} into editor.`);

      // 3. Send
      notify('COUNTRY_WAITING', { country, index: i });
      const sent = await send(editor);
      if (!sent) return fail(`Could not send prompt ${p+1}.`);

      // 4. Wait for URL to settle (only first prompt on /new)
      if (i === fromCountry && p === pStart && location.pathname.includes('/new')) {
        await settleUrl();
      }

      // 5. Wait for full response, auto-clicking Continue
      const waitResult = await waitDone(timeout, country);

      // Check if limit was hit during generation
      if (waitResult === 'limit') {
        log(`Session limit hit during response — pausing after prompt ${p+1}`);
        // This prompt's response may be incomplete, retry it
        await handleSessionLimit(i, p, countries, promptList, delay, timeout);
        return;
      }

      log(`  ✓ prompt ${p+1} done`);

      // Save progress with NEXT prompt index so resume skips this completed prompt
      const nextP = p + 1;
      if (nextP < promptList.length) {
        await saveProgress(i, nextP, 'running', countries, promptList, delay, timeout);
      }

      // 6. Check for and click Download button
      await tryClickDownload();

      // Small delay between prompts within the same country
      if (p < promptList.length - 1 && !shouldStop) {
        await sleep(2000);
      }
    }

    // If stopped mid-country, save current position and DON'T mark country as done
    if (shouldStop) {
      log(`Stopped during: ${country}`);
      break;
    }

    // Save progress — country done
    await saveProgress(i + 1, 0, 'running', countries, promptList, delay, timeout);

    notify('COUNTRY_DONE', { country, index: i });
    log(`✓ Done: ${country}`);

    if (i < countries.length - 1 && !shouldStop) {
      log(`Waiting ${delay}s…`);
      await sleep(delay * 1000);
    }
  }

  if (!shouldStop) {
    await saveProgress(countries.length, 0, 'completed', countries, promptList, delay, timeout);
    notify('ALL_DONE', { total: countries.length });
  }
  isRunning = false;
}

function fail(msg) {
  log('ERROR: ' + msg);
  notify('RUN_ERROR', { error: msg });
  isRunning = false;
}

// ─────────────────────────────────────────────────────────────
// PROGRESS PERSISTENCE
// ─────────────────────────────────────────────────────────────

function saveProgress(countryIdx, promptIdx, status, countries, prompts, delay, timeout) {
  return new Promise(resolve => {
    const state = {
      running: status === 'running',
      status,
      countries,
      prompts,
      currentIndex: countryIdx,
      currentPromptIndex: promptIdx,
      promptCount: prompts.length,
      delay,
      timeout,
    };
    chrome.storage.local.set({ runState: state }, resolve);
  });
}

// ─────────────────────────────────────────────────────────────
// SESSION LIMIT DETECTION
// Looks for "used X% of your session limit" where X >= 90
// ─────────────────────────────────────────────────────────────

function detectSessionLimit() {
  // Check the alert band near chat input
  const alertBand = document.querySelector('[data-alert-band-wrapper]');
  if (alertBand) {
    const text = alertBand.textContent || '';
    const match = text.match(/used\s+(\d+)%\s+of\s+your\s+(?:session\s+)?limit/i);
    if (match) {
      const pct = parseInt(match[1]);
      if (pct >= 90) {
        log(`Session limit detected: ${pct}%`);
        return true;
      }
    }
  }

  // Also check for any visible limit-related banners across the page
  const allText = document.body.innerText || '';
  // "You've used 90% of your session limit" or "100%"
  const globalMatch = allText.match(/used\s+(\d+)%\s+of\s+your\s+(?:session\s+)?limit/i);
  if (globalMatch) {
    const pct = parseInt(globalMatch[1]);
    if (pct >= 90) {
      log(`Session limit detected (global scan): ${pct}%`);
      return true;
    }
  }

  return false;
}

async function handleSessionLimit(countryIdx, promptIdx, countries, prompts, delay, timeout) {
  shouldStop = true;
  isRunning  = false;

  // Save paused state
  await saveProgress(countryIdx, promptIdx, 'paused_limit', countries, prompts, delay, timeout);

  // Tell background to set 5hr alarm
  try {
    chrome.runtime.sendMessage({ action: 'SET_LIMIT_ALARM' }).catch(() => {});
  } catch (_) {}

  notify('SESSION_LIMIT_HIT', {
    countryIndex: countryIdx,
    promptIndex: promptIdx,
    country: countries[countryIdx],
  });

  log('Session limit — 5hr timer started. Will auto-resume.');
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD TRACKING — prevent duplicate downloads
// ─────────────────────────────────────────────────────────────

async function getDownloadedHashes() {
  return new Promise(resolve => {
    chrome.storage.local.get(['downloadedHashes'], (d) => {
      resolve(d.downloadedHashes || {});
    });
  });
}

async function saveDownloadHash(hash, metadata) {
  const hashes = await getDownloadedHashes();
  hashes[hash] = {
    timestamp: Date.now(),
    ...metadata
  };
  return new Promise(resolve => {
    chrome.storage.local.set({ downloadedHashes: hashes }, resolve);
  });
}

function generateContentHash(text) {
  // Simple hash function - generate from response content
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return 'hash_' + Math.abs(hash).toString(36);
}

function getResponseContent() {
  // Extract the last visible AI response from the page
  const responses = [...document.querySelectorAll('.font-claude-response')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  if (!responses.length) return null;

  const lastResponse = responses[responses.length - 1];
  return lastResponse.textContent || null;
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD BUTTON — click if present after response
// Scoped to LAST response only + marks clicked buttons
// ─────────────────────────────────────────────────────────────

function markExistingDownloadButtons() {
  // Mark all currently visible download buttons so they are excluded
  // when we later search for NEW download buttons after the next response
  const existing = document.querySelectorAll('button[aria-label="Download"]:not([data-cpr-downloaded])');
  let count = 0;
  for (const btn of existing) {
    if (isVisible(btn)) {
      btn.setAttribute('data-cpr-downloaded', 'true');
      count++;
    }
  }
  if (count > 0) log(`Marked ${count} pre-existing download button(s)`);
}

function getLastResponseContainer() {
  // Find all visible AI response elements
  const responses = [...document.querySelectorAll('.font-claude-response')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!responses.length) return null;

  const lastResponse = responses[responses.length - 1];

  // Walk up to find the response's top-level message container
  // Look for the nearest data-test-render-count ancestor or the
  // parent group that wraps the entire message turn
  let container = lastResponse;
  for (let el = lastResponse; el && el !== document.body; el = el.parentElement) {
    if (el.hasAttribute('data-test-render-count')) { container = el; break; }
    // Also check for the group wrapper that holds the full response turn
    if (el.classList.contains('group') && el.querySelector('.font-claude-response')) {
      container = el;
    }
  }
  return container;
}

function getDownloadButtonsInContainer(container) {
  if (!container) return [];
  return [...container.querySelectorAll('button[aria-label="Download"]')]
    .filter(b => isVisible(b) && !b.disabled && !b.hasAttribute('data-cpr-downloaded'));
}

async function tryClickDownload() {
  // Get the current response content and hash it
  const responseContent = getResponseContent();
  if (!responseContent) {
    log('No response content found — skipping download');
    return;
  }

  const contentHash = generateContentHash(responseContent);

  // Check if this content was already downloaded in current session
  if (sessionDownloadedHashes.has(contentHash)) {
    log(`Response already downloaded in this session (hash: ${contentHash}) — skipping`);
    return;
  }

  // Also check persistent history for duplicates across sessions
  const downloadedHashes = await getDownloadedHashes();
  if (downloadedHashes[contentHash]) {
    log(`Response matches previously downloaded content (hash: ${contentHash}) — skipping`);
    sessionDownloadedHashes.add(contentHash);
    return;
  }

  // Find the last response container to scope our search
  const lastContainer = getLastResponseContainer();

  // Poll for download buttons scoped to the last response
  const dlBtns = await poll(() => {
    // Primary: search only within the last response container
    if (lastContainer) {
      const scoped = getDownloadButtonsInContainer(lastContainer);
      if (scoped.length) return scoped;
    }
    // Fallback: if no container found, search page but exclude already-clicked
    const all = [...document.querySelectorAll('button[aria-label="Download"]')]
      .filter(b => isVisible(b) && !b.disabled && !b.hasAttribute('data-cpr-downloaded'));
    if (all.length) return all;
    return null;
  }, 10000, 500);

  if (dlBtns && dlBtns.length > 0) {
    log(`Found ${dlBtns.length} download button(s) in latest response — clicking`);
    let clickedCount = 0;

    for (let i = 0; i < dlBtns.length; i++) {
      const btn = dlBtns[i];
      // Safety: skip if already marked (race condition guard)
      if (btn.hasAttribute('data-cpr-downloaded')) continue;

      log(`  [${i+1}/${dlBtns.length}] Clicking download button`);
      for (const t of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      // Mark button as clicked so it won't be clicked again
      btn.setAttribute('data-cpr-downloaded', 'true');
      clickedCount++;
      // Delay between clicks to allow download to initiate
      if (i < dlBtns.length - 1) {
        await sleep(1500);
      }
    }

    // Only mark as downloaded if we actually clicked buttons
    if (clickedCount > 0) {
      sessionDownloadedHashes.add(contentHash);
      await saveDownloadHash(contentHash, {
        clickedCount,
        buttonCount: dlBtns.length,
        downloadedAt: new Date().toISOString()
      });
      await sleep(1500);
      log(`Downloaded ${clickedCount}/${dlBtns.length} file(s) for response (hash: ${contentHash})`);
    }
  } else {
    log('No download button found in latest response — skipping');
  }
}

// ─────────────────────────────────────────────────────────────
// EDITOR
// ─────────────────────────────────────────────────────────────

function findEditor() {
  const byTestId = document.querySelector('[data-testid="chat-input"]');
  if (byTestId) {
    const r = byTestId.getBoundingClientRect();
    if (r.width > 0) return byTestId;
  }
  for (const sel of [
    'div.tiptap.ProseMirror[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][aria-label*="prompt"]',
    '[contenteditable="true"][aria-label*="Reply"]',
    '[contenteditable="true"]',
  ]) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 80 && r.height > 0) return el;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// INJECT
// ─────────────────────────────────────────────────────────────

async function inject(editor, text) {
  // Method A: clipboard write → paste
  try {
    window.focus();
    editor.click();
    editor.focus();
    await sleep(150);

    await navigator.clipboard.writeText(text);
    await sleep(100);

    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(50);
    document.execCommand('paste', false, null);
    await sleep(400);

    if (editor.textContent.trim().length > 0) {
      log('Inject: clipboard paste OK');
      return true;
    }
  } catch(e) { log('Inject clipboard failed: ' + e.message); }

  // Method B: execCommand insertText
  try {
    window.focus();
    editor.click();
    editor.focus();
    await sleep(150);

    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(50);
    document.execCommand('insertText', false, text);
    await sleep(300);

    if (editor.textContent.trim().length > 0) {
      log('Inject: execCommand OK');
      return true;
    }
  } catch(e) { log('Inject execCommand failed: ' + e.message); }

  return false;
}

// ─────────────────────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────────────────────

async function send(editor) {
  await sleep(300);

  const btn = await poll(() => findSendButton(), 6000);
  if (btn) {
    log('Send button found: ' + (btn.getAttribute('aria-label') || btn.className.slice(0,50)));
    for (const t of ['mousedown', 'mouseup', 'click']) {
      btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    await sleep(500);
    if (wasSent(editor)) { log('Sent via button'); return true; }
  }

  log('Trying Enter key fallback…');
  editor.focus();
  await sleep(100);

  const enter = new KeyboardEvent('keydown', {
    bubbles: true, cancelable: true,
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    shiftKey: false, ctrlKey: false, metaKey: false,
  });
  editor.dispatchEvent(enter);
  await sleep(600);

  if (wasSent(editor)) { log('Sent via Enter'); return true; }

  log('Trying positional button search…');
  const anyBtn = findButtonByPosition();
  if (anyBtn) {
    anyBtn.click();
    await sleep(500);
    if (wasSent(editor)) { log('Sent via positional button'); return true; }
  }

  log('All send strategies failed');
  return false;
}

function findSendButton() {
  for (const label of ['Send message', 'Send Message', 'Send']) {
    const b = document.querySelector(`button[aria-label="${label}"]`);
    if (b && !b.disabled && isVisible(b)) return b;
  }

  const fs = document.querySelector('fieldset');
  if (fs) {
    const submits = [...fs.querySelectorAll('button[type="submit"]')]
      .filter(b => !b.disabled && isVisible(b) && b.innerText.trim() === '' && b.querySelector('svg'));
    if (submits.length) return submits[submits.length - 1];
  }

  const inputBox = document.querySelector('[class*="rounded-[20px]"]') ||
                   document.querySelector('[class*="chat-input"]') ||
                   document.querySelector('fieldset');
  if (inputBox) {
    const btns = [...inputBox.querySelectorAll('button')]
      .filter(b => !b.disabled && isVisible(b) && b.querySelector('svg') && b.innerText.trim() === '');
    if (btns.length > 0) return btns[btns.length - 1];
  }

  return null;
}

function findButtonByPosition() {
  const allBtns = [...document.querySelectorAll('button')]
    .filter(b => isVisible(b) && !b.disabled);

  let best = null, bestScore = -1;
  for (const b of allBtns) {
    const r = b.getBoundingClientRect();
    const score = r.bottom + r.right;
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.offsetParent !== null;
}

function wasSent(editor) {
  return editor.textContent.trim().length === 0 || isGenerating();
}

// ─────────────────────────────────────────────────────────────
// WAIT FOR FULL RESPONSE — auto-clicks Continue
// Returns 'done' or 'limit'
// ─────────────────────────────────────────────────────────────

const CONTINUE_POLL_TOTAL_MS = 7000;
const CONTINUE_POLL_INTERVAL_MS = 250;

async function pollForContinueButton() {
  const end = Date.now() + CONTINUE_POLL_TOTAL_MS;
  while (Date.now() < end) {
    if (shouldStop) return { kind: 'stop' };
    if (isGenerating()) return { kind: 'resume' };
    const btn = findContinue();
    if (btn) return { kind: 'continue', btn };
    await sleep(CONTINUE_POLL_INTERVAL_MS);
  }
  if (isGenerating()) return { kind: 'resume' };
  return { kind: 'none' };
}

async function waitDone(timeoutSec, country) {
  const deadline = Date.now() + timeoutSec * 1000;

  const started = await poll(() => isGenerating() ? true : null, 30000);
  if (!started) { await sleep(2000); return 'done'; }

  while (Date.now() < deadline) {
    if (shouldStop) return 'done';

    // Check for session limit during generation
    if (detectSessionLimit()) return 'limit';

    if (isGenerating()) { await sleep(800); continue; }

    await sleep(400);

    // Re-check limit after generation stops
    if (detectSessionLimit()) return 'limit';

    const phase = await pollForContinueButton();
    if (phase.kind === 'stop') return 'done';
    if (phase.kind === 'resume') continue;
    if (phase.kind === 'continue') {
      log('Clicking Continue…');
      notify('COUNTRY_WAITING', { country: `${country} · continuing…`, index: -1 });
      for (const t of ['mousedown','mouseup','click']) {
        phase.btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      phase.btn.click?.();
      await sleep(2000);
      continue;
    }

    await sleep(1200);
    log('Response complete');
    return 'done';
  }
  log('Timeout');
  return 'done';
}

function isGenerating() {
  for (const l of ['Stop Response','Stop response','Stop generating','Stop']) {
    if (document.querySelector(`button[aria-label="${l}"]`)) return true;
  }
  for (const b of document.querySelectorAll('button')) {
    if ((b.getAttribute('aria-label') || '').toLowerCase().includes('stop') && isVisible(b)) return true;
  }
  for (const sel of ['[class*="streaming"]','[class*="generating"]','[data-testid="thinking-indicator"]']) {
    const el = document.querySelector(sel);
    if (el && el.getBoundingClientRect().height > 0) return true;
  }
  return false;
}

function looksLikeContinueLabel(s) {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  if (t.includes('discontinue')) return false;
  if (/\bcontinue\b/.test(t)) return true;
  return t === 'continue' || t.startsWith('continue ') || t.startsWith('continue,');
}

function continueSearchRoots() {
  const roots = [];
  const responses = [...document.querySelectorAll('.font-claude-response')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!responses.length) return roots;

  const last = responses[responses.length - 1];
  const parent = last.parentElement;
  if (parent) {
    const directWarn = parent.querySelector(':scope > [data-testid="message-warning"]');
    if (directWarn) roots.push(directWarn);
    const nestedWarn = parent.querySelector('[data-testid="message-warning"]');
    if (nestedWarn && nestedWarn !== directWarn) roots.push(nestedWarn);
  }

  roots.push(last);

  let sib = last.nextElementSibling;
  for (let i = 0; sib && i < 12; i++, sib = sib.nextElementSibling) {
    if (sib.matches?.('[data-test-render-count]')) break;
    if (sib.querySelector?.('[data-testid="user-message"]')) break;
    if (roots.includes(sib)) continue;
    roots.push(sib);
  }
  return roots;
}

function findContinueInRoot(root) {
  if (!root || !root.querySelectorAll) return null;

  for (const sel of ['button[data-testid="continue-button"]', 'button[data-testid="message-continue"]']) {
    for (const b of root.querySelectorAll(sel)) {
      if (b.disabled || !isVisible(b)) continue;
      return b;
    }
  }

  for (const el of root.querySelectorAll('[data-testid]')) {
    const id = (el.getAttribute('data-testid') || '').toLowerCase();
    if (!id.includes('continue')) continue;
    const b = el.closest('button') || (el.tagName === 'BUTTON' ? el : null);
    if (b && !b.disabled && isVisible(b)) return b;
  }

  for (const b of root.querySelectorAll('button')) {
    if (b.disabled || !isVisible(b)) continue;
    const lbl = b.getAttribute('aria-label') || '';
    if (looksLikeContinueLabel(lbl)) return b;
    const txt = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (looksLikeContinueLabel(txt)) return b;
  }
  return null;
}

function findContinueInMessageWarnings() {
  const banners = [...document.querySelectorAll('[data-testid="message-warning"]')].filter(isVisible);
  for (let i = banners.length - 1; i >= 0; i--) {
    const root = banners[i];
    for (const b of root.querySelectorAll('button')) {
      if (b.disabled || !isVisible(b)) continue;
      const txt = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (looksLikeContinueLabel(txt) || looksLikeContinueLabel(b.getAttribute('aria-label') || '')) return b;
    }
  }
  return null;
}

function findContinue() {
  for (const root of continueSearchRoots()) {
    const hit = findContinueInRoot(root);
    if (hit) return hit;
  }

  const warnBtn = findContinueInMessageWarnings();
  if (warnBtn) return warnBtn;

  for (const sel of ['button[data-testid="continue-button"]', 'button[data-testid="message-continue"]']) {
    for (const b of document.querySelectorAll(sel)) {
      if (b.disabled || !isVisible(b)) continue;
      return b;
    }
  }

  for (const el of document.querySelectorAll('[data-testid]')) {
    const id = (el.getAttribute('data-testid') || '').toLowerCase();
    if (!id.includes('continue')) continue;
    const b = el.closest('button') || (el.tagName === 'BUTTON' ? el : null);
    if (b && !b.disabled && isVisible(b)) return b;
  }

  for (const b of document.querySelectorAll('button')) {
    if (b.disabled || !isVisible(b)) continue;
    const lbl = b.getAttribute('aria-label') || '';
    if (looksLikeContinueLabel(lbl)) return b;
    const txt = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (looksLikeContinueLabel(txt)) return b;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// URL SETTLE
// ─────────────────────────────────────────────────────────────

async function settleUrl() {
  let last = location.href, stable = 0;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (location.href === last) {
      stable += 100;
      if (stable >= 1500) return;
    } else {
      log('URL → ' + location.href);
      last = location.href; stable = 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function poll(fn, timeoutMs, interval = 100) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      const r = fn();
      if (r) return resolve(r);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(check, interval);
    })();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log('[CPR]', msg); }

function notify(action, extra) {
  try { chrome.runtime.sendMessage({ action, ...extra }).catch(() => {}); } catch(_) {}
}

log('content script loaded — ' + location.href);
