/* =========================================================================
   main.js — Application Entry-Point
   =========================================================================
   - Importiert alle Module (firebase-init lädt zuerst, dann state, dann der Rest)
   - Theme-Application aus URL/Hash (RAID_THEME_CONFIG)
   - Navigation (updateBossNav, loadContent, renderCurrentState)
   - DOMContentLoaded-Hook: lädt Cooldowns + Roster, setzt Auth auf,
     verdrahtet Video- und Feet-Toggle, registriert hashchange-Listener
   - Lightbox-Logik
   - logHistory (window.logHistory) — wird von vielen Stellen genutzt
   - Seiten-Initialisierung (initializePage, initCompPage)
   ========================================================================= */


// ─── Modul-Imports ───────────────────────────────────────────────────────────
// Reihenfolge ist wichtig: firebase-init zuerst (initialisiert App/Auth),
// state als nächstes (definiert getCurrentRaidId etc.), dann die feature-Module.

import {
    db, auth,
    DATA_COLLECTION, HISTORY_COLLECTION, USER_PROFILES_COLLECTION,
    LOOT_COLLECTION, SNAPSHOTS_COLLECTION,
    rosterDocRef, historyCollectionRef, userProfilesCollectionRef,
    lootCollectionRef, denylistCollectionRef, aliasDocRef, snapshotsCollectionRef,
    doc, setDoc, onSnapshot, collection, deleteDoc, getDoc,
    serverTimestamp, query, orderBy, addDoc, updateDoc, where,
    getDocs, limit
} from './firebase-init.js';

import { state, getCurrentRaidId, debounce } from './state.js';

// Diese Module registrieren ihre Funktionen auf window.*.
// Wir importieren sie ohne explizit etwas zu benutzen — die Imports allein triggern
// die Side-Effects (Funktionen werden auf window gelegt).
import './auth-presence.js';
import './roster-comp.js';
import './planner-bosses.js';


// =============================================================================
// THEME-LOGIK (applyThemeFromContext + zugehörige DOMContentLoaded-Listener)
// =============================================================================

function applyThemeFromContext() {
    const raidId = getCurrentRaidId();
    if (window.applyThemeForRaid) {
        window.applyThemeForRaid(raidId);
    }
}
 
