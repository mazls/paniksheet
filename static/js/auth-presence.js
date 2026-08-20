/* =========================================================================
   auth-presence.js - Auth, Login-Modal, Presence + generische Modals
   =========================================================================
   - window.showModal(message, isConfirm?)   → Promise<true|false>
   - window.showPrompt(message, defaultValue?) → Promise<string|null>
   - showLoginModal()                         → Promise<void>
   - setupAuthUI()                            → Login-State + Online-Counter

   Wird in main.js während DOMContentLoaded aufgerufen.
   ========================================================================= */

import {
    db, auth, rtdb,
    DATA_COLLECTION, HISTORY_COLLECTION, USER_PROFILES_COLLECTION,
    LOOT_COLLECTION,
    rosterDocRef, historyCollectionRef, userProfilesCollectionRef,
    lootCollectionRef, denylistCollectionRef, aliasDocRef,
    doc, setDoc, onSnapshot, collection, deleteDoc, getDoc,
    serverTimestamp, query, orderBy, addDoc, updateDoc, where,
    getDocs, limit,
    onAuthStateChanged, signInWithEmailAndPassword, signOut, signInAnonymously,
    rtdbRef, rtdbSet, rtdbOnValue, rtdbOnDisconnect, rtdbOff, rtdbServerTimestamp
} from './firebase-init.js';

import { state, offensiveBuffsForAssignment, getCurrentRaidId, debounce, debouncedUpdatePools, debouncedUpdateSummary } from './state.js';


// =============================================================================
// MODAL-FUNKTION (window.showModal)
// =============================================================================

        // ============== MODAL-FUNKTION (global verfügbar) ==============
window.showModal = function(message, isConfirm = false) {
            
            // 1. AUFRÄUMEN: Nur dynamische Nachrichten-Fenster löschen!
            const allOverlays = document.querySelectorAll('.modal-overlay');
            allOverlays.forEach(el => {
                // Wir prüfen anhand der ID, ob es ein "wichtiges" statisches Fenster ist
                const isStatic = (el.id === 'player-edit-modal' || el.id === 'login-modal-overlay' || el.id === 'image-lightbox' || el.id === 'export-wa-modal');
                
                // Nur löschen, wenn es KEIN statisches Fenster ist
                if (!isStatic) {
                    el.remove(); 
                }
            });
        
            return new Promise((resolve) => {
                const modalOverlay = document.createElement('div');
                modalOverlay.className = 'modal-overlay'; 
                // WICHTIG: Keine ID vergeben, damit es als dynamisch erkannt wird
                
                modalOverlay.innerHTML = `
                    <div class="modal-content">
                        <h3>Nachricht</h3>
                        <p>${message}</p>
                        <div class="modal-buttons">
                            ${isConfirm ? `<button id="modal-cancel-btn" class="cancel-btn">Abbrechen</button>` : ''}
                            <button id="modal-ok-btn">OK</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modalOverlay);
        
                const okButton = modalOverlay.querySelector('#modal-ok-btn');
                const cancelButton = modalOverlay.querySelector('#modal-cancel-btn');
        
                const close = (value) => {
                    modalOverlay.remove(); 
                    resolve(value);
                };
        
                okButton.addEventListener('click', () => close(true));
                if (cancelButton) {
                    cancelButton.addEventListener('click', () => close(false));
                }
            });
        };
				

// =============================================================================
// PROMPT-FUNKTION (window.showPrompt) - Eingabe-Dialog
// =============================================================================

window.showPrompt = function(message, defaultValue = '') {
    return new Promise((resolve) => {
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'modal-overlay';
        
        modalOverlay.innerHTML = `
            <div class="modal-content">
                <h3>Eingabe</h3>
                <p>${message}</p>
                <input type="text" id="prompt-input" 
                       class="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white focus:border-gold outline-none mb-4"
                       value="${defaultValue.replace(/"/g, '&quot;')}">
                <div class="modal-buttons">
                    <button id="prompt-cancel-btn" class="cancel-btn">Abbrechen</button>
                    <button id="prompt-ok-btn">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);
        
        const input = modalOverlay.querySelector('#prompt-input');
        const okBtn = modalOverlay.querySelector('#prompt-ok-btn');
        const cancelBtn = modalOverlay.querySelector('#prompt-cancel-btn');
        
        input.focus();
        input.select();
        
        const close = (value) => {
            modalOverlay.remove();
            resolve(value);
        };
        
        okBtn.addEventListener('click', () => close(input.value.trim()));
        cancelBtn.addEventListener('click', () => close(null));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') close(input.value.trim());
            if (e.key === 'Escape') close(null);
        });
    });
};

