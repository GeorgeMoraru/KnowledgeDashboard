/**
 * Knowledge Base Dashboard - Firebase & Google Authentication
 * Seamless Google Sign-In with ProjectsProxi dynamic configuration & local persistence
 */
(function() {
    'use strict';

    // Built-in Default Production Config (matching homelab ecosystem)
    const BUILTIN_CONFIG = {
        apiKey: "AIzaSy_PROJECTSPROXI_MANAGED_KEY",
        authDomain: "blanketdesign-6f376.firebaseapp.com",
        projectId: "blanketdesign-6f376",
        storageBucket: "blanketdesign-6f376.firebasestorage.app",
        messagingSenderId: "261589505266",
        appId: "1:261589505266:web:f7c64f79a3e34171686c6b",
        measurementId: "G-3BQN0NXE6K"
    };

    const getActiveConfig = () => {
        if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && !window.FIREBASE_CONFIG.apiKey.startsWith('__')) {
            return window.FIREBASE_CONFIG;
        }
        try {
            const cached = localStorage.getItem('kb_firebase_config');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.apiKey && !parsed.apiKey.startsWith('__')) {
                    return parsed;
                }
            }
        } catch (e) {}
        return BUILTIN_CONFIG;
    };

    // Dynamic sync from ProjectsProxi server
    if (typeof fetch !== 'undefined') {
        const proxyEndpoints = [
            './api/config/auth',
            './api/config/kb',
            'http://127.0.0.1:8765/api/config/kb',
            'https://themeanmachine.taild1868e.ts.net:10006/api/config/blanket'
        ];
        for (const ep of proxyEndpoints) {
            fetch(ep).then(r => r.ok ? r.json() : null).then(remoteConfig => {
                if (remoteConfig && remoteConfig.apiKey && !remoteConfig.apiKey.startsWith('__')) {
                    window.FIREBASE_CONFIG = remoteConfig;
                    try { localStorage.setItem('kb_firebase_config', JSON.stringify(remoteConfig)); } catch (e) {}
                    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
                        // Config updated
                    }
                }
            }).catch(() => {});
        }
    }

    let app = null;
    let auth = null;

    const initFirebase = () => {
        if (typeof firebase !== 'undefined') {
            try {
                const config = getActiveConfig();
                if (!firebase.apps.length) {
                    app = firebase.initializeApp(config);
                } else {
                    app = firebase.app();
                }
                auth = firebase.auth();
                auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(err => {
                    console.warn('[Firebase Auth] Persistence error:', err);
                });

                // Passive redirect result check
                auth.getRedirectResult().then(result => {
                    if (result && result.user) {
                        console.log('[Firebase Auth] Signed in via redirect:', result.user.displayName);
                        dispatchUserEvent(result.user);
                    }
                }).catch(err => {
                    console.warn('[Firebase Auth] Passive redirect check note:', err.code, err.message);
                });

                // State listener
                auth.onAuthStateChanged(user => {
                    dispatchUserEvent(user);
                });

                console.log('[Firebase] Initialized successfully with project:', config.projectId);
                return true;
            } catch (e) {
                console.error('[Firebase Init Error]:', e);
                return false;
            }
        } else {
            console.warn('[Firebase] window.firebase SDK not yet available.');
            return false;
        }
    };

    const dispatchUserEvent = (user) => {
        window.CURRENT_USER = user;
        const event = new CustomEvent('kb:auth_changed', { detail: { user } });
        window.dispatchEvent(event);
    };

    // Google Sign-In with popup + fallback to redirect
    const loginWithGoogle = async () => {
        if (!auth) initFirebase();
        if (!auth && typeof firebase === 'undefined') {
            let polls = 0;
            while (typeof firebase === 'undefined' && polls < 30) {
                await new Promise(r => setTimeout(r, 100));
                polls++;
            }
            initFirebase();
        }
        if (!auth) {
            alert('Firebase SDK is not available. Please check network connection.');
            return null;
        }

        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        try {
            const result = await auth.signInWithPopup(provider);
            dispatchUserEvent(result.user);
            return result.user;
        } catch (error) {
            console.warn('[Firebase Auth Popup Error]:', error);
            if (error.code === 'auth/popup-blocked' || error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
                try {
                    await auth.signInWithRedirect(provider);
                    return null;
                } catch (redErr) {
                    console.error('[Firebase Auth Redirect Error]:', redErr);
                    throw redErr;
                }
            } else if (error.code === 'auth/unauthorized-domain') {
                alert(`Firebase Auth Error: Domain "${window.location.hostname}" is not authorized in Firebase Console.\nPlease add it under Authentication -> Settings -> Authorized Domains.`);
            } else {
                alert(`Authentication error: ${error.message}`);
            }
            throw error;
        }
    };

    const logout = async () => {
        if (!auth) initFirebase();
        if (auth) {
            await auth.signOut();
            dispatchUserEvent(null);
        }
    };

    const getCurrentUser = () => {
        if (!auth) initFirebase();
        return auth ? auth.currentUser : null;
    };

    // Auto-init once DOM/scripts are loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initFirebase);
    } else {
        initFirebase();
    }

    // Export globally
    window.KBAuth = {
        loginWithGoogle,
        logout,
        getCurrentUser,
        initFirebase,
        getConfig: getActiveConfig
    };
})();
