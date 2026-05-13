/* =========================================================================
   state.js — Geteilter State & Utilities
   =========================================================================
   Enthält alle Variablen, die früher im großen Script-Scope lagen und von
   vielen Stellen geschrieben/gelesen werden. Plus debounce und getCurrentRaidId.

   WICHTIG: Diese Datei spiegelt alle Werte auf window.*, damit Legacy-Code,
   der direkt auf z.B. window.isManager zugreift, weiter funktioniert.

   EMPFEHLUNG für neue Features:
     import { state } from './state.js';
     state.isManager = true;   // -> window.isManager wird automatisch gesetzt
   ========================================================================= */


// =============================================================================
// SHARED STATE
// =============================================================================

const _state = {
    isManager: false,
    rosterData: [],
    allBossIds: [],
    currentRosterUnsubscribe: null,
    historyUnsubscribe: null,
    assignmentUnsubscribe: null,
    lootDatesUnsubscribe: null,
    selectedLootDateUnsubscribe: null,
    heartbeatIntervalId: null,
    allLootDocuments: [],
    playerSummaryState: {},
    summarySortState: { column: 'total', direction: 'desc' },
    globalAliasMap: {},
    assignmentsDocRef: null,
    _textSaveTimers: {},
};

// Anfangswerte direkt auf window spiegeln (für Legacy-Zugriffe)
for (const k of Object.keys(_state)) window[k] = _state[k];

// Proxy: jede Schreibung auf state.X wird auch nach window.X geschrieben.
export const state = new Proxy(_state, {
    set(target, prop, value) {
        target[prop] = value;
        window[prop] = value;
        return true;
    }
});


// =============================================================================
// OFFENSIVE-BUFFS-LOOKUP (statische Konfig)
// =============================================================================

export const offensiveBuffsForAssignment = {
    "5% Stärke, Beweglichkeit, Intelligenz": ["DRUID", "MONK", "PALADIN"],
    "10% Angriffskraft": ["DEATHKNIGHT", "HUNTER", "WARRIOR"],
    "10% Angriffsgeschwindigkeit": ["DEATHKNIGHT", "ROGUE", "SHAMAN"],
    "3000 Meisterschaft": ["PALADIN", "SHAMAN"],
    "5% Kritische Trefferchance": ["DRUID", "MAGE", "MONK"],
    "10% Zaubermacht": ["MAGE", "SHAMAN", "WARLOCK"],
    "5% Zaubertempo": ["DRUID", "PRIEST", "SHAMAN"],
    "10% Ausdauer": ["PRIEST", "WARLOCK", "WARRIOR"]
};
window.offensiveBuffsForAssignment = offensiveBuffsForAssignment;


// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Klassischer Debounce.
 * @param {Function} fn  Funktion, die verzögert ausgeführt werden soll
 * @param {number} ms    Verzögerung in Millisekunden
 */
export function debounce(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}
window.debounce = debounce;

/**
 * Debounced Wrapper. Wir können window.updateAssignmentPools hier nicht direkt importieren,
 * weil das in planner-bosses.js liegt. Stattdessen rufen wir es zur Laufzeit über window auf.
 */
export const debouncedUpdatePools = debounce(() => {
    if (typeof window.updateAssignmentPools === 'function') {
        window.updateAssignmentPools();
    }
}, 300);
window.debouncedUpdatePools = debouncedUpdatePools;

export const debouncedUpdateSummary = debounce(() => {
    if (window.updatePlannerSummary) window.updatePlannerSummary();
}, 500);
window.debouncedUpdateSummary = debouncedUpdateSummary;


/**
 * Liest die aktuelle Raid-ID aus URL-Hash, sessionStorage, raid-selector oder default.
 * Format: "#siegeoforgrimmar/immerseus" → "siegeoforgrimmar"
 *
 * 1:1 aus dem Original übernommen — bitte nicht "vereinfachen" ohne Tests.
 */
export function getCurrentRaidId() {
    // 1. URL-Hash hat höchste Priorität (z.B. "#siegeoforgrimmar/immerseus")
    const hash = window.location.hash.substring(1);
    if (hash) {
        const pageId = hash.split('&')[0]; // vor & für Sektionen
        // Format: "raidId/bossId" (Boss-Seite) oder nur "pageId" (comp, loot, etc.)
        if (pageId.includes('/')) {
            const raidFromHash = pageId.split('/')[0];
            // Validieren dass es eine bekannte Raid-ID ist
            if (window.RAID_THEME_CONFIG && window.RAID_THEME_CONFIG[raidFromHash]) {
                return raidFromHash;
            }
            // Fallback: Auch wenn kein Theme-Config, Raid-ID akzeptieren
            if (raidFromHash === 'throneofthunder' || raidFromHash === 'siegeoforgrimmar') {
                return raidFromHash;
            }
        }
    }

    // 2. sessionStorage als Fallback
    const stored = sessionStorage.getItem('lastSelectedRaid');
    if (stored) return stored;

    // 3. raid-selector wenn da
    const selector = document.getElementById('raid-selector');
    if (selector && selector.value) return selector.value;

    // 4. Default
    return 'throneofthunder';
}
window.getCurrentRaidId = getCurrentRaidId;