// =============================================================================
// LOGIN-MODAL
// =============================================================================

				// ============== LOGIN MODAL FUNKTION ==============
		function showLoginModal() {
			return new Promise((resolve) => {
				const loginModalOverlay = document.getElementById('login-modal-overlay');
				const loginForm = document.getElementById('login-form');
				const loginUsernameInput = document.getElementById('login-username');
				const loginPasswordInput = document.getElementById('login-password');
				const loginCancelBtn = document.getElementById('login-modal-cancel-btn');
		
				loginUsernameInput.value = '';
				loginPasswordInput.value = '';
				loginModalOverlay.classList.remove('hidden');
				loginUsernameInput.focus();
		
				const handleSubmit = async (event) => {
					// Verhindert das Neuladen der Seite, was das Standardverhalten eines Formulars ist.
					event.preventDefault(); 
		
					const username = loginUsernameInput.value;
					const password = loginPasswordInput.value;
		
					if (!username || !password) {
						window.showModal("Bitte Benutzername und Passwort eingeben.");
						return;
					}
		
					try {
						// Die Logik zum Anmelden bei Firebase bleibt hier exakt gleich.
						const q = query(userProfilesCollectionRef, where("username", "==", username));
						const querySnapshot = await getDocs(q);
		
						if (querySnapshot.empty) {
							window.showModal("Benutzername nicht gefunden.");
							return;
						}
						const userProfile = querySnapshot.docs[0].data();
						const userCredential = await signInWithEmailAndPassword(auth, userProfile.email, password);
		
						if (userProfile.isManager) {
							sessionStorage.setItem('currentManager', username);
							location.reload();
						} else {
							await signOut(auth);
							window.showModal("Dieses Konto ist keinem Gildenrat-Status zugeordnet.");
						}
					} catch (error) {
						console.error("Login-Fehler:", error);
						window.showModal("Falscher Benutzername oder falsches Passwort.");
					}
				};
		
				const handleCancel = () => {
					cleanupAndResolve(false);
				};
		
				// Hilfsfunktion, um alle Event-Listener wieder zu entfernen und das Modal zu schließen
				const cleanupAndResolve = (value) => {
					loginForm.removeEventListener('submit', handleSubmit);
					loginCancelBtn.removeEventListener('click', handleCancel);
					loginModalOverlay.classList.add('hidden');
					resolve(value);
				}
		
				// Wir lauschen jetzt auf das 'submit'-Ereignis des Formulars
				loginForm.addEventListener('submit', handleSubmit);
				loginCancelBtn.addEventListener('click', handleCancel);
		
				loginModalOverlay.addEventListener('click', function clickOutside(event) {
					if (event.target === loginModalOverlay) {
						handleCancel();
					}
				});
			});
		}
        

window.showLoginModal = showLoginModal;