// ── Initial beim Page-Load (möglichst früh) ──
// Kein Warten auf DOMContentLoaded hier — wir setzen das Attribute
// direkt auf <html>, das funktioniert auch ohne body.
(function immediateThemeInit() {
    try {
        const raidId = getCurrentRaidId();
        // RAID_THEME_CONFIG ist evtl. noch nicht da, daher Inline-Mapping
        const isSoo = raidId === 'siegeoforgrimmar';
        if (isSoo) {
            document.documentElement.setAttribute('data-theme', 'soo');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    } catch (e) { /* Silent */ }
})();
 
// ── Bei hashchange neu anwenden ──
window.addEventListener('hashchange', applyThemeFromContext);
 
// ── Bei DOMContentLoaded voll-initialisieren (Banner etc.) ──
document.addEventListener('DOMContentLoaded', applyThemeFromContext);
 
// ── Mutation-Observer für dynamisch geladenes Banner ──
const bannerObserver = new MutationObserver(() => {
    if (document.getElementById('raid-main-banner')) {
        applyThemeFromContext();
    }
});
// Observer erst nach DOMContentLoaded starten
document.addEventListener('DOMContentLoaded', () => {
    if (document.body) {
        bannerObserver.observe(document.body, { childList: true, subtree: true });
    }
});

// =============================================================================
// NAVIGATION & CONTENT-LOADING
// (vorher: viel direkt im DOMContentLoaded — jetzt als Top-Level-Funktionen,
//  damit andere Module sie ggf. benutzen können)
// =============================================================================

        // ============== NAVIGATION & CONTENT LOADING ==============
        const contentContainer = document.getElementById('content-container');
        const bossNav = document.getElementById('boss-nav');
        const raidSelector = document.getElementById('raid-selector');

// Für andere Module verfügbar machen
window.contentContainer = contentContainer;
window.bossNav = bossNav;
window.raidSelector = raidSelector;


		function updateBossNav(raidId) {
            const mainNav = document.getElementById('main-nav');
            const bossNav = document.getElementById('boss-nav');
            const raid = window.raidData[raidId];

            // 1. Die Hauptnavigation - Padding (py-2 px-4) wieder hinzugefügt
const links = [
    `<a href="#comp" data-page-id="comp" class="nav-link">Übersicht & Comp</a>`,
    `<a href="#loot" data-page-id="loot" class="nav-link">Lootverlauf</a>`,
    `<a href="#discord" data-page-id="discord" class="nav-link">Discord</a>`
];

// ÄNDERUNG: Nur hinzufügen, wenn der Nutzer eingeloggt (Manager) ist
if (window.isManager) {
    links.push(`<a href="#history" data-page-id="history" class="nav-link">Änderungsverlauf</a>`);
}

// Den externen Link immer hinzufügen
links.push(`<a href="https://classic.warcraftlogs.com/guild/reports-list/695179" target="_blank" class="nav-link">Warcraft Logs</a>`);

const separatorHTML = `<span class="nav-separator">|</span>`;
const mainNavHTML = links.join(separatorHTML);

mainNav.innerHTML = mainNavHTML;
            // 2. Die Boss-Navigation - Padding (py-2 px-4) wieder hinzugefügt
            if (!raid || !raid.bosses) {
                bossNav.innerHTML = '';
                return;
            }
            
            const bossNavHTML = raid.bosses.map(boss => {
                const pageId = `${raidId}/${boss.id}`;
                // Hier wurde 'py-2 px-4' hinzugefügt
                return `<a href="#${pageId}" data-page-id="${pageId}" class="nav-link rounded-md py-2 px-4">${boss.name}</a>`;
            }).join('');

            bossNav.innerHTML = bossNavHTML;
        }
		async function loadContent(pageId, sectionId = null) {
			// Unsubscribe von allen alten Listenern
			if (window.currentRosterUnsubscribe) { window.currentRosterUnsubscribe(); window.currentRosterUnsubscribe = null; }
			if (window.historyUnsubscribe) { window.historyUnsubscribe(); window.historyUnsubscribe = null; }
			if (window.assignmentUnsubscribe) { window.assignmentUnsubscribe(); window.assignmentUnsubscribe = null; }
			if (window.lootDatesUnsubscribe) { window.lootDatesUnsubscribe(); window.lootDatesUnsubscribe = null; }
			if (window.selectedLootDateUnsubscribe) { window.selectedLootDateUnsubscribe(); window.selectedLootDateUnsubscribe = null; }
            const hash = window.location.hash.substring(1);
			const filePath = pageId.includes('/') ? `${pageId}.html` : `${pageId}.html`;
		
			try {
				const response = await fetch(filePath);
				if (!response.ok) throw new Error(`Seite ${filePath} nicht gefunden.`);
				const htmlText = await response.text();
		
				// 1. Zuerst den Container leeren.
				contentContainer.innerHTML = '';
		
				// 2. Den geladenen HTML-Text in ein temporäres Element umwandeln, 
				//    damit wir die Knoten (inkl. Skripte) durchsuchen können.
				const tempDiv = document.createElement('div');
				tempDiv.innerHTML = htmlText;
		
				// 3. Alle Skript-Tags aus dem geladenen Inhalt finden.
				const scripts = tempDiv.querySelectorAll('script');
				
				// 4. Den HTML-Inhalt OHNE die Skripte in den Container einfügen.
				//    Wir nehmen alle Kind-Elemente des tempDiv und fügen sie an.
				while (tempDiv.firstChild) {
					if (tempDiv.firstChild.tagName !== 'SCRIPT') {
						contentContainer.appendChild(tempDiv.firstChild);
					} else {
						// Skript-Knoten nur entfernen, nicht anhängen
						tempDiv.removeChild(tempDiv.firstChild);
					}
				}
				
				// 5. Jedes gefundene Skript manuell erstellen und hinzufügen,
				//    damit der Browser es ausführt.
				scripts.forEach(oldScript => {
					const newScript = document.createElement('script');
					// Kopiere den Inhalt des alten Skripts in das neue.
					newScript.textContent = oldScript.textContent;
					// Füge das neue, ausführbare Skript zum Container hinzu.
					contentContainer.appendChild(newScript);
				});
		
				// 6. Die seiten-spezifische Initialisierungsfunktion aufrufen.
				const actualPageIdForInit = pageId.includes('/') ? pageId.split('/')[1] : pageId;
				initializePage(actualPageIdForInit, sectionId);
		
			} catch (error) {
				console.error("Fehler beim Laden des Inhalts:", error);
				contentContainer.innerHTML = `<div class="text-center p-8 bg-slate-850 rounded-lg"><h2 class="text-2xl font-semibold text-yellow-400">Fehler beim Laden</h2><p class="mt-2 text-gray-400">${error.message}</p><p class="mt-1 text-xs text-gray-500">Datei: <code>${filePath}</code> — siehe Konsole für Details.</p></div>`;
			}
            if (pageId && pageId.includes('/')) {
                const parts = pageId.split('/');
                const bossSlug = parts[1]; // Nimmt "jinrokh" (ohne &assignments)
                
                const currentBossId = 'boss-' + bossSlug;
                console.log('[window.RosterPatches] Boss-Page geladen, ID:', currentBossId);

                // RUFE DIE NEUE FUNKTION AUF:
                window.setupBossListener(currentBossId);
                
                // Banner für Roster-Patches einfügen (oben in der Boss-Page)
                if (typeof window.injectRosterPatchBanner === 'function') {
                    window.injectRosterPatchBanner(currentBossId);
                } else {
                    console.error('[window.RosterPatches] window.injectRosterPatchBanner ist nicht verfügbar!');
                }
            }
		}


        function renderCurrentState() {
            const currentRaidId = raidSelector.value;
            updateBossNav(currentRaidId);

            // NEU: Hash-Parsing erweitert
            const fullHash = window.location.hash.substring(1) || 'comp';
            const hashParts = fullHash.split('&');
            const pageId = hashParts[0];
            const sectionId = hashParts.length > 1 ? hashParts[1] : null;

            if (pageId.includes('/')) {
                const raidOfPage = pageId.split('/')[0];
                if (window.raidData[raidOfPage] && raidSelector.value !== raidOfPage) {
                    raidSelector.value = raidOfPage;
                    updateBossNav(raidOfPage);
                }
            }
            
            // Die Sektions-ID wird jetzt an loadContent übergeben
            loadContent(pageId, sectionId);

            document.querySelectorAll('#main-nav .nav-link, #boss-nav .nav-link').forEach(link => {
                const linkPageId = link.dataset.pageId;
                // Prüft nur den ersten Teil des Hashes für den aktiven Tab
                link.classList.toggle('active-tab', linkPageId === pageId);
            });
        }


// =============================================================================
// DOMContentLoaded — Haupt-Init-Sequenz
// =============================================================================

        document.addEventListener('DOMContentLoaded', async () => {
            await window.fetchAllCooldowns(); 
            await window.fetchRoster();
            try {
                const rosterSnap = await getDoc(rosterDocRef);
                window.rosterData = rosterSnap.exists() ? rosterSnap.data().roster || [] : [];
            } catch(e) {
                console.error("Fehler beim Laden des Rosters:", e);
                window.rosterData = [];
            }
            await window.setupAuthUI(); // "await" stellt die richtige Reihenfolge sicher
            const videoBtn = document.getElementById('toggle-video-btn');
            const videoBtnIcon = videoBtn.querySelector('i');
            const backgroundVideo = document.getElementById('background-video');
            // XALATATH FEET TOGGLE
            const feetBtn = document.getElementById('toggle-feet-btn');
            const feetImg = document.getElementById('xalatath-feet');

            function updateFeetState() {
                const isManager = window.isManager;
                const feetState = localStorage.getItem('xalatathFeetState') || 'on';

                if (!window.isManager) {
                    feetImg.classList.add('hidden-feet');
                    feetBtn.style.display = 'none';
                    return;
                }

                feetBtn.style.display = 'flex';

                if (feetState === 'on') {
                    feetImg.classList.remove('hidden-feet');
                    feetBtn.textContent = '🦶';
                } else {
                    feetImg.classList.add('hidden-feet');
                    feetBtn.textContent = '🚫';
                }
            }

            feetBtn.addEventListener('click', () => {
                const current = localStorage.getItem('xalatathFeetState') || 'on';
                const newState = current === 'on' ? 'off' : 'on';
                localStorage.setItem('xalatathFeetState', newState);
                updateFeetState();
            });

            updateFeetState();
            function updateVideoState() {
                const videoState = localStorage.getItem('backgroundVideoState') || 'on'; // Standard ist 'on'

                if (videoState === 'on') {
                    backgroundVideo.style.display = 'block';
                    backgroundVideo.play().catch(e => console.log("Autoplay wurde vom Browser blockiert."));
                    videoBtnIcon.className = 'fas fa-video';
                } else {
                    backgroundVideo.pause();
                    backgroundVideo.style.display = 'none';
                    videoBtnIcon.className = 'fas fa-video-slash'; // Durchgestrichenes Icon
                }
            }
            videoBtn.addEventListener('click', () => {
                const currentState = localStorage.getItem('backgroundVideoState') || 'on';
                const newState = currentState === 'on' ? 'off' : 'on';
                localStorage.setItem('backgroundVideoState', newState);
                updateVideoState();
            });
            updateVideoState();
            // ── Theme-Konfiguration pro Raid ──
window.RAID_THEME_CONFIG = {
    "throneofthunder": {
        theme: "mop",   // Standard Jade/Gold
        banner: "static/8d4ce2f0-7e56-444d-a321-4e5c9a26ec20.jpg"
    },
    "siegeoforgrimmar": {
        theme: "soo",   // Blut/Bronze
        banner: "static/banner-soo.jpg"
    }
    // Weitere Raids hier ergänzen — die behalten das Standard-Theme
};
 
// Default-Banner für alle Raids ohne eigene Config
const DEFAULT_BANNER = "static/8d4ce2f0-7e56-444d-a321-4e5c9a26ec20.jpg";
 
window.applyThemeForRaid = function(raidId) {
    const cfg = window.RAID_THEME_CONFIG[raidId] || { theme: "mop", banner: DEFAULT_BANNER };
 
    // 1. CSS-Theme setzen
    if (cfg.theme === "mop") {
        document.documentElement.removeAttribute("data-theme");
    } else {
        document.documentElement.setAttribute("data-theme", cfg.theme);
    }
 
    // 2. Banner auf Comp-Seite wechseln
    const bannerImg = document.getElementById("raid-main-banner");
    if (bannerImg) {
        const newSrc = cfg.banner || DEFAULT_BANNER;
        // Fallback wenn Banner nicht existiert
        bannerImg.onerror = () => {
            console.warn("[Theme] Banner nicht gefunden, Fallback:", newSrc);
            bannerImg.src = DEFAULT_BANNER;
            bannerImg.onerror = null;
        };
        // Nur aktualisieren wenn sich die Quelle wirklich ändert
        if (!bannerImg.src.endsWith(newSrc) && !bannerImg.src.endsWith(newSrc.replace("static/", ""))) {
            bannerImg.src = newSrc;
        }
    }
 
    // 3. Hintergrundvideo steuern (CSS versteckt es, aber wir pausieren es auch)
    const video = document.getElementById("background-video");
    if (video) {
        if (cfg.theme === "soo") {
            video.pause();
        } else {
            const videoState = localStorage.getItem('backgroundVideoState') || 'on';
            if (videoState === 'on') {
                video.play().catch(() => {});
            }
        }
    }
};
            raidSelector.addEventListener('change', async (e) => {
                const newRaidId = e.target.value;
                
                // 1. Globale Variable und Storage aktualisieren
                window.currentRaidId = newRaidId;
                sessionStorage.setItem('lastSelectedRaid', newRaidId); // Nutze sessionStorage statt localStorage um Konflikte zu vermeiden

                console.log("Raid gewechselt auf:", newRaidId);
                updateBossNav(newRaidId);
                window.applyThemeForRaid(newRaidId); 
                // 2. Setup Grid neu initialisieren (Wichtig für Import!)
                // Wir prüfen, ob wir auf der Comp-Seite sind, und erzwingen ein Neuladen
                if (window.location.hash === '#comp' || window.location.hash === '') {
                    // Falls wir schon auf der Comp-Seite sind, müssen wir sie manuell neu laden,
                    // damit die Slots (Kästchen) neu generiert werden.
                    await loadContent('comp');
                } else {
                    // Falls wir woanders sind, wechseln wir zur Comp-Seite (das triggert loadContent automatisch)
                    window.location.hash = '#comp';
                }
            });
        
            window.addEventListener('hashchange', renderCurrentState);

            renderCurrentState();
        });

// =============================================================================
// LIGHTBOX (außerhalb DOMContentLoaded — globale Refs)
// =============================================================================

		const lightbox = document.getElementById('image-lightbox');
        const lightboxImage = document.getElementById('lightbox-image');
        const lightboxCloseBtn = document.getElementById('lightbox-close-btn');

        // Funktion zum Öffnen der Lightbox
        window.openLightbox = function(src) {
            if (lightbox && lightboxImage) {
                lightboxImage.src = src;
                lightbox.style.display = 'flex';
            }
        }

        // Funktion zum Schließen der Lightbox
        const closeLightbox = () => {
            if (lightbox) {
                lightbox.style.display = 'none';
            }
        }

        // Event-Listener zum Schließen
        lightboxCloseBtn?.addEventListener('click', closeLightbox);
        lightbox?.addEventListener('click', (event) => {
            // Schließt die Lightbox nur, wenn auf den dunklen Hintergrund geklickt wird,
            // nicht auf das Bild selbst.
            if (event.target === lightbox) {
                closeLightbox();
            }
        });

// =============================================================================
// LOGGING (window.logHistory)
// =============================================================================

        // ============== LOGGING-FUNKTION ==============
        window.logHistory = async function(boss, assignment, player, editor) {
             await addDoc(historyCollectionRef, {
                boss: boss,
                assignment: assignment,
                player: player,
                editor: editor,
                timestamp: serverTimestamp()
            });
        };

// =============================================================================
// SEITEN-INITIALISIERUNG (initializePage, initCompPage)
// =============================================================================

        // ============== SEITEN-INITIALISIERUNG ==============
		function initializePage(pageId, sectionId = null) {
			if (pageId === 'comp') {
				initCompPage();
			} else if (pageId === 'history') {
				window.initHistoryPage();
			} else if (pageId === 'loot') {
				window.initLootPage();
			} else if (pageId === 'impressum' || pageId === 'datenschutz') {
				// No JS needed
			} else {
				window.initBossPage(pageId, sectionId);
			}
		}

        // --- Logik für comp.html ---
        function initCompPage() {
            document.getElementById('import-btn')?.addEventListener('click', window.handleImportRoster);
            document.getElementById('add-player-btn')?.addEventListener('click', window.handleAddPlayer);
            document.getElementById('clear-roster-btn')?.addEventListener('click', window.handleClearRoster);
			document.getElementById('import-url-btn')?.addEventListener('click', window.handleImportFromUrl);
			if (window.loadSetupLabels) window.loadSetupLabels();
			const snapshotSection = document.getElementById('snapshot-section');
			if (window.isManager && snapshotSection) {
				snapshotSection.style.display = 'block'; // Snapshot-Bereich nur für Manager anzeigen
				document.getElementById('save-snapshot-btn')?.addEventListener('click', window.saveSnapshot);
				document.getElementById('load-snapshot-btn')?.addEventListener('click', window.loadSnapshot);
				document.getElementById('delete-snapshot-btn')?.addEventListener('click', window.deleteSnapshot);
				
				// Füllt die Snapshot-Liste beim Laden der Seite
				window.populateSnapshotSelector();
                
			}
            const aliasSection = document.getElementById('name-alias-section');
            if (window.isManager && aliasSection) {
                aliasSection.style.display = 'block'; // Sektion sichtbar machen
                document.getElementById('alias-form')?.addEventListener('submit', window.handleAddOrUpdateAlias);
        
                onSnapshot(aliasDocRef, (docSnap) => {
                    window.globalAliasMap = docSnap.exists() ? docSnap.data().aliases || {} : {};
                    window.loadAndDisplayAliasMap(window.globalAliasMap);
                });
            }
                if (window.isManager) {
        const editorSection = document.getElementById('cooldown-editor-section');
        if (editorSection) {
            editorSection.style.display = 'block';
            window.initCooldownEditor();
        }
        window.initSnapshotPlayerAdder();
    }
    
    // Roster-Patches Verwaltungs-UI initialisieren
    if (typeof window.initRosterPatchesCompUI === 'function') {
        const selectedRaid = document.getElementById('raid-selector')?.value;
        const bosses = (window.raidData[selectedRaid] && window.raidData[selectedRaid].bosses) || [];
        window.initRosterPatchesCompUI(bosses);
    }

    // 🎯 Spec-Slots: Toggle-Button + initiales Render
    // (Im Original waren button und container im HTML angelegt, aber nie verdrahtet — das holen wir hier nach.)
    const slotToggleBtn = document.getElementById('btn-slot-toggle');
    const slotContainer = document.getElementById('slot-mapping-container');
    if (slotToggleBtn && slotContainer && window.SlotSystem) {
        // SlotSystem-Daten laden (falls noch nicht geschehen)
        window.SlotSystem.init().catch(err => console.warn('[SlotSystem] init failed:', err));

        slotToggleBtn.addEventListener('click', async () => {
            const isHidden = slotContainer.style.display === 'none' || !slotContainer.style.display;
            if (isHidden) {
                slotContainer.style.display = 'block';
                slotToggleBtn.innerHTML = '▲ Ausblenden';
                // Vor jedem Anzeigen: Mapping aus Firestore frisch holen, dann rendern
                await window.SlotSystem.reload();
                window.SlotSystem.renderMappingUI(slotContainer);
            } else {
                slotContainer.style.display = 'none';
                slotToggleBtn.innerHTML = '▼ Anzeigen';
            }
        });
    }

window.currentRosterUnsubscribe = onSnapshot(rosterDocRef, (docSnap) => {
    const jsonInput = document.getElementById('json-input');
    const currentRosterData = docSnap.exists() ? docSnap.data().roster || [] : [];
    window.rosterData = currentRosterData;
    // Reihenfolge der Aufrufe:
    window.displayRoster(currentRosterData);
    window.initBuffAssignments(currentRosterData);
    window.initSoulstoneAssignments(currentRosterData);

    if (window.updateRaidBuffsDisplay) {
        window.updateRaidBuffsDisplay(currentRosterData);
    }
    
    if (jsonInput && jsonInput.value === '' && docSnap.data()?.rawJson) {
        jsonInput.value = docSnap.data().rawJson;
    }

});
        // Master-View initialisieren
        if (window.isManager) {
            window.initMasterView();
        }
        }

// Für andere Module verfügbar machen
window.lightbox = lightbox;
window.renderCurrentState = renderCurrentState;