/**
 * Optional Google Sign-In.
 *
 * The dashboard works fully without it — the local knowledge base server is the
 * writer and needs no browser identity. Sign-in only exists for deployments that
 * want a named user attached to activity.
 *
 * There is no bundled Firebase project and no key in this repo. The config is
 * fetched at runtime from the connected knowledge base (`GET /api/config/auth`),
 * so a public GitHub Pages copy of this dashboard ships no credentials.
 *
 * `window.KBAuth` is defined ONLY once a usable config has been loaded and the
 * Firebase SDK is up. Callers must feature-detect it and degrade gracefully:
 *
 *     if (!window.KBAuth) { showToast('Google Sign-In is not configured…'); }
 */
(function () {
  'use strict';

  const LS_CONFIG = 'kb_firebase_config';
  const SDK = [
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js'
  ];

  function isUsable(cfg) {
    return !!(cfg && typeof cfg.apiKey === 'string' && cfg.apiKey &&
      !cfg.apiKey.startsWith('__') && !/_MANAGED_KEY$/.test(cfg.apiKey) && cfg.authDomain);
  }

  function cachedConfig() {
    try {
      const raw = localStorage.getItem(LS_CONFIG);
      const parsed = raw ? JSON.parse(raw) : null;
      return isUsable(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function cacheConfig(cfg) {
    try { localStorage.setItem(LS_CONFIG, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
  }

  /** Asks the connected knowledge base for its auth config. Never throws. */
  async function remoteConfig() {
    try {
      const res = window.KBSource
        ? await window.KBSource.fetch('/api/config/auth')
        : await fetch('./api/config/auth');
      if (!res.ok) return null;
      const cfg = await res.json();
      return isUsable(cfg) ? cfg : null;
    } catch (e) {
      return null;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = false;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(el);
    });
  }

  async function loadSdk() {
    if (typeof firebase !== 'undefined' && firebase.auth) return true;
    for (const src of SDK) await loadScript(src);
    return typeof firebase !== 'undefined' && !!firebase.auth;
  }

  function dispatchUser(user) {
    window.CURRENT_USER = user || null;
    window.dispatchEvent(new CustomEvent('kb:auth_changed', { detail: { user: user || null } }));
  }

  /** Wires up KBAuth for a known-good config. Returns true on success. */
  async function activate(config) {
    if (!await loadSdk()) return false;

    let auth;
    try {
      if (!firebase.apps.length) firebase.initializeApp(config);
      auth = firebase.auth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    } catch (e) {
      console.warn('[KBAuth] Firebase init failed:', e && e.message);
      return false;
    }

    auth.getRedirectResult().catch(() => { /* no pending redirect */ });
    auth.onAuthStateChanged(dispatchUser);

    window.KBAuth = {
      getConfig: () => Object.assign({}, config),
      getCurrentUser: () => auth.currentUser,

      loginWithGoogle: async () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
          const result = await auth.signInWithPopup(provider);
          return result.user;
        } catch (error) {
          const code = error && error.code;
          if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
            await auth.signInWithRedirect(provider);
            return null;
          }
          if (code === 'auth/popup-closed-by-user') return null;
          throw error;
        }
      },

      logout: async () => {
        await auth.signOut();
        dispatchUser(null);
      }
    };

    window.dispatchEvent(new CustomEvent('kb:auth_available'));
    return true;
  }

  async function boot() {
    const cached = cachedConfig();
    if (cached) await activate(cached);

    const fresh = await remoteConfig();
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(cached)) {
      cacheConfig(fresh);
      if (!window.KBAuth) await activate(fresh);
    }
  }

  // Re-check whenever the dashboard points at a different knowledge base.
  window.addEventListener('kb:source_reconnect', () => {
    if (!window.KBAuth) boot();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