// =============================================================================
// AUTH-UI & PRESENCE-INDICATOR
// =============================================================================

        async function setupAuthUI() {
            const authSection = document.getElementById('auth-section');
            const currentManagerUsername = sessionStorage.getItem('currentManager');

            if (currentManagerUsername) {
                const q = query(userProfilesCollectionRef, where("username", "==", currentManagerUsername));
                const querySnapshot = await getDocs(q);

                if (!querySnapshot.empty) {
                    const userProfile = querySnapshot.docs[0].data();
                    if (userProfile.isManager) {
                        window.isManager = true;
                        authSection.innerHTML = `<span class="text-white">Angemeldet als: <strong>${currentManagerUsername}</strong></span><button id="logout-btn" class="ml-2 bg-red-600 hover:bg-red-700 text-white font-bold py-1 px-3 rounded-md text-sm">Logout</button>`;
                        document.getElementById('logout-btn').addEventListener('click', async () => {
                            await signOut(auth);
                            sessionStorage.removeItem('currentManager');
                            location.hash = '';
                            location.reload();
                        });
                        return;
                    }
                }
                sessionStorage.removeItem('currentManager');
            }

            window.isManager = false;
            authSection.innerHTML = `<button id="login-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-1 px-3 rounded-md text-sm">Gildenrat-Login</button>`;
            document.getElementById('login-btn').addEventListener('click', showLoginModal);
        }

        window.authPromise = new Promise((resolve) => {
            let initialAuthResolved = false;
            
            onAuthStateChanged(auth, user => {
                const presenceIndicator = document.getElementById('presence-indicator');
                if (window.heartbeatIntervalId) clearInterval(window.heartbeatIntervalId);

                if (!user) {
                    signInAnonymously(auth).then(() => {
                        // signInAnonymously will trigger onAuthStateChanged again
                    }).catch(e => console.error("Anonymer Login-Fehler:", e));
                    presenceIndicator.innerHTML = `<div class="w-3 h-3 bg-gray-500 rounded-full"></div><span>0</span> Online`;
                    return;
                }

                if (!initialAuthResolved) {
                    initialAuthResolved = true;
                    resolve(user);
                    // Initialisiere globale Listener, da wir jetzt authentifiziert sind
                    if (window.initGlobalListeners) {
                        window.initGlobalListeners();
                    }
                }

                // ══════════════════════════════════════════════════════════════
                // PRESENCE via Firebase Realtime Database (RTDB)
                // - Unterstützt mehrere Tabs/Sessions pro User!
                // ══════════════════════════════════════════════════════════════

                // Eindeutige ID für diesen Tab/Browser-Fenster generieren
                const sessionId = Math.random().toString(36).substring(2, 15);
                const userSessionRef = rtdbRef(rtdb, `presence/${user.uid}/${sessionId}`);

                // Daten, die wir bei "online" schreiben
                const onlineData = {
                    online: true,
                    last_changed: rtdbServerTimestamp()
                };

                // onDisconnect registrieren - löscht diese Session, wenn der Tab geschlossen wird
                rtdbOnDisconnect(userSessionRef).remove();

                // Sofort als online markieren
                rtdbSet(userSessionRef, onlineData);

                // Heartbeat: Timestamp alle 15 Min aktualisieren (in RTDB)
                window.heartbeatIntervalId = setInterval(() => {
                    rtdbSet(userSessionRef, onlineData);
                }, 15 * 60 * 1000);

                // ── RTDB-Listener für Online-Count ──────────────────────────
                // Liest den gesamten /presence-Knoten und zählt einzigartige User
                const allPresenceRef = rtdbRef(rtdb, 'presence');

                // Alten Listener entfernen (falls vorhanden, z.B. bei Re-Auth)
                if (window._rtdbPresenceListener) {
                    rtdbOff(allPresenceRef, 'value', window._rtdbPresenceListener);
                }

                window._rtdbPresenceListener = rtdbOnValue(allPresenceRef, (snapshot) => {
                    const data = snapshot.val();
                    if (!data) {
                        presenceIndicator.innerHTML = `<div class="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div><span>1</span> Online`;
                        return;
                    }

                    const nowMs = Date.now();
                    const twentyMinsMs = 20 * 60 * 1000;

                    let onlineCount = 0;
                    
                    // data ist ein Objekt mit UIDs als Keys: { "UID1": { "sessionA": {...}, "sessionB": {...} }, "UID2": {...} }
                    Object.values(data).forEach(userSessions => {
                        if (!userSessions) return;
                        
                        // Prüfen, ob der User mindestens eine aktive Session hat
                        let isUserOnline = false;
                        Object.values(userSessions).forEach(session => {
                            if (session && session.online && session.last_changed) {
                                if ((nowMs - session.last_changed) < twentyMinsMs) {
                                    isUserOnline = true;
                                }
                            }
                        });
                        
                        if (isUserOnline) {
                            onlineCount++;
                        }
                    });

                    presenceIndicator.innerHTML = `<div class="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div><span>${onlineCount}</span> Online`;
                });
            });
        });

window.setupAuthUI = setupAuthUI;