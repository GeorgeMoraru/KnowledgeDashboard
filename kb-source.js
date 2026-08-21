/**
 * Knowledge Base source layer.
 *
 * The dashboard is a static app with no server of its own. Every knowledge base it
 * can show lives behind some HTTP origin — a `kb_server.py` reachable over
 * Tailscale, a plain static `kb.json`, or the same origin during local dev.
 *
 * This module owns that connection: where the KB is, how to reach it, what to do
 * when it is unreachable, and the dialog for changing it.
 *
 * Resolution order for the base URL:
 *   1. `?kb=<url>` in the query string (shareable deep link, persisted on use)
 *   2. `localStorage['kb_base_url']`
 *   3. same origin — used when this page is served by the KB server itself
 *
 * Payload resolution, in order: `<base>/api/notes` (live, writable) then
 * `<base>/kb.json` (static snapshot, read-only). The last good payload is cached in
 * IndexedDB, so the dashboard still opens offline.
 *
 * Exposes `window.KBSource`.
 */
(function () {
  'use strict';

  const LS_BASE_URL = 'kb_base_url';
  const LS_LAST_MODE = 'kb_last_mode';
  const DB_NAME = 'kb-dashboard';
  const DB_VERSION = 1;
  const STORE = 'payload';
  const PAYLOAD_KEY = 'kb-payload';

  const listeners = [];

  const state = {
    baseUrl: '',
    /** 'live' = writable API, 'snapshot' = static kb.json, 'cache' = IndexedDB, '' = none */
    mode: '',
    online: false,
    lastError: null,
    fetchedAt: null,
    kbName: ''
  };

  /* ---------------------------------------------------------------- utilities */

  function normalizeBase(raw) {
    let url = (raw || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url.replace(/\/+$/, '');
  }

  /** Turns './api/notes', '/api/notes' or 'api/notes' into an absolute URL. */
  function resolve(path) {
    const clean = String(path || '').replace(/^\.?\//, '');
    if (!state.baseUrl) return './' + clean;
    return state.baseUrl + '/' + clean;
  }

  function emit() {
    const snapshot = getStatus();
    listeners.forEach(fn => {
      try { fn(snapshot); } catch (e) { console.warn('[KBSource] listener error:', e); }
    });
    window.dispatchEvent(new CustomEvent('kb:source_changed', { detail: snapshot }));
  }

  function getStatus() {
    return {
      baseUrl: state.baseUrl,
      mode: state.mode,
      online: state.online,
      writable: state.mode === 'live',
      lastError: state.lastError,
      fetchedAt: state.fetchedAt,
      kbName: state.kbName,
      label: state.baseUrl ? state.baseUrl.replace(/^https?:\/\//, '') : 'this origin'
    };
  }

  /* ------------------------------------------------------------- IndexedDB */

  function openDb() {
    return new Promise((resolve_, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve_(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
  }

  async function cachePut(payload) {
    try {
      const db = await openDb();
      await new Promise((resolve_, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({
          baseUrl: state.baseUrl,
          mode: state.mode,
          fetchedAt: new Date().toISOString(),
          payload: payload
        }, PAYLOAD_KEY);
        tx.oncomplete = resolve_;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (e) {
      // A full or unavailable IndexedDB only costs us offline support.
      console.warn('[KBSource] could not cache payload:', e && e.message);
    }
  }

  async function cacheGet() {
    try {
      const db = await openDb();
      const record = await new Promise((resolve_, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(PAYLOAD_KEY);
        req.onsuccess = () => resolve_(req.result || null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return record;
    } catch (e) {
      return null;
    }
  }

  async function clearCache() {
    try {
      const db = await openDb();
      await new Promise((resolve_, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(PAYLOAD_KEY);
        tx.oncomplete = resolve_;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ fetch */

  function apiFetch(path, options) {
    const opts = Object.assign({ mode: 'cors', cache: 'no-store' }, options || {});
    return fetch(resolve(path), opts);
  }

  async function apiPost(path, body) {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function fetchJson(path, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 15000) : null;
    try {
      const res = await apiFetch(path, controller ? { signal: controller.signal } : {});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Probes a candidate base URL without changing the active connection.
   * Returns {ok, mode, kbName, capabilities, error}.
   */
  async function test(candidate) {
    const previous = state.baseUrl;
    state.baseUrl = normalizeBase(candidate);
    try {
      try {
        const health = await fetchJson('/api/health', 8000);
        return {
          ok: true,
          mode: 'live',
          kbName: health.kb_name || health.kbName || '',
          capabilities: health.capabilities || [],
          git: health.git || null
        };
      } catch (apiErr) {
        const snapshot = await fetchJson('/kb.json', 20000);
        return {
          ok: true,
          mode: 'snapshot',
          kbName: snapshot.kbName || '',
          capabilities: [],
          note: 'Static snapshot only — this knowledge base is read-only.'
        };
      }
    } catch (e) {
      return { ok: false, error: describeError(e, state.baseUrl) };
    } finally {
      state.baseUrl = previous;
    }
  }

  function describeError(e, baseUrl) {
    const name = e && e.name;
    if (name === 'AbortError') return 'Timed out waiting for a response.';
    if (e instanceof TypeError || name === 'TypeError') {
      return `Could not reach ${baseUrl || 'this origin'}. Check the URL, that the KB server is running, and that it allows cross-origin requests.`;
    }
    return (e && e.message) || 'Unknown error';
  }

  /**
   * Loads the knowledge payload. Falls back to the IndexedDB cache when the
   * source is unreachable. Returns {payload, mode, offline, error}.
   */
  async function loadPayload() {
    state.lastError = null;

    if (state.baseUrl || isSameOriginCandidate()) {
      try {
        const payload = await fetchJson('/api/notes', 30000);
        state.mode = 'live';
        state.online = true;
        state.kbName = payload.kbName || '';
        state.fetchedAt = new Date().toISOString();
        localStorage.setItem(LS_LAST_MODE, 'live');
        cachePut(payload);
        emit();
        return { payload: payload, mode: 'live', offline: false };
      } catch (apiErr) {
        try {
          const payload = await fetchJson('/kb.json', 30000);
          state.mode = 'snapshot';
          state.online = true;
          state.kbName = payload.kbName || '';
          state.fetchedAt = new Date().toISOString();
          localStorage.setItem(LS_LAST_MODE, 'snapshot');
          cachePut(payload);
          emit();
          return { payload: payload, mode: 'snapshot', offline: false };
        } catch (snapErr) {
          state.lastError = describeError(apiErr, state.baseUrl);
        }
      }
    } else {
      state.lastError = 'No knowledge base configured.';
    }

    const cached = await cacheGet();
    if (cached && cached.payload) {
      state.mode = 'cache';
      state.online = false;
      state.kbName = cached.payload.kbName || '';
      state.fetchedAt = cached.fetchedAt || null;
      emit();
      return { payload: cached.payload, mode: 'cache', offline: true, error: state.lastError };
    }

    state.mode = '';
    state.online = false;
    emit();
    return { payload: null, mode: '', offline: true, error: state.lastError };
  }

  /** True when this page is served from something that might also serve /api. */
  function isSameOriginCandidate() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  /* -------------------------------------------------------------- base URL */

  function getBaseUrl() {
    return state.baseUrl;
  }

  function setBaseUrl(raw, persist) {
    state.baseUrl = normalizeBase(raw);
    if (persist !== false) {
      try {
        if (state.baseUrl) localStorage.setItem(LS_BASE_URL, state.baseUrl);
        else localStorage.removeItem(LS_BASE_URL);
      } catch (e) { /* private browsing */ }
    }
    emit();
    return state.baseUrl;
  }

  function isConfigured() {
    return !!state.baseUrl || isSameOriginCandidate();
  }

  function shareUrl() {
    const url = new URL(location.href);
    if (state.baseUrl) url.searchParams.set('kb', state.baseUrl);
    else url.searchParams.delete('kb');
    return url.toString();
  }

  function init() {
    let initial = '';
    try {
      initial = new URLSearchParams(location.search).get('kb') || '';
    } catch (e) { /* ignore */ }
    if (initial) {
      setBaseUrl(initial, true);
    } else {
      try { state.baseUrl = normalizeBase(localStorage.getItem(LS_BASE_URL) || ''); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------------------------------------------------------- dialog */

  let dialogEl = null;

  function buildDialog() {
    if (dialogEl) return dialogEl;

    const overlay = document.createElement('div');
    overlay.className = 'kbsource-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Knowledge base connection');
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="kbsource-modal">',
      '  <header class="kbsource-head">',
      '    <h2>Knowledge base connection</h2>',
      '    <button type="button" class="kbsource-close" aria-label="Close">&times;</button>',
      '  </header>',
      '  <div class="kbsource-body">',
      '    <label class="kbsource-label" for="kbsource-url">Server URL</label>',
      '    <input id="kbsource-url" class="kbsource-input" type="url" spellcheck="false" autocomplete="off"',
      '           placeholder="https://my-host.ts.net">',
      '    <p class="kbsource-hint">',
      '      The address of your <code>kb_server.py</code> — typically a Tailscale hostname.',
      '      Leave empty to use whatever origin serves this page.',
      '    </p>',
      '    <div class="kbsource-result" hidden></div>',
      '    <div class="kbsource-meta"></div>',
      '  </div>',
      '  <footer class="kbsource-foot">',
      '    <button type="button" class="kbsource-btn kbsource-btn-ghost" data-action="test">Test</button>',
      '    <button type="button" class="kbsource-btn kbsource-btn-ghost" data-action="copy">Copy share link</button>',
      '    <span class="kbsource-spacer"></span>',
      '    <button type="button" class="kbsource-btn kbsource-btn-ghost" data-action="cancel">Cancel</button>',
      '    <button type="button" class="kbsource-btn kbsource-btn-primary" data-action="save">Connect</button>',
      '  </footer>',
      '</div>'
    ].join('\n');

    document.body.appendChild(overlay);
    dialogEl = overlay;

    const input = overlay.querySelector('#kbsource-url');
    const result = overlay.querySelector('.kbsource-result');
    const meta = overlay.querySelector('.kbsource-meta');

    function say(message, kind) {
      if (!result) return;
      result.hidden = false;
      result.className = 'kbsource-result kbsource-' + (kind || 'info');
      result.textContent = message;
    }

    function close() {
      overlay.hidden = true;
      document.body.classList.remove('kbsource-open');
    }

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    const closeBtn = overlay.querySelector('.kbsource-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') close();
      if (ev.key === 'Enter' && ev.target === input) {
        ev.preventDefault();
        overlay.querySelector('[data-action="save"]').click();
      }
    });

    overlay.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');

      if (action === 'cancel') {
        close();
        return;
      }

      if (action === 'copy') {
        const previous = state.baseUrl;
        state.baseUrl = normalizeBase(input.value);
        const link = shareUrl();
        state.baseUrl = previous;
        try {
          await navigator.clipboard.writeText(link);
          say('Share link copied to the clipboard.', 'ok');
        } catch (e) {
          say(link, 'info');
        }
        return;
      }

      if (action === 'test') {
        btn.disabled = true;
        say('Testing connection…', 'info');
        const res = await test(input.value);
        btn.disabled = false;
        if (res.ok) {
          say(res.mode === 'live'
            ? `Connected to "${res.kbName || 'knowledge base'}" — read/write.`
            : `Reached a static snapshot of "${res.kbName || 'knowledge base'}" — read-only.`, 'ok');
        } else {
          say(res.error, 'error');
        }
        return;
      }

      if (action === 'save') {
        btn.disabled = true;
        say('Connecting…', 'info');
        const res = await test(input.value);
        if (!res.ok) {
          btn.disabled = false;
          say(res.error + ' Save anyway to work from the offline cache.', 'error');
          btn.textContent = 'Save anyway';
          btn.setAttribute('data-action', 'force-save');
          return;
        }
        setBaseUrl(input.value, true);
        close();
        window.dispatchEvent(new CustomEvent('kb:source_reconnect'));
        btn.disabled = false;
        return;
      }

      if (action === 'force-save') {
        setBaseUrl(input.value, true);
        close();
        window.dispatchEvent(new CustomEvent('kb:source_reconnect'));
      }
    });

    overlay._refresh = function () {
      input.value = state.baseUrl;
      if (result) result.hidden = true;
      const save = overlay.querySelector('[data-action="save"], [data-action="force-save"]');
      if (save) {
        save.textContent = 'Connect';
        save.setAttribute('data-action', 'save');
        save.disabled = false;
      }
      if (meta) {
        const s = getStatus();
        const modeText = {
          live: 'Connected — read/write',
          snapshot: 'Static snapshot — read-only',
          cache: 'Offline — showing cached copy',
          '': 'Not connected'
        }[s.mode] || s.mode;
        meta.innerHTML = `<span class="kbsource-dot kbsource-dot-${s.mode || 'none'}"></span>` +
          `<span>${modeText}</span>` +
          (s.fetchedAt ? `<span class="kbsource-when">last loaded ${new Date(s.fetchedAt).toLocaleString()}</span>` : '');
      }
    };

    return overlay;
  }

  function openSettings() {
    const overlay = buildDialog();
    overlay.hidden = false;
    document.body.classList.add('kbsource-open');
    overlay._refresh();
    const input = overlay.querySelector('#kbsource-url');
    if (input) {
      input.focus();
      input.select();
    }
  }

  init();

  window.KBSource = {
    url: resolve,
    fetch: apiFetch,
    post: apiPost,
    loadPayload: loadPayload,
    test: test,
    getBaseUrl: getBaseUrl,
    setBaseUrl: setBaseUrl,
    isConfigured: isConfigured,
    getStatus: getStatus,
    shareUrl: shareUrl,
    openSettings: openSettings,
    clearCache: clearCache,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
})();
