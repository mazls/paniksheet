/* =========================================================================
   roster-comp.js — Roster, Comp-Seite, Patches, Buffs, Summary
   =========================================================================
   Alles rund um das Spieler-Roster:
   - Roster-Daten laden und anzeigen (5er-Gruppen + Bench)
   - Klasse/Spec/Rolle editieren (Player-Edit-Modal)
   - Boss-spezifische Patches (RosterPatches IIFE)
   - Alias-Map (Spielernamen mappen)
   - Raid-Buff-Zuweisung & Soulstones
   - Spieler-Summary-Tabelle (welche Buffs / Loot pro Spieler)
   - Spieler raidweit ersetzen

   EXPONIERT GLOBAL:
     window.RosterPatches             (IIFE-Objekt)
     window.displayRoster, window.createCompactPlayerCard
     window.openPlayerEditModal, window.closePlayerEditModal
     window.togglePlayerRole, window.handlePlayerUpdate
     window.handleAddOrUpdateAlias, window.handleDeleteAlias
     window.fetchRoster
     window.handleImportRoster
     window.initBuffAssignments, window.initSoulstoneAssignments
     window.renderPlayerSummary, window.drawPlayerSummaryTable
     ... viele mehr (siehe `window.X = X` am Ende jedes Abschnitts)
   ========================================================================= */

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

import { state, offensiveBuffsForAssignment, getCurrentRaidId, debounce, debouncedUpdatePools } from './state.js';



// =============================================================================
// ROSTER-PATCHES (boss-spezifische Overrides für Klasse/Spec/Rolle/Slot)
// =============================================================================

window.RosterPatches = (function() {
    let bossPatchesById = {};        // bossId → patches-object
    let bossSlotOverridesById = {};  // bossId → slotOverrides-object { SlotKey: PlayerName | null }

    function applyPatchObject(player, patch) {
        if (!patch) return player;
        const out = { ...player };
        // class wird in unterschiedlichen Feldern gespeichert je nach Quelle
        if (patch.class)  { out.class = patch.class; out.className = patch.class; }
        if (patch.spec)   { out.spec = patch.spec; out.specName = patch.spec; out.specialization = patch.spec; }
        if (patch.role) {
            out.role = patch.role;
            // roles[] ist die kanonische Form im Roster — überschreiben damit alle Filter konsistent matchen
            out.roles = [patch.role];
        }
        // Marker zur Anzeige im UI
        out._patched = true;
        return out;
    }

    function buildEffectiveRoster(globalRoster, bossId, options) {
        if (!Array.isArray(globalRoster)) return [];
        const opts = options || {};
        const bossPatches = bossPatchesById[bossId] || {};

        // 1. Patches anwenden (Klasse/Spec/Rolle pro Boss überschreiben)
        let roster = (Object.keys(bossPatches).length === 0)
            ? globalRoster
            : globalRoster.map(p => {
                const name = p.name || p;
                if (bossPatches[name]) {
                    return applyPatchObject({ ...p, name: name }, bossPatches[name]);
                }
                return p;
            });

        // 2. Bench-Spieler optional rausfiltern.
        //    Regel: Bench-Spieler sind alle ab Index 25 in globalRoster.
        //    Ausnahme: hat der Spieler für diesen Boss einen Patch → bleibt drin
        //    (Patch = User hat ihn bewusst für diesen Boss konfiguriert).
        if (opts.excludeBench) {
            const RAID_SLOT_COUNT = 25;
            // Map name → original global index (Bench-Erkennung über globalRoster, nicht über roster
            //  — der könnte schon umsortiert sein, aber Indizes in globalRoster sind die Wahrheitsquelle)
            const benchNames = new Set(
                globalRoster.slice(RAID_SLOT_COUNT).map(p => p.name || p)
            );
            roster = roster.filter(p => {
                const name = p.name || p;
                const isOnBench = benchNames.has(name);
                const hasPatch = !!bossPatches[name];
                // Drin lassen wenn NICHT Bench, ODER Bench-mit-Patch
                return !isOnBench || hasPatch;
            });
        }

        return roster;
    }

    /**
     * Liefert das effektive Slot-Mapping für einen Boss.
     * Globales Mapping + Slot-Overrides:
     *   - Override-Wert ist Spielername → ersetzt globalen Wert
     *   - Override-Wert ist null → Slot ist bei diesem Boss leer (delete)
     *   - Slot nicht in Overrides → globaler Wert bleibt
     */
    function getEffectiveSlotMapping(bossId) {
        const globalMapping = (window.SlotSystem && window.SlotSystem.getMapping)
            ? window.SlotSystem.getMapping()
            : {};
        const overrides = bossSlotOverridesById[bossId] || {};
        if (Object.keys(overrides).length === 0) return globalMapping;

        const result = { ...globalMapping };
        Object.entries(overrides).forEach(([slotKey, value]) => {
            if (value === null || value === '') {
                delete result[slotKey];
            } else {
                result[slotKey] = value;
            }
        });
        return result;
    }

    function setBossPatches(bossId, patches) {
        bossPatchesById[bossId] = patches || {};
    }

    function setBossSlotOverrides(bossId, slotOverrides) {
        bossSlotOverridesById[bossId] = slotOverrides || {};
    }

    function getBossSlotOverrides(bossId) {
        return { ...(bossSlotOverridesById[bossId] || {}) };
    }

    function hasAnyPatches(bossId) {
        const p = bossPatchesById[bossId] || {};
        const o = bossSlotOverridesById[bossId] || {};
        return Object.keys(p).length > 0 || Object.keys(o).length > 0;
    }

    /**
     * Speichert Patches (und optional Slot-Overrides) für einen Boss.
     * Wenn slotOverrides nicht übergeben wird, wird der existing Stand beibehalten.
     */
    async function saveBossPatches(bossId, patches, firebaseTools, editorName, slotOverrides) {
        if (!firebaseTools) return;
        const ref = firebaseTools.doc(firebaseTools.db, "raid-tool-data", bossId);

        // WICHTIG: Mit setDoc(..., { merge: true }) macht Firestore einen
        // rekursiven Map-Merge. Dadurch würden gelöschte Patch-Einträge nicht
        // tatsächlich entfernt, sondern alte+neue gemergt. Lösung: Wir nutzen
        // updateDoc und setzen das ganze _rosterPatches-Feld als Atom — dann
        // ersetzt Firestore das Feld komplett (kein Map-Merge).
        const updateDoc = firebaseTools.updateDoc;
        const setDoc = firebaseTools.setDoc;
        const effectiveSlotOverrides = (slotOverrides !== undefined)
            ? slotOverrides
            : (bossSlotOverridesById[bossId] || {});
        const newValue = {
            patches: patches,
            slotOverrides: effectiveSlotOverrides,
            editor: editorName || 'Unbekannt',
            timestamp: new Date().toISOString()
        };

        try {
            // updateDoc ersetzt einzelne Felder als Ganzes (kein Deep-Merge auf Maps)
            await updateDoc(ref, { _rosterPatches: newValue });
        } catch (e) {
            // Falls das Doc noch nicht existiert (z.B. neuer Boss), legen wir es an.
            if (e.code === 'not-found') {
                await setDoc(ref, { _rosterPatches: newValue }, { merge: true });
            } else {
                throw e;
            }
        }
    }

    return {
        setBossPatches,
        setBossSlotOverrides,
        getBossSlotOverrides,
        getEffectiveSlotMapping,
        hasAnyPatches,
        buildEffectiveRoster,
        saveBossPatches,
        getBossPatches: (bossId) => ({ ...(bossPatchesById[bossId] || {}) })
    };
})();

// ════════════════════════════════════════════════════════════════════════
// ROSTER-PATCHES UI — Banner auf Boss-Seite + Modal-Editor
// ════════════════════════════════════════════════════════════════════════

// Klassen-/Spec-Definitionen für die Modal-Dropdowns (analog zu Sha-of-Pride)
window.ROSTER_PATCH_SPECS = {
    DEATHKNIGHT: ['Blood', 'Frost1', 'Unholy'],
    DRUID: ['Balance', 'Feral', 'Guardian', 'Restoration'],
    HUNTER: ['Beastmastery', 'Marksmanship', 'Survival'],
    MAGE: ['Arcane', 'Fire', 'Frost'],
    MONK: ['Brewmaster', 'Mistweaver', 'Windwalker'],
    PALADIN: ['Holy1', 'Protection1', 'Retribution'],
    PRIEST: ['Discipline', 'Holy', 'Shadow'],
    ROGUE: ['Assassination', 'Combat', 'Subtlety'],
    SHAMAN: ['Elemental', 'Enhancement', 'Restoration1'],
    WARLOCK: ['Affliction', 'Demonology', 'Destruction'],
    WARRIOR: ['Arms', 'Fury', 'Protection']
};
window.ROSTER_PATCH_CLASS_DISPLAY = {
    DEATHKNIGHT: 'Todesritter', DRUID: 'Druide', HUNTER: 'Jäger',
    MAGE: 'Magier', MONK: 'Mönch', PALADIN: 'Paladin',
    PRIEST: 'Priester', ROGUE: 'Schurke', SHAMAN: 'Schamane',
    WARLOCK: 'Hexenmeister', WARRIOR: 'Krieger'
};

window.injectRosterPatchBanner = function(bossId) {
    console.log('[RosterPatches] injectRosterPatchBanner called for', bossId);
    // Banner wird in den Boss-Page-Container ganz oben eingefügt
    const contentContainer = document.getElementById('content-container') || document.querySelector('main');
    if (!window.contentContainer) {
        console.warn('[RosterPatches] content-container nicht gefunden');
        return;
    }
    
    // Falls schon ein Banner existiert, entfernen
    const existing = document.getElementById('roster-patch-banner');
    if (existing) existing.remove();
    
    const banner = document.createElement('div');
    banner.id = 'roster-patch-banner';
    banner.className = 'mb-4 bg-slate-800/80 border border-purple-700/40 rounded-lg p-3 text-sm';
    banner.dataset.bossId = bossId;
    
    window.contentContainer.insertBefore(banner, window.contentContainer.firstChild);
    console.log('[RosterPatches] Banner eingefügt in #content-container');
    window.updateRosterPatchBanner(bossId);
};

window.updateRosterPatchBanner = function(bossId) {
    const banner = document.getElementById('roster-patch-banner');
    if (!banner) return;
    if (banner.dataset.bossId !== bossId) return;  // veraltetes Banner, ignorieren
    
    const bossPatches = window.RosterPatches.getBossPatches(bossId);
    const slotOverrides = window.RosterPatches.getBossSlotOverrides(bossId);
    const patchCount = Object.keys(bossPatches).length;
    const slotOverrideCount = Object.keys(slotOverrides).length;
    const totalCount = patchCount + slotOverrideCount;
    
    let html = `
        <div class="flex items-center gap-2 flex-wrap">
            <span class="text-purple-300 font-bold flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                Roster-Anpassungen
            </span>
    `;
    
    if (totalCount === 0) {
        html += `<span class="text-gray-400 text-xs">- keine aktiv (Standard-Roster wird verwendet)</span>`;
    } else {
        // Spieler-Patches als violette Chips
        Object.entries(bossPatches).forEach(([name, patch]) => {
            const summary = formatPatchSummary(patch);
            html += `<span class="inline-flex items-center gap-1 text-xs bg-purple-900/40 border border-purple-700 rounded px-2 py-0.5">
                <span class="text-white">${name}</span>
                <span class="text-purple-200">→ ${summary}</span>
            </span>`;
        });
        // Slot-Overrides als gold/gelbe Chips
        Object.entries(slotOverrides).forEach(([slotKey, value]) => {
            const display = (value === null || value === '') ? '<em>(leer)</em>' : value;
            html += `<span class="inline-flex items-center gap-1 text-xs bg-yellow-900/40 border border-yellow-700 rounded px-2 py-0.5">
                <span class="text-yellow-200 font-mono">${slotKey}</span>
                <span class="text-yellow-100">→ ${display}</span>
            </span>`;
        });
    }
    
    html += `
            <button id="roster-patch-banner-edit" class="ml-auto text-xs bg-purple-700 hover:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed text-white py-1 px-3 rounded">
                ${totalCount > 0 ? '✎ Bearbeiten' : '+ Anpassung hinzufügen'}
            </button>
        </div>
    `;
    
    banner.innerHTML = html;
    
    const editBtn = document.getElementById('roster-patch-banner-edit');
    if (editBtn) {
        editBtn.disabled = !window.isManager;
        editBtn.addEventListener('click', () => window.openRosterPatchModal(bossId));
    }
};

function formatPatchSummary(patch) {
    if (!patch) return '';
    const parts = [];
    if (patch.class) parts.push(window.ROSTER_PATCH_CLASS_DISPLAY[patch.class.toUpperCase()] || patch.class);
    if (patch.spec)  parts.push(patch.spec.replace(/1$/, ''));
    if (patch.role)  parts.push(`[${patch.role}]`);
    return parts.length ? parts.join(' ') : '(leer)';
}

// ── Modal-Editor ──
window.openRosterPatchModal = function(bossId) {
    if (!window.isManager) return window.showModal && window.showModal('Nur Gildenräte können Patches editieren.');
    
    // Vorhandenes Modal entfernen
    const existing = document.getElementById('roster-patch-modal');
    if (existing) existing.remove();
    
    const modal = document.createElement('div');
    modal.id = 'roster-patch-modal';
    modal.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';
    modal.innerHTML = `
        <div class="bg-slate-800 border border-slate-600 rounded-lg p-4 max-w-2xl w-full max-h-[85vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-3 pb-2 border-b border-slate-700">
                <h3 class="text-lg font-bold text-purple-300">Roster-Anpassungen für diesen Boss</h3>
                <button id="rp-close" class="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>
            </div>
            
            <div class="mb-3 text-xs text-gray-400">
                Patches überschreiben den Standard-Roster nur für diesen einen Boss.
                Du kannst Klasse, Spec oder Rolle einzeln ändern - alle anderen Bosse bleiben unberührt.
            </div>

            <!-- SPIELER-PATCHES -->
            <div class="mb-4">
                <div class="flex items-center justify-between mb-2">
                    <h4 class="text-sm font-bold text-purple-300">👤 Spieler-Patches</h4>
                </div>
                <ul id="rp-boss-list" class="space-y-1 mb-2"></ul>
                <button id="rp-add-boss" class="text-xs bg-purple-700 hover:bg-purple-800 text-white py-1.5 px-3 rounded">+ Patch hinzufügen</button>
            </div>

            <!-- SLOT-OVERRIDES -->
            <div class="pt-3 border-t border-slate-700">
                <div class="flex items-center justify-between mb-2">
                    <h4 class="text-sm font-bold text-yellow-300">🎯 Slot-Overrides</h4>
                </div>
                <p class="text-xs text-gray-400 mb-2">
                    Bei diesem Boss zeigt ein Slot wie <code class="text-yellow-200">HPALA1</code>
                    auf einen anderen Spieler als global &mdash; oder bleibt leer.
                </p>
                <ul id="rp-slot-list" class="space-y-1 mb-2"></ul>
                <button id="rp-add-slot" class="text-xs bg-yellow-700 hover:bg-yellow-600 text-white py-1.5 px-3 rounded">+ Slot-Override hinzufügen</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    function renderList() {
        const bossPatches = window.RosterPatches.getBossPatches(bossId);
        document.getElementById('rp-boss-list').innerHTML = renderPatchList(bossPatches);
        
        // Click-Handler für Edit/Del
        modal.querySelectorAll('.rp-edit').forEach(b => b.addEventListener('click', () => {
            window.openRosterPatchEditor(bossId, b.dataset.name, () => renderList());
        }));
        modal.querySelectorAll('.rp-del').forEach(b => b.addEventListener('click', async () => {
            const name = b.dataset.name;
            if (!confirm(`Patch für "${name}" wirklich löschen?`)) return;
            await deletePatch(bossId, name);
            renderList();
        }));

        // Slot-Overrides rendern
        renderSlotList();
    }

    function renderSlotList() {
        const slotOverrides = window.RosterPatches.getBossSlotOverrides(bossId);
        const list = document.getElementById('rp-slot-list');
        const keys = Object.keys(slotOverrides);
        if (keys.length === 0) {
            list.innerHTML = '<li class="text-xs text-gray-500 italic px-2">Keine Slot-Overrides.</li>';
            return;
        }
        const globalMapping = (window.SlotSystem && window.SlotSystem.getMapping)
            ? window.SlotSystem.getMapping() : {};

        list.innerHTML = keys.sort().map(slotKey => {
            const value = slotOverrides[slotKey];
            const isEmpty = (value === null || value === '');
            const display = isEmpty ? '<em class="text-gray-500">(leer)</em>' : `<span class="text-yellow-100">${value}</span>`;
            const globalVal = globalMapping[slotKey] || '(leer)';
            return `
                <li class="flex items-center gap-2 bg-slate-900 border border-yellow-800/40 rounded px-2 py-1.5 text-xs">
                    <code class="text-yellow-200 font-mono bg-yellow-900/30 px-2 py-0.5 rounded">${slotKey}</code>
                    <span class="text-gray-400">→</span>
                    ${display}
                    <span class="text-gray-500 ml-2 text-[10px]">(global: ${globalVal})</span>
                    <button class="rp-slot-edit ml-auto text-blue-400 hover:text-blue-300 px-1" data-slot="${slotKey}" title="Bearbeiten">✎</button>
                    <button class="rp-slot-del text-red-400 hover:text-red-300 px-1" data-slot="${slotKey}" title="Override entfernen">✕</button>
                </li>
            `;
        }).join('');

        modal.querySelectorAll('.rp-slot-edit').forEach(b => b.addEventListener('click', () => {
            window.openSlotOverrideEditor(bossId, b.dataset.slot, () => renderSlotList());
        }));
        modal.querySelectorAll('.rp-slot-del').forEach(b => b.addEventListener('click', async () => {
            const slotKey = b.dataset.slot;
            if (!confirm(`Slot-Override für "${slotKey}" entfernen?`)) return;
            await deleteSlotOverride(bossId, slotKey);
            renderSlotList();
        }));
    }
    
    function renderPatchList(patches) {
        const names = Object.keys(patches);
        if (names.length === 0) {
            return '<li class="text-xs text-gray-500 italic px-2">Keine Patches.</li>';
        }
        return names.map(name => {
            const summary = formatPatchSummary(patches[name]);
            const note = patches[name].note ? `<span class="text-gray-500 ml-1 italic">- ${patches[name].note}</span>` : '';
            return `
                <li class="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs">
                    <span class="font-bold text-white">${name}</span>
                    <span class="text-gray-300">→ ${summary}</span>
                    ${note}
                    <button class="rp-edit ml-auto text-blue-400 hover:text-blue-300 px-1" data-name="${name}" title="Bearbeiten">✎</button>
                    <button class="rp-del text-red-400 hover:text-red-300 px-1" data-name="${name}" title="Löschen">✕</button>
                </li>
            `;
        }).join('');
    }
    
    document.getElementById('rp-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('rp-add-boss').addEventListener('click', () => {
        window.openRosterPatchEditor(bossId, null, () => renderList());
    });
    document.getElementById('rp-add-slot').addEventListener('click', () => {
        window.openSlotOverrideEditor(bossId, null, () => renderSlotList());
    });
    
    renderList();
};

async function deleteSlotOverride(bossId, slotKey) {
    const editorName = sessionStorage.getItem('currentManager') || 'Unbekannt';
    const slotOverrides = window.RosterPatches.getBossSlotOverrides(bossId);
    delete slotOverrides[slotKey];
    const patches = window.RosterPatches.getBossPatches(bossId);
    await window.RosterPatches.saveBossPatches(bossId, patches, window.firebaseTools, editorName, slotOverrides);
    window.RosterPatches.setBossSlotOverrides(bossId, slotOverrides);
    if (window.updateRosterPatchBanner) window.updateRosterPatchBanner(bossId);
}

// Editor-Modal für einzelnen Slot-Override
window.openSlotOverrideEditor = function(bossId, existingKey, onSaved) {
    if (!bossId) {
        alert('Kein Boss ausgewählt');
        return;
    }
    const slotOverrides = window.RosterPatches.getBossSlotOverrides(bossId);
    const existing = existingKey ? slotOverrides[existingKey] : undefined;
    const isEdit = !!existingKey;

    // Slot-Liste — nur welche, die noch keinen Override haben (oder der gerade editierte)
    // Mit defensivem Fallback: direkt aus SPEC_DEFINITIONS bauen falls getSlotsByClass fehlt
    let allSlotsByClass = {};
    if (window.SlotSystem) {
        if (typeof window.SlotSystem.getSlotsByClass === 'function') {
            allSlotsByClass = window.SlotSystem.getSlotsByClass();
        } else if (Array.isArray(window.SlotSystem.SPEC_DEFINITIONS)) {
            // Fallback: aus SPEC_DEFINITIONS bauen
            window.SlotSystem.SPEC_DEFINITIONS.forEach(([prefix, cls, spec, maxSlots]) => {
                if (!allSlotsByClass[cls]) allSlotsByClass[cls] = [];
                allSlotsByClass[cls].push({ prefix, spec, maxSlots });
            });
        }
    }

    // Diagnose-Log falls leer
    if (Object.keys(allSlotsByClass).length === 0) {
        console.warn('[SlotOverrideEditor] Keine Slots gefunden. Prüfe ob slot-system.js geladen ist und getSlotsByClass / SPEC_DEFINITIONS exposed sind.', {
            slotSystem: !!window.SlotSystem,
            getSlotsByClass: typeof window.SlotSystem?.getSlotsByClass,
            SPEC_DEFINITIONS: Array.isArray(window.SlotSystem?.SPEC_DEFINITIONS)
        });
        alert('Slot-System nicht initialisiert. Bitte die Seite neu laden — falls das Problem bleibt, prüfe in der Browser-Konsole, ob slot-system.js korrekt geladen ist.');
        return;
    }

    const availableSlots = [];
    Object.entries(allSlotsByClass).forEach(([cls, specs]) => {
        specs.forEach(({ prefix, spec, maxSlots }) => {
            for (let i = 1; i <= maxSlots; i++) {
                const key = prefix + i;
                if (!slotOverrides.hasOwnProperty(key) || key === existingKey) {
                    availableSlots.push({ key, cls, spec });
                }
            }
        });
    });

    // Spieler-Liste mit Patches drauf
    const effectiveRoster = window.RosterPatches.buildEffectiveRoster(window.rosterData || [], bossId);

    const editorEl = document.createElement('div');
    editorEl.id = 'slot-override-editor';
    editorEl.className = 'fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4';

    const slotOptionsHtml = availableSlots.map(({ key, cls }) => {
        const color = window.classColors[cls] || '#FFFFFF';
        const selected = key === existingKey ? 'selected' : '';
        return `<option value="${key}" style="color:${color};" ${selected}>${key}</option>`;
    }).join('');

    const playerOptionsHtml = effectiveRoster.map(p => {
        const color = window.classColors[(p.class || '').toUpperCase()] || '#FFFFFF';
        const selected = p.name === existing ? 'selected' : '';
        return `<option value="${p.name}" style="color:${color};" ${selected}>${p.name}</option>`;
    }).join('');

    const isEmpty = (existing === null);

    editorEl.innerHTML = `
        <div class="bg-slate-800 border border-yellow-700 rounded-lg p-4 max-w-md w-full">
            <div class="flex items-center justify-between mb-3 pb-2 border-b border-slate-700">
                <h3 class="text-lg font-bold text-yellow-300">${isEdit ? 'Slot-Override bearbeiten' : 'Slot-Override hinzufügen'}</h3>
                <button id="so-close" class="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>
            </div>

            <div class="space-y-3">
                <div>
                    <label class="block text-xs text-gray-300 mb-1">Slot</label>
                    <select id="so-key" class="w-full bg-slate-900 border border-slate-600 text-gray-200 text-sm rounded px-2 py-1" ${isEdit ? 'disabled' : ''}>
                        <option value="">— Slot wählen —</option>
                        ${slotOptionsHtml}
                    </select>
                </div>

                <div>
                    <label class="block text-xs text-gray-300 mb-1">Bei diesem Boss zeigt der Slot auf:</label>
                    <select id="so-value" class="w-full bg-slate-900 border border-slate-600 text-gray-200 text-sm rounded px-2 py-1">
                        <option value="__EMPTY__" ${isEmpty ? 'selected' : ''}>(leer / unmapped bei diesem Boss)</option>
                        ${playerOptionsHtml}
                    </select>
                </div>

                <p class="text-[10px] text-gray-500 italic">
                    Tipp: Wenn der Slot auf <em>(leer)</em> gesetzt ist, wird er für diesen Boss
                    in CD-Einteilungen nicht aufgelöst und im Export ausgelassen.
                </p>
            </div>

            <div class="flex gap-2 justify-end mt-4 pt-3 border-t border-slate-700">
                <button id="so-cancel" class="text-xs bg-slate-700 hover:bg-slate-600 text-gray-200 py-1.5 px-3 rounded">Abbrechen</button>
                <button id="so-save" class="text-xs bg-yellow-700 hover:bg-yellow-600 text-white py-1.5 px-3 rounded">Speichern</button>
            </div>
        </div>
    `;
    document.body.appendChild(editorEl);

    const close = () => editorEl.remove();
    document.getElementById('so-close').addEventListener('click', close);
    document.getElementById('so-cancel').addEventListener('click', close);
    editorEl.addEventListener('click', e => { if (e.target === editorEl) close(); });

    document.getElementById('so-save').addEventListener('click', async () => {
        const keySel = document.getElementById('so-key');
        const valSel = document.getElementById('so-value');
        const slotKey = isEdit ? existingKey : keySel.value;
        if (!slotKey) {
            alert('Bitte einen Slot wählen.');
            return;
        }
        const newValue = valSel.value === '__EMPTY__' ? null : valSel.value;
        const editorName = sessionStorage.getItem('currentManager') || 'Unbekannt';

        const allOverrides = window.RosterPatches.getBossSlotOverrides(bossId);
        allOverrides[slotKey] = newValue;
        const patches = window.RosterPatches.getBossPatches(bossId);

        await window.RosterPatches.saveBossPatches(bossId, patches, window.firebaseTools, editorName, allOverrides);
        window.RosterPatches.setBossSlotOverrides(bossId, allOverrides);
        if (window.updateRosterPatchBanner) window.updateRosterPatchBanner(bossId);
        if (typeof onSaved === 'function') onSaved();
        close();
    });
};

async function deletePatch(bossId, name) {
    const editorName = sessionStorage.getItem('currentManager') || 'Unbekannt';
    const patches = { ...window.RosterPatches.getBossPatches(bossId) };
    delete patches[name];
    const slotOverrides = window.RosterPatches.getBossSlotOverrides(bossId);
    await window.RosterPatches.saveBossPatches(bossId, patches, window.firebaseTools, editorName, slotOverrides);
    window.RosterPatches.setBossPatches(bossId, patches);
    if (window.updateRosterPatchBanner) window.updateRosterPatchBanner(bossId);
}

// Editor für einen einzelnen Patch (entweder add oder edit)
window.openRosterPatchEditor = function(bossId, existingName, onSaved) {
    if (!bossId) {
        alert('Kein Boss ausgewählt - Patches können nur auf einer Boss-Seite oder über die Comp-Verwaltung angelegt werden.');
        return;
    }
    const existingPatches = window.RosterPatches.getBossPatches(bossId);
    const existing = existingName ? existingPatches[existingName] : null;
    
    // Spielerliste aus globalem Roster
    const players = (window.rosterData || []).map(p => p.name).sort();
    
    const editorEl = document.createElement('div');
    editorEl.id = 'roster-patch-editor';
    editorEl.className = 'fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4';
    editorEl.innerHTML = `
        <div class="bg-slate-800 border border-slate-600 rounded-lg p-4 max-w-md w-full">
            <h4 class="text-base font-bold text-yellow-300 mb-3">${existingName ? 'Patch bearbeiten' : 'Neuer Patch'}</h4>
            <div class="space-y-3 text-sm">
                <div>
                    <label class="block text-xs text-gray-400 mb-1">Spieler</label>
                    <select id="rpe-player" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white" ${existingName ? 'disabled' : ''}>
                        <option value="">— Spieler wählen —</option>
                        ${players.map(n => `<option value="${n}" ${n === existingName ? 'selected' : ''}>${n}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label class="block text-xs text-gray-400 mb-1">Klasse <span class="text-gray-500">(leer = unverändert)</span></label>
                    <select id="rpe-class" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white">
                        <option value="">— unverändert —</option>
                        ${Object.keys(window.ROSTER_PATCH_SPECS).map(c => `<option value="${c}" ${existing && existing.class && existing.class.toUpperCase() === c ? 'selected' : ''}>${window.ROSTER_PATCH_CLASS_DISPLAY[c]}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label class="block text-xs text-gray-400 mb-1">Spec <span class="text-gray-500">(leer = unverändert)</span></label>
                    <select id="rpe-spec" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white">
                        <option value="">— unverändert —</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs text-gray-400 mb-1">Rolle <span class="text-gray-500">(leer = unverändert)</span></label>
                    <select id="rpe-role" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white">
                        <option value="">— unverändert —</option>
                        <option value="tank"  ${existing && existing.role === 'tank'  ? 'selected' : ''}>Tank</option>
                        <option value="healer"${existing && existing.role === 'healer'? 'selected' : ''}>Healer</option>
                        <option value="dps"   ${existing && existing.role === 'dps'   ? 'selected' : ''}>DPS</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs text-gray-400 mb-1">Notiz <span class="text-gray-500">(optional)</span></label>
                    <input id="rpe-note" type="text" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white" placeholder="z.B. 'off-spec heal für Phase 2'" value="${existing && existing.note ? String(existing.note).replace(/"/g, '&quot;') : ''}">
                </div>
                <div class="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-700/40 rounded p-2">
                    💡 Mindestens eines der Felder Klasse/Spec/Rolle muss gesetzt sein, damit der Patch wirkt.
                </div>
            </div>
            <div class="flex gap-2 mt-4">
                <button id="rpe-save" class="bg-emerald-700 hover:bg-emerald-800 text-white py-1.5 px-3 rounded text-sm">Speichern</button>
                <button id="rpe-cancel" class="bg-slate-700 hover:bg-slate-800 text-white py-1.5 px-3 rounded text-sm">Abbrechen</button>
            </div>
        </div>
    `;
    document.body.appendChild(editorEl);
    
    const classSel = document.getElementById('rpe-class');
    const specSel = document.getElementById('rpe-spec');
    
    function refillSpecs(selectedClass, currentSpec) {
        specSel.innerHTML = '<option value="">— unverändert —</option>';
        if (selectedClass && window.ROSTER_PATCH_SPECS[selectedClass]) {
            window.ROSTER_PATCH_SPECS[selectedClass].forEach(s => {
                const opt = new Option(s, s);
                if (currentSpec && s === currentSpec) opt.selected = true;
                specSel.appendChild(opt);
            });
        }
    }
    refillSpecs(classSel.value, existing && existing.spec ? existing.spec : '');
    classSel.addEventListener('change', () => refillSpecs(classSel.value, ''));
    
    document.getElementById('rpe-cancel').addEventListener('click', () => editorEl.remove());
    editorEl.addEventListener('click', (e) => { if (e.target === editorEl) editorEl.remove(); });
    
    document.getElementById('rpe-save').addEventListener('click', async () => {
        const playerName = document.getElementById('rpe-player').value || existingName;
        if (!playerName) {
            alert('Bitte einen Spieler auswählen.');
            return;
        }
        const cls = classSel.value.trim();
        const spec = specSel.value.trim();
        const role = document.getElementById('rpe-role').value.trim();
        const note = document.getElementById('rpe-note').value.trim();
        
        if (!cls && !spec && !role) {
            alert('Mindestens Klasse, Spec oder Rolle muss gesetzt sein.');
            return;
        }
        
        const patchData = {};
        // Klasse wird im Roster als "Priest" gespeichert, nicht "PRIEST"; konvertieren zu Title-Case
        if (cls)  patchData.class = cls.charAt(0).toUpperCase() + cls.slice(1).toLowerCase();
        if (spec) patchData.spec = spec;
        if (role) patchData.role = role;
        if (note) patchData.note = note;
        
        const editorName = sessionStorage.getItem('currentManager') || 'Unbekannt';
        
        try {
            const all = { ...window.RosterPatches.getBossPatches(bossId) };
            all[playerName] = patchData;
            await window.RosterPatches.saveBossPatches(bossId, all, window.firebaseTools, editorName);
            window.RosterPatches.setBossPatches(bossId, all);
            
            if (window.updateRosterPatchBanner) window.updateRosterPatchBanner(bossId);
            // Wenn wir auf der Boss-Seite dieses bossIds sind, Listener neu starten
            // damit der effektive Roster sofort an alle Module weitergegeben wird.
            if (window.currentBossIdForPatches === bossId && typeof window.setupBossListener === 'function') {
                window.setupBossListener(bossId);
            }
            editorEl.remove();
            if (typeof onSaved === 'function') onSaved();
        } catch (err) {
            console.error('[RosterPatches] Save fehlgeschlagen:', err);
            alert('Speichern fehlgeschlagen: ' + err.message);
        }
    });
};

// ════════════════════════════════════════════════════════════════════════
// ROSTER-PATCHES — Zentrale Verwaltungs-UI in comp.html
// ════════════════════════════════════════════════════════════════════════
window.initRosterPatchesCompUI = function(bosses) {
    const section = document.getElementById('roster-patches-section');
    if (!section) {
        console.warn('[RosterPatches] roster-patches-section nicht im DOM gefunden');
        return;
    }
    
    if (!Array.isArray(bosses) || bosses.length === 0) {
        section.innerHTML += '<div class="text-xs text-yellow-400 italic mt-2">Keine Bosse für die aktuelle Raid gefunden.</div>';
        return;
    }
    
    if (!window.isManager) {
        section.classList.add('opacity-60');
    }
    
    const tabsEl = document.getElementById('rp-comp-boss-tabs');
    const contentEl = document.getElementById('rp-comp-boss-content');
    const emptyHint = document.getElementById('rp-comp-empty-hint');
    
    if (!tabsEl || !contentEl) {
        console.warn('[RosterPatches] Tab/Content-Container nicht gefunden');
        return;
    }
    
    // Aktuell ausgewählter Boss-Tab
    let selectedBossTab = null;
    // Cache aller Boss-Patches für die anzeigbaren Bosse
    let bossPatchesCache = {};  // bossId → { name, patches }
    
    // Lade Patches aller Bosse der aktuellen Raid (einmalig + bei Updates)
    async function loadAllBossPatches() {
        bossPatchesCache = {};
        
        if (!window.firebaseTools) {
            console.warn('[RosterPatches] window.firebaseTools nicht verfügbar');
            return;
        }
        const { getDoc, doc, db } = window.firebaseTools;
        
        for (const boss of bosses) {
            const bossId = 'boss-' + boss.id;
            try {
                const snap = await getDoc(doc(db, "raid-tool-data", bossId));
                if (snap.exists()) {
                    const data = snap.data();
                    if (data._rosterPatches && data._rosterPatches.patches && Object.keys(data._rosterPatches.patches).length > 0) {
                        bossPatchesCache[bossId] = { name: boss.name, patches: data._rosterPatches.patches };
                    }
                }
            } catch (err) {
                console.warn(`[RosterPatches] Boss ${bossId} laden fehlgeschlagen:`, err);
            }
        }
        
        renderBossTabs();
        updateEmptyHint();
    }
    
    function renderBossTabs() {
        if (!tabsEl || !contentEl) return;
        
        // Wenn der aktuell ausgewählte Tab nicht existiert, fallback auf Boss mit Patches oder ersten
        if (!selectedBossTab || !bosses.find(b => 'boss-' + b.id === selectedBossTab)) {
            const firstWithPatches = bosses.find(b => bossPatchesCache['boss-' + b.id]);
            selectedBossTab = 'boss-' + (firstWithPatches ? firstWithPatches.id : bosses[0].id);
        }
        
        tabsEl.innerHTML = bosses.map(b => {
            const bid = 'boss-' + b.id;
            const data = bossPatchesCache[bid];
            const count = data ? Object.keys(data.patches).length : 0;
            const active = bid === selectedBossTab;
            const badge = count > 0 ? `<span class="opacity-70">(${count})</span>` : '';
            return `<button class="rpc-tab text-xs px-3 py-1.5 rounded ${active ? 'bg-purple-700 text-white' : count > 0 ? 'bg-slate-700 text-purple-200 hover:bg-slate-600' : 'bg-slate-800 text-gray-400 hover:bg-slate-700'}" data-boss-id="${bid}" data-boss-name="${b.name}">
                ${b.name} ${badge}
            </button>`;
        }).join('');
        
        tabsEl.querySelectorAll('.rpc-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedBossTab = btn.dataset.bossId;
                renderBossTabs();
            });
        });
        
        renderBossTabContent();
    }
    
    function renderBossTabContent() {
        if (!contentEl || !selectedBossTab) return;
        const bossEntry = bosses.find(b => 'boss-' + b.id === selectedBossTab);
        const bossName = bossEntry ? bossEntry.name : selectedBossTab;
        const data = bossPatchesCache[selectedBossTab];
        const patches = data ? data.patches : {};
        const names = Object.keys(patches);
        
        let html = `<div class="text-xs text-gray-400 mb-2">${bossName}:</div>`;
        if (names.length === 0) {
            html += '<div class="text-xs text-gray-500 italic mb-2">Keine Patches für diesen Boss.</div>';
        } else {
            html += '<ul class="space-y-1 mb-2">' + names.map(name => {
                const p = patches[name];
                const summary = formatPatchSummaryComp(p);
                const note = p.note ? `<span class="text-gray-500 ml-1 italic">— ${p.note}</span>` : '';
                return `
                    <li class="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs">
                        <span class="font-bold text-white">${name}</span>
                        <span class="text-gray-300">→ ${summary}</span>
                        ${note}
                        <button class="rpc-edit ml-auto text-blue-400 hover:text-blue-300 disabled:opacity-50 px-1" data-boss-id="${selectedBossTab}" data-name="${name}" title="Bearbeiten" ${window.isManager ? '' : 'disabled'}>✎</button>
                        <button class="rpc-del text-red-400 hover:text-red-300 disabled:opacity-50 px-1" data-boss-id="${selectedBossTab}" data-name="${name}" title="Löschen" ${window.isManager ? '' : 'disabled'}>✕</button>
                    </li>
                `;
            }).join('') + '</ul>';
        }
        html += `<button class="rpc-add-boss text-xs bg-purple-700 hover:bg-purple-800 disabled:opacity-50 text-white py-1 px-3 rounded" data-boss-id="${selectedBossTab}" ${window.isManager ? '' : 'disabled'}>+ Patch für ${bossName}</button>`;
        contentEl.innerHTML = html;
        
        contentEl.querySelector('.rpc-add-boss')?.addEventListener('click', (e) => {
            const bid = e.currentTarget.dataset.bossId;
            // RosterPatches lokal befüllen damit der Editor existierende Daten findet
            if (bossPatchesCache[bid]) {
                window.RosterPatches.setBossPatches(bid, bossPatchesCache[bid].patches);
            } else {
                window.RosterPatches.setBossPatches(bid, {});
            }
            window.openRosterPatchEditor(bid, null, () => loadAllBossPatches());
        });
        
        contentEl.querySelectorAll('.rpc-edit').forEach(b => {
            b.onclick = () => {
                const bid = b.dataset.bossId;
                const name = b.dataset.name;
                if (bossPatchesCache[bid]) {
                    window.RosterPatches.setBossPatches(bid, bossPatchesCache[bid].patches);
                }
                window.openRosterPatchEditor(bid, name, () => loadAllBossPatches());
            };
        });
        contentEl.querySelectorAll('.rpc-del').forEach(b => {
            b.onclick = async () => {
                const bid = b.dataset.bossId;
                const name = b.dataset.name;
                if (!confirm(`Patch für "${name}" löschen?`)) return;
                const editorName = sessionStorage.getItem('currentManager') || 'Unbekannt';
                const all = { ...(bossPatchesCache[bid]?.patches || {}) };
                delete all[name];
                await window.RosterPatches.saveBossPatches(bid, all, window.firebaseTools, editorName);
                window.RosterPatches.setBossPatches(bid, all);
                if (Object.keys(all).length > 0) {
                    bossPatchesCache[bid] = { name: bosses.find(b2 => 'boss-' + b2.id === bid)?.name || bid, patches: all };
                } else {
                    delete bossPatchesCache[bid];
                }
                renderBossTabs();
                updateEmptyHint();
            };
        });
    }
    
    function updateEmptyHint() {
        if (!emptyHint) return;
        const hasBoss = Object.keys(bossPatchesCache).length > 0;
        emptyHint.classList.toggle('hidden', hasBoss);
    }
    
    function formatPatchSummaryComp(patch) {
        if (!patch) return '';
        const parts = [];
        if (patch.class) parts.push(window.ROSTER_PATCH_CLASS_DISPLAY[patch.class.toUpperCase()] || patch.class);
        if (patch.spec)  parts.push(patch.spec);
        if (patch.role)  parts.push(`[${patch.role}]`);
        return parts.length ? parts.join(' ') : '(leer)';
    }
    
    // Initial laden
    loadAllBossPatches();
};

window.setupBossListener = function(bossId) {
    if (window.assignmentUnsubscribe) {
        window.assignmentUnsubscribe();
        window.assignmentUnsubscribe = null;
    }
    
    if (window._snapshotTimer) {
        clearTimeout(window._snapshotTimer);
        window._snapshotTimer = null;
    }
    window._snapshotFirstLoad = true;
    
    console.log("Setup Listener für:", bossId);
    window.assignmentsDocRef = doc(db, "raid-tool-data", bossId);

    // ENTFERNT: let snapshotTimer = null;  (war unbenutzt)

    window.assignmentUnsubscribe = onSnapshot(window.assignmentsDocRef, (docSnap) => {
        const rawData = docSnap.exists() ? docSnap.data() : {};
        
        // ── ROSTER-PATCHES extrahieren ────────────────────────────────
        // _rosterPatches ist ein Meta-Feld im Boss-Doc (kein Assignment).
        // Wir trennen es ab, bevor 'assignments' an die Boss-Module geht.
        const bossPatchesPayload = rawData._rosterPatches;
        const bossPatches = (bossPatchesPayload && bossPatchesPayload.patches) ? bossPatchesPayload.patches : {};
        const bossSlotOverrides = (bossPatchesPayload && bossPatchesPayload.slotOverrides) ? bossPatchesPayload.slotOverrides : {};

        // Vorherigen Stand merken — wenn Slot-Overrides sich geändert haben, müssen
        // die Dropdowns auf der Boss-Seite frisch befüllt werden.
        const previousOverrides = window.RosterPatches.getBossSlotOverrides(bossId);
        const slotOverridesChanged = JSON.stringify(previousOverrides) !== JSON.stringify(bossSlotOverrides);

        window.RosterPatches.setBossPatches(bossId, bossPatches);
        window.RosterPatches.setBossSlotOverrides(bossId, bossSlotOverrides);
        
        // 'assignments' = alles außer den Meta-Feldern
        const assignments = { ...rawData };
        delete assignments._rosterPatches;
        
        // Effektiver Roster = globalRoster + bossPatches
        const effectiveRoster = window.RosterPatches.buildEffectiveRoster(window.rosterData || [], bossId);
        // window.effectiveRoster wird vom Autoplaner gelesen → ohne Bench-Spieler (außer mit Boss-Patch),
        // damit der Autoplaner sie nicht versehentlich für Zuweisungen nutzt.
        // Die lokale 'effectiveRoster' bleibt komplett (mit Bench) für die Dropdowns auf der Boss-Seite.
        window.effectiveRoster = window.RosterPatches.buildEffectiveRoster(
            window.rosterData || [], bossId, { excludeBench: true }
        );
        window.currentBossIdForPatches = bossId;
        
        // Banner aktualisieren (falls bereits gerendert)
        if (typeof window.updateRosterPatchBanner === 'function') {
            window.updateRosterPatchBanner(bossId);
        }
        
        const rosterPlayerNames = effectiveRoster.map(p => p.name);

        const applyValues = () => {
            document.querySelectorAll('.assignment-select').forEach(select => {
                const assignmentId = select.dataset.assignmentId;
                if(!assignmentId) return;
                if (window.pendingAssignmentUpdates && window.pendingAssignmentUpdates[assignmentId]) return;

                const isCooldown = assignmentId.toLowerCase().includes('cooldown');
                const isManual = select.getAttribute('data-manual-options') === "true";
                
                const val = assignments[assignmentId] ? (assignments[assignmentId].cooldown || assignments[assignmentId].player) : "";
                
                if (select.value !== val) {
                    select.value = val;
                }

                select.classList.remove('invalid-assignment');
                const oldInvalid = select.querySelector('.invalid-option');
                if (oldInvalid && oldInvalid.value !== val) oldInvalid.remove(); 

                const ALLOWED_EXTRAS = ['ALL', 'DEATHKNIGHT', 'DRUID', 'HUNTER', 'MAGE', 'MONK', 'PALADIN', 'PRIEST', 'ROGUE', 'SHAMAN', 'WARLOCK', 'WARRIOR', 'TANKS', 'HEALERS', 'MELEEDPS', 'RANGEDDPS'];
                const isSlotValue = window.SlotSystem && window.SlotSystem.isSlotKey(val);

                if (val && !isCooldown && !isManual && !rosterPlayerNames.includes(val) && !ALLOWED_EXTRAS.includes(val) && !isSlotValue && val !== "Niemand") {
                    select.classList.add('invalid-assignment');
                    if (!Array.from(select.options).some(o => o.value === val)) {
                         const invalidOption = new Option(`❌ ${val} (Nicht im Roster)`, val);
                         invalidOption.className = 'invalid-option';
                         select.appendChild(invalidOption);
                         select.value = val;
                    }
                }
                
                const selectedOption = Array.from(select.options).find(o => o.value === val);
                select.style.color = selectedOption ? (selectedOption.dataset.color || '#fff') : '#fff';
            });

            document.querySelectorAll('.assignment-text-input').forEach(input => {
                const assignmentId = input.dataset.assignmentId;
                if(!assignmentId) return;
                if (window.pendingAssignmentUpdates && window.pendingAssignmentUpdates[assignmentId]) return;
                if (document.activeElement === input) return;
                const val = assignments[assignmentId]?.text || assignments[assignmentId]?.player || '';
                if (input.value !== val) {
                    input.value = val;
                }
            });
        };

        if (window._snapshotFirstLoad) {
            window._snapshotFirstLoad = false;
            
            applyValues();

            if (typeof window.initializePageSpecificCode === 'function') {
                window.initializePageSpecificCode(assignments, effectiveRoster, window.firebaseTools, window.allCooldowns);
            }

            setTimeout(() => {
                applyValues();
                if(window.toggleSelectEditability) window.toggleSelectEditability();
                if(typeof window.updateAssignmentPools === 'function') window.updateAssignmentPools();
            }, 100);
            
            return;
        }

        // Wenn Slot-Overrides sich geändert haben → Dropdowns neu befüllen, damit
        // die SPEC-SLOTS-Sektion das aktuelle Boss-spezifische Mapping zeigt.
        if (slotOverridesChanged) {
            document.querySelectorAll('.assignment-select').forEach(select => {
                if (select.getAttribute('data-manual-options') === 'true') return;
                const assignmentIdLower = (select.dataset.assignmentId || '').toLowerCase();
                if (assignmentIdLower.includes('cooldown')) return; // CD-Selects haben Spell-Optionen, keine Spieler

                let playersForDropdown = effectiveRoster;
                if (assignmentIdLower.includes('tank')) {
                    playersForDropdown = effectiveRoster.filter(p => p.roles && p.roles.includes('TANK'));
                } else if (assignmentIdLower.includes('healer')) {
                    playersForDropdown = effectiveRoster.filter(p => p.roles && p.roles.includes('HEALER'));
                } else if (assignmentIdLower.includes('dps') || assignmentIdLower.includes('dd')) {
                    playersForDropdown = effectiveRoster.filter(p => p.roles && p.roles.includes('DPS'));
                }
                window.populateDropdownOptions(select, playersForDropdown, bossId);
            });
        }

        clearTimeout(window._snapshotTimer);
        window._snapshotTimer = setTimeout(() => {
            applyValues();
            if(typeof window.updateAssignmentPools === 'function') window.updateAssignmentPools();
            if(window.updatePlannerSummary) window.updatePlannerSummary();
        }, 250);
    });
    
    // NEU: Safety-Fallback — falls onSnapshot nicht sofort feuert (Cache-Race-Condition)
    setTimeout(() => {
        if (window._snapshotFirstLoad) {
            console.log("Safety-Fallback: onSnapshot hat nicht gefeuert, erzwinge Init...");
            window._snapshotFirstLoad = false;
            
            if (typeof window.initializePageSpecificCode === 'function') {
                // Lade Daten manuell
                getDoc(window.assignmentsDocRef).then(docSnap => {
                    const rawData = docSnap.exists() ? docSnap.data() : {};
                    const bossPatchesPayload = rawData._rosterPatches;
                    const bossPatches = (bossPatchesPayload && bossPatchesPayload.patches) ? bossPatchesPayload.patches : {};
                    window.RosterPatches.setBossPatches(bossId, bossPatches);
                    
                    const assignments = { ...rawData };
                    delete assignments._rosterPatches;
                    
                    const effectiveRoster = window.RosterPatches.buildEffectiveRoster(window.rosterData || [], bossId);
                    // Autoplaner-Variante: ohne Bench (außer Bench-mit-Patch)
                    window.effectiveRoster = window.RosterPatches.buildEffectiveRoster(
                        window.rosterData || [], bossId, { excludeBench: true }
                    );
                    window.currentBossIdForPatches = bossId;
                    
                    if (typeof window.updateRosterPatchBanner === 'function') {
                        window.updateRosterPatchBanner(bossId);
                    }
                    
                    window.initializePageSpecificCode(assignments, effectiveRoster, window.firebaseTools, window.allCooldowns);
                    
                    // applyValues inline
                    document.querySelectorAll('.assignment-select').forEach(select => {
                        const assignmentId = select.dataset.assignmentId;
                        if(!assignmentId) return;
                        const val = assignments[assignmentId] ? (assignments[assignmentId].cooldown || assignments[assignmentId].player) : "";
                        if (select.value !== val) select.value = val;
                        const selectedOption = Array.from(select.options).find(o => o.value === val);
                        select.style.color = selectedOption ? (selectedOption.dataset.color || '#fff') : '#fff';
                    });
                    document.querySelectorAll('.assignment-text-input').forEach(input => {
                        const assignmentId = input.dataset.assignmentId;
                        if(!assignmentId) return;
                        const val = assignments[assignmentId]?.text || assignments[assignmentId]?.player || '';
                        if (input.value !== val) input.value = val;
                    });
                    
                    if(window.toggleSelectEditability) window.toggleSelectEditability();
                    if(typeof window.updateAssignmentPools === 'function') window.updateAssignmentPools();
                });
            }
        }
    }, 500);
};

// =============================================================================
// ALIAS-MAP (Spielernamen umbenennen)
// =============================================================================

function loadAndDisplayAliasMap(aliasMap) {
    const tableBody = document.getElementById('alias-table-body');
    if (!tableBody) return;

    tableBody.innerHTML = ''; // Liste leeren
    if (Object.keys(aliasMap).length === 0) {
        tableBody.innerHTML = '<tr><td colspan="3" class="px-4 py-3 text-gray-500 text-center">Keine Aliase gespeichert.</td></tr>';
        return;
    }

    // Nach dem Original-Namen sortieren
    const sortedAliases = Object.entries(aliasMap).sort((a, b) => a[0].localeCompare(b[0]));

    sortedAliases.forEach(([originalName, replacementName]) => {
        const row = tableBody.insertRow();
        row.innerHTML = `
            <td class="px-4 py-3 font-mono">${originalName}</td>
            <td class="px-4 py-3 font-mono font-bold text-jade">${replacementName}</td>
            <td class="px-4 py-3 text-right">
                <button class="alias-edit-btn text-sm text-blue-400 hover:underline" data-original="${originalName}" data-replacement="${replacementName}">Bearbeiten</button>
                <button class="alias-delete-btn text-sm text-red-500 hover:underline ml-2" data-original="${originalName}">Löschen</button>
            </td>
        `;
    });

    // Event Listener für die neuen Buttons
    tableBody.querySelectorAll('.alias-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteAlias(btn.dataset.original));
    });
    tableBody.querySelectorAll('.alias-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('alias-original').value = btn.dataset.original;
            document.getElementById('alias-replacement').value = btn.dataset.replacement;
            document.getElementById('alias-original').focus();
        });
    });
}

/**
 * Speichert ein neues Alias oder aktualisiert ein bestehendes.
 */
async function handleAddOrUpdateAlias(event) {
    event.preventDefault(); // <-- DIESER BEFEHL VERHINDERT DAS NEULADEN DER SEITE
    if (!window.isManager) return;

    const originalInput = document.getElementById('alias-original');
    const replacementInput = document.getElementById('alias-replacement');
    const originalName = originalInput.value.trim();
    const replacementName = replacementInput.value.trim();

    if (!originalName || !replacementName) {
        window.showModal("Beide Felder werden benötigt.");
        return;
    }

    const newAliasMap = { ...globalAliasMap }; // Kopie der aktuellen Map
    newAliasMap[originalName] = replacementName; // Hinzufügen oder Überschreiben

    try {
        await setDoc(aliasDocRef, { aliases: newAliasMap }, { merge: true });
        window.showModal(`Alias für '${originalName}' wurde gespeichert.`);
        originalInput.value = '';
        replacementInput.value = '';
    } catch (error) {
        console.error("Fehler beim Speichern des Alias:", error);
        window.showModal("Fehler beim Speichern.");
    }
}

/**
 * Löscht ein Alias aus der Liste.
 */
async function handleDeleteAlias(originalName) {
    if (!window.isManager) return;

    const confirmed = await window.showModal(`Soll das Alias für '${originalName}' wirklich gelöscht werden?`, true);
    if (!confirmed) return;

    const newAliasMap = { ...globalAliasMap };
    delete newAliasMap[originalName]; // Eintrag aus der Kopie löschen

    try {
        await setDoc(aliasDocRef, { aliases: newAliasMap }); // Die gesamte Map (ohne den gelöschten) neu setzen
        window.showModal(`Alias für '${originalName}' wurde gelöscht.`);
    } catch (error) {
        console.error("Fehler beim Löschen des Alias:", error);
        window.showModal("Fehler beim Löschen.");
    }
}

window.loadAndDisplayAliasMap = loadAndDisplayAliasMap;
window.handleAddOrUpdateAlias = handleAddOrUpdateAlias;
window.handleDeleteAlias = handleDeleteAlias;


// =============================================================================
// BENCH-HELPER — Bench-Spieler sind alle ab Index 25 in window.rosterData.
//                 Diese Helper werden von allen Spieler-Dropdowns genutzt.
// =============================================================================

/** Anzahl Raid-Slots (5 Gruppen × 5 Spieler) */
const RAID_PLAYER_COUNT = 25;

/**
 * Prüft anhand des aktuellen Rosters, ob ein Spieler auf der Bench sitzt.
 * @param {string} playerName
 * @returns {boolean}
 */
function isPlayerOnBench(playerName) {
    if (!window.rosterData || !Array.isArray(window.rosterData)) return false;
    const idx = window.rosterData.findIndex(p => p && p.name === playerName);
    return idx >= RAID_PLAYER_COUNT;
}
window.isPlayerOnBench = isPlayerOnBench;

/**
 * Teilt eine Spielerliste in Raid-Spieler und Bench-Spieler (in Roster-Reihenfolge).
 * Berücksichtigt: wenn ein Spieler in window.rosterData ab Index 25 steht, ist er Bench.
 * @param {Array} players
 * @returns {{raid: Array, bench: Array}}
 */
function splitPlayersByBench(players) {
    const raid = [];
    const bench = [];
    for (const p of players) {
        if (isPlayerOnBench(p.name)) bench.push(p);
        else raid.push(p);
    }
    return { raid, bench };
}
window.splitPlayersByBench = splitPlayersByBench;

/**
 * Erstellt eine <option> für einen Spieler. Bench-Spieler bekommen ein ⚠️ Präfix
 * und ein data-bench Attribut für CSS-Targeting.
 * @param {object} player
 * @param {boolean} isBench
 * @returns {HTMLOptionElement}
 */
function createPlayerOption(player, isBench) {
    const option = document.createElement('option');
    const color = (window.classColors && window.classColors[player.class.toUpperCase()]) || '#FFFFFF';
    option.value = player.name;
    option.textContent = isBench ? `⚠️ ${player.name}` : player.name;
    option.style.color = color;
    option.dataset.color = color;
    if (isBench) {
        option.dataset.bench = '1';
        option.style.fontStyle = 'italic';
    }
    return option;
}
window.createPlayerOption = createPlayerOption;

/**
 * String-Variante für innerHTML-Patterns. Baut komplettes Options-HTML
 * mit Raid-Spielern und (falls vorhanden) Bench-Section mit Trenner.
 * @param {Array} players       Spielerliste (kann vorgefiltert sein)
 * @param {string} selectedName Aktuell ausgewählter Name (für `selected`)
 * @returns {string}            HTML-Snippet (ohne führende -- wählen -- Option)
 */
function buildPlayerOptionsHtml(players, selectedName = '') {
    const { raid, bench } = splitPlayersByBench(players);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    const renderOne = (player, isBench) => {
        const color = (window.classColors && window.classColors[player.class.toUpperCase()]) || '#FFFFFF';
        const sel = player.name === selectedName ? 'selected' : '';
        const label = isBench ? `⚠️ ${esc(player.name)}` : esc(player.name);
        const style = isBench
            ? `color: ${color}; font-style: italic;`
            : `color: ${color};`;
        const bench = isBench ? 'data-bench="1"' : '';
        return `<option value="${esc(player.name)}" style="${style}" ${bench} ${sel}>${label}</option>`;
    };

    let html = raid.map(p => renderOne(p, false)).join('');
    if (bench.length > 0) {
        html += `<option disabled style="background-color:#1a202c; color:#facc15; font-weight:bold;">── BENCH ──</option>`;
        html += bench.map(p => renderOne(p, true)).join('');
    }
    return html;
}
window.buildPlayerOptionsHtml = buildPlayerOptionsHtml;


// =============================================================================
// fetchRoster — lädt das aktuelle Roster + Bench, abonniert onSnapshot
// =============================================================================

async function fetchRoster() {
    try {
        const rosterSnap = await getDoc(rosterDocRef);
        window.rosterData = rosterSnap.exists() ? rosterSnap.data().roster || [] : [];
        console.log("Roster geladen:", window.rosterData.length, "Spieler");
    } catch (error) {
        console.error("Fehler beim Laden des Rosters:", error);
        window.rosterData = [];
    }
}
window.populateDropdownOptions = function(selectElement, players, bossId) {
    // Standard-Option (Wichtig: data-color für Reset auf Weiß)
    selectElement.innerHTML = '<option value="" data-color="#FFFFFF">-- Spieler wählen --</option>';

    // Spieler in Raid + Bench trennen
    const { raid: raidPlayers, bench: benchPlayers } = splitPlayersByBench(players);

    // 3a. RAID-SPIELER
    if (raidPlayers.length > 0) {
        const divider3 = document.createElement('option');
        divider3.textContent = '── SPIELER ──';
        divider3.disabled = true;
        divider3.style.backgroundColor = '#1a202c';
        divider3.style.fontWeight = 'bold';
        divider3.style.color = '#fbbf24'; // Gold
        selectElement.appendChild(divider3);

        raidPlayers.forEach(player => {
            selectElement.appendChild(createPlayerOption(player, false));
        });
    }

    // 3b. BENCH-SPIELER — eigene Sektion mit Trenner, weiterhin wählbar
    if (benchPlayers.length > 0) {
        const dividerBench = document.createElement('option');
        dividerBench.textContent = '── BENCH ──';
        dividerBench.disabled = true;
        dividerBench.style.backgroundColor = '#1a202c';
        dividerBench.style.fontWeight = 'bold';
        dividerBench.style.color = '#facc15'; // Bench-Gelb (etwas heller als Spieler-Gold)
        selectElement.appendChild(dividerBench);

        benchPlayers.forEach(player => {
            selectElement.appendChild(createPlayerOption(player, true));
        });
    }

    // 1.5 SPEC-SLOTS — werden vom Slot-System bereitgestellt
    // Wenn bossId angegeben ist, wird das Boss-spezifische Mapping verwendet
    // (mit Slot-Overrides aus _rosterPatches.slotOverrides). Sonst global.
    if (window.SlotSystem) {
        const mapping = (bossId && window.RosterPatches && window.RosterPatches.getEffectiveSlotMapping)
            ? window.RosterPatches.getEffectiveSlotMapping(bossId)
            : window.SlotSystem.getMapping();
        const activeSlots = Object.keys(mapping)
            .filter(k => window.SlotSystem.isSlotKey(k))
            .sort();

        if (activeSlots.length > 0) {
            const dividerSlots = document.createElement('option');
            dividerSlots.textContent = '── SPEC-SLOTS ──';
            dividerSlots.disabled = true;
            dividerSlots.style.backgroundColor = '#1a202c';
            dividerSlots.style.fontWeight = 'bold';
            dividerSlots.style.color = '#fbbf24';
            selectElement.appendChild(dividerSlots);

            activeSlots.forEach(slotKey => {
                const opt = document.createElement('option');
                const mappedName = mapping[slotKey];
                const meta = window.SlotSystem.parseSlotKey(slotKey);

                let color = '#FFFFFF';
                if (mappedName) {
                    const player = players.find(p => p.name === mappedName);
                    if (player) color = window.classColors[player.class.toUpperCase()] || '#FFFFFF';
                } else if (meta) {
                    color = window.classColors[meta.class] || '#FFFFFF';
                }

                opt.value = slotKey;
                opt.textContent = mappedName ? `${slotKey} (${mappedName})` : `${slotKey} (—)`;
                opt.style.color = color;
                opt.dataset.color = color;
                selectElement.appendChild(opt);
            });
        }
    }

    // 1. SPEZIAL-GRUPPEN — ALL + Rollen-Aliase
    const specialGroups = ['ALL', 'TANKS', 'HEALERS', 'MELEEDPS', 'RANGEDDPS'];
    const divider1 = document.createElement('option');
    divider1.textContent = '── GRUPPEN ──';
    divider1.disabled = true;
    divider1.style.backgroundColor = '#1a202c';
    divider1.style.fontWeight = 'bold';
    divider1.style.color = '#fbbf24'; // Gold
    selectElement.appendChild(divider1);

    specialGroups.forEach(grp => {
        const opt = document.createElement('option');
        opt.value = grp;
        opt.textContent = grp;
        opt.style.color = '#fcd34d'; // Gold für Rollen-Aliase
        opt.dataset.color = '#fcd34d';
        selectElement.appendChild(opt);
    });

    // 2. KLASSEN
    const divider2 = document.createElement('option');
    divider2.textContent = '── KLASSEN ──';
    divider2.disabled = true;
    divider2.style.backgroundColor = '#1a202c';
    divider2.style.fontWeight = 'bold';
    divider2.style.color = '#fbbf24'; // Gold
    selectElement.appendChild(divider2);

    const classes = ['DEATHKNIGHT', 'DRUID', 'HUNTER', 'MAGE', 'MONK', 'PALADIN', 'PRIEST', 'ROGUE', 'SHAMAN', 'WARLOCK', 'WARRIOR'];

    classes.forEach(cls => {
        const opt = document.createElement('option');
        opt.value = cls; // Wert in DB
        opt.textContent = cls.charAt(0) + cls.slice(1).toLowerCase(); // Schöne Anzeige (Priest)
        const color = window.classColors[cls] || '#FFFFFF';
        opt.style.color = color;
        opt.dataset.color = color;
        selectElement.appendChild(opt);
    });


};
        window.classColors = { 'DEATHKNIGHT': '#C41F3B', 'DK': '#C41F3B', 'DRUID': '#FF7D0A', 'HUNTER': '#AAD372', 'MAGE': '#3FC7EB', 'MONK': '#00FF96', 'PALADIN': '#F48CBA', 'PRIEST': '#FFFFFF', 'ROGUE': '#FFF569', 'SHAMAN': '#0070DD', 'WARLOCK': '#8788EE', 'WARRIOR': '#C69B6D', 'TANK': '#A3A3A3' };
        const wowClasses = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'DEATHKNIGHT', 'SHAMAN', 'MAGE', 'WARLOCK', 'MONK', 'DRUID'];
window.wowClasses = wowClasses;

		const cooldownIconMap = {
		// Priester
		"Machtwort: Barriere": "spell_holy_powerwordbarrier.jpg",
		"Gotteshymne": "spell_holy_divinehymn.jpg",
		"Schutzgeist": "spell_holy_guardianspirit.jpg",
		"Schmerzunterdrückung": "spell_holy_painsupression.jpg",
		// Paladin
		"Aurenmeisterschaft": "spell_holy_auramastery.jpg",
		"Handauflegung": "spell_holy_layonhands.jpg",
		"Hand der Aufopferung": "spell_holy_handofsacrifice.jpg",
		"Göttlicher Schutz": "spell_holy_divineprotection.jpg",
		"Wächter der uralten Könige": "spell_paladin_guardianofancientkings.jpg",
		// Schamane
		"Geistverbindungstotem": "spell_shaman_spiritlinktotem.jpg",
		"Heilflut-Totem": "spell_shaman_healingtide.jpg",
		"Aszendenz (Heilung)": "spell_fire_elementaldevastation.jpg",
		// Druide
		"Gelassenheit": "spell_nature_tranquility.jpg",
		"Anregen": "spell_nature_lightning.jpg",
		"Eisenborke": "ability_druid_ironbark.jpg",
		"Überlebensinstinkte": "ability_druid_tigersroar.jpg",
		// Mönch
		"Beleben": "ability_monk_revival.jpg",
		"Lebenskokon": "ability_monk_lifecocoon.jpg",
		"Stärkendes Gebräu": "ability_monk_fortifyingale.jpg",
		"Schaden dämpfen": "ability_monk_dampenharm.jpg",
		"Zen-Meditation": "ability_monk_zenmeditation.jpg",
		// Krieger
		"Schildwall": "ability_warrior_shieldwall.jpg",
		"Letztes Gefecht": "spell_holy_ashestoashes.jpg",
		"Anspornender Schrei": "ability_warrior_rallyingcry.jpg",
		"Demoralisierendes Banner": "ability_warrior_demoralizingbanner.jpg",
		// Todesritter
		"Anti-Magische Zone": "spell_deathknight_antimagiczone.jpg",
		"Eisige Gegenwehr": "spell_deathknight_iceboundfortitude.jpg",
		"Antimagische Hülle": "spell_shadow_antimagicshell.jpg",
		"Vampirblut": "spell_deathknight_vampiricblood.jpg",
		"Knochenschild": "ability_deathknight_boneshield.jpg",
		"Tanzende Runenwaffe": "inv_sword_62.jpg",
		// Schurke
		"Rauchbombe": "ability_rogue_smokebomb.jpg"
	};
		const wowheadIconUrlBase = "https://wow.zamimg.com/images/wow/icons/small/";

window.fetchRoster = fetchRoster;

// =============================================================================
// COMP-SEITEN-LOGIK (displayRoster, Player-Karten, Player-Edit-Modal)
// =============================================================================

        // ============== COMP LOGIK (HELFERFUNKTIONEN) ==============
        function getPlayerInfoFromEntry(playerEntry) {
            const originalName = playerEntry.name;
            if (window.globalAliasMap[originalName]) {
                playerEntry.name = window.globalAliasMap[originalName]; // Ersetze den Namen direkt im Eingabeobjekt
            }
            let playerClass = playerEntry.class ? playerEntry.class.toUpperCase() : 'UNKNOWN';
            if (playerClass === 'DK') playerClass = 'DEATHKNIGHT';
            let spec = playerEntry.spec;
            const specToClassMap = { 'Guardian': 'DRUID', 'Blood': 'DEATHKNIGHT', 'Protection': 'WARRIOR', 'Protection1': 'PALADIN', 'Brewmaster': 'MONK' };
            if ((playerClass === 'TANK' || specToClassMap[spec]) && spec) {
                const classFromSpec = specToClassMap[spec];
                if (classFromSpec) playerClass = classFromSpec;
            }
            const tankSpecs = ['Guardian', 'Blood_Tank', 'Protection', 'Protection1', 'Brewmaster','Blood'];
            const healerSpecs = ['Restoration', 'Restoration1', 'Discipline', 'Holy', 'Holy1', 'Mistweaver'];
            let role = 'DPS';
            if (tankSpecs.includes(spec)) role = 'TANK';
            else if (healerSpecs.includes(spec)) role = 'HEALER';
            return { name: playerEntry.name, class: playerClass, roles: [role], spec: spec, id: crypto.randomUUID() };
        }

function displayRoster(roster) {
    const container = document.getElementById('roster-groups-container');
    const benchContainer = document.getElementById('roster-bench');
    
    if (!container || !benchContainer) return;

    container.innerHTML = '';
    benchContainer.innerHTML = '';

    const GROUPS_COUNT = 5;
    const PLAYERS_PER_GROUP = 5;

    // Helper: Smart-Swap Logik
    const handleSortableEnd = (evt) => {
        const targetList = evt.to;
        const sourceList = evt.from;

        // Wir greifen nur ein, wenn:
        // 1. Wir in eine Gruppe gedroppt haben (nicht auf die Bank)
        // 2. Wir VON WOANDERS kamen (nicht innerhalb der gleichen Gruppe sortiert haben)
        // 3. Die Gruppe jetzt ÜBERFÜLLT ist (> 5 Spieler)
        if (targetList.id.startsWith('group-list-') && targetList !== sourceList) {
            
            if (targetList.children.length > PLAYERS_PER_GROUP) {
                // Hier ist der Trick:
                // evt.newIndex ist die Position, wo der NEUE Spieler gelandet ist.
                // Alle Spieler DANACH sind um eins nach unten gerutscht.
                // Der Spieler, der VORHER an dieser Stelle war, ist jetzt also an (newIndex + 1).
                
                const cards = Array.from(targetList.children);
                const droppedIndex = evt.newIndex;
                let cardToSwapOut = null;

                // Fall A: Wir haben mitten rein oder am Anfang gedroppt
                // -> Der Spieler UNTER uns (newIndex + 1) ist der, den wir "verdrängt" haben.
                if (droppedIndex < cards.length - 1) {
                    cardToSwapOut = cards[droppedIndex + 1];
                } 
                // Fall B: Wir haben ganz unten angehängt
                // -> Wir wollen den Spieler verdrängen, der VORHER der letzte war (jetzt vor uns).
                else {
                    cardToSwapOut = cards[droppedIndex - 1];
                }

                // Den verdrängten Spieler zurück zum Absender schicken (Tausch)
                if (cardToSwapOut) {
                    // Animation für den Tausch (optional, aber schick)
                    cardToSwapOut.style.transition = "transform 0.3s";
                    // Wir hängen ihn an die Quell-Liste an.
                    // (SortableJS hat den neuen Spieler schon aus der Quell-Liste entfernt, also ist dort Platz)
                    sourceList.appendChild(cardToSwapOut);
                }
            }
        }
        
        // Datenbank aktualisieren
        saveRosterOrder();
    };

    // 1. Gruppen erstellen
    for (let i = 1; i <= GROUPS_COUNT; i++) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'roster-group';
        groupDiv.innerHTML = `<div class="group-header">Gruppe ${i}</div>`;
        
        const listDiv = document.createElement('div');
        listDiv.className = 'group-player-list flex-1';
        listDiv.dataset.groupIndex = i;
        listDiv.id = `group-list-${i}`;
        
        groupDiv.appendChild(listDiv);
        container.appendChild(groupDiv);

        new Sortable(listDiv, {
            group: 'roster',
            animation: 150,
            ghostClass: 'sortable-ghost',
            disabled: !window.isManager,
            onEnd: handleSortableEnd // HIER ist die neue Logik
        });
    }

    // 2. Bank konfigurieren
    new Sortable(benchContainer, {
        group: 'roster',
        animation: 150,
        ghostClass: 'sortable-ghost',
        disabled: !window.isManager,
        onEnd: handleSortableEnd
    });

    // 3. Spieler verteilen (Initiale Ansicht)
    roster.forEach((player, index) => {
        const playerCard = createCompactPlayerCard(player);
        const groupNum = Math.floor(index / PLAYERS_PER_GROUP) + 1;

        if (groupNum <= GROUPS_COUNT) {
            document.getElementById(`group-list-${groupNum}`).appendChild(playerCard);
        } else {
            benchContainer.appendChild(playerCard);
        }
    });
    
    window.toggleCompEditability();
}
function createCompactPlayerCard(player) {
    const div = document.createElement('div');
    // Platzhalter-Logik
    div.className = `player-card ${player.isPlaceholder ? 'is-placeholder' : ''}`;
    div.dataset.playerId = player.id; 
    div.dataset.playerJson = JSON.stringify(player);

    if (player.isPlaceholder) {
        div.innerHTML = `<span class="player-name-compact text-center w-full">Leerer Platz</span>`;
        return div;
    }

    // Rollen-Icons generieren
    const roles = ['TANK', 'HEALER', 'DPS'];
    const icons = { TANK: 'fa-shield-alt', HEALER: 'fa-heart', DPS: 'fa-khanda' };

    let rolesHtml = '<div class="role-icon-group">';
    roles.forEach(role => {
        const isActive = player.roles.includes(role);
        const activeClass = isActive ? `active-${role.toLowerCase()}` : '';
        const disabledClass = window.isManager ? '' : 'disabled';
        rolesHtml += `<i class="fas ${icons[role]} role-toggle-icon ${activeClass} ${disabledClass}" 
                         data-role="${role}" data-player-id="${player.id}"></i>`;
    });
    rolesHtml += '</div>';

    const color = window.classColors[player.class.toUpperCase()] || '#FFFFFF';
    const className = player.class.charAt(0) + player.class.slice(1).toLowerCase();

    // HTML Aufbau der Karte
    div.innerHTML = `
        <div class="flex items-center w-full">
            ${rolesHtml}
            <span class="player-name-compact" style="color: ${color};">${player.name}</span>
            <span class="text-[10px] text-gray-500 uppercase ml-2 tracking-wider opacity-70">${className}</span>
        </div>
    `;
    
    // --- EVENT LISTENER ---
    if (window.isManager) {
        // 1. Rollen umschalten (Klick auf Icons)
        div.querySelectorAll('.role-toggle-icon').forEach(icon => {
            icon.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePlayerRole(icon.dataset.playerId, icon.dataset.role);
            });
        });

        // 2. WICHTIG: Doppelklick öffnet jetzt das MODAL (nicht mehr prompt)
        div.addEventListener('dblclick', (e) => {
            e.stopPropagation(); // Verhindert Bubbling
            openPlayerEditModal(player);
        });
        
        // Optional: Cursor-Hinweis beim Hover für Manager
        div.title = "Doppelklick zum Bearbeiten (Name/Klasse)";
    }

    return div;
}
async function saveRosterOrder() {
    if (!window.isManager) return;

    const newRoster = [];
    const PLAYERS_PER_GROUP = 5;
    
    // 1. Gruppen 1-5 durchgehen und Lücken füllen
    for (let i = 1; i <= 5; i++) {
        const list = document.getElementById(`group-list-${i}`);
        if (!list) continue;

        // Nur ECHTE Spieler aus der Gruppe holen (Platzhalter ignorieren wir beim Einlesen, wir generieren neue)
        const cards = Array.from(list.querySelectorAll('.player-card'));
        const realPlayersInGroup = cards
            .map(c => JSON.parse(c.dataset.playerJson))
            .filter(p => !p.isPlaceholder);

        // Echte Spieler hinzufügen
        newRoster.push(...realPlayersInGroup);

        // Auffüllen bis 5 Slots, falls nötig
        const missingSlots = PLAYERS_PER_GROUP - realPlayersInGroup.length;
        for (let j = 0; j < missingSlots; j++) {
            newRoster.push({
                id: `placeholder-${i}-${j}-${Date.now()}`, // Unique ID
                name: "Leerer Platz",
                class: "UNKNOWN",
                roles: [],
                isPlaceholder: true
            });
        }
    }

    // 2. Bench (Bank) hinzufügen (ohne Platzhalter, nur echte Spieler)
    const bench = document.getElementById('roster-bench');
    if (bench) {
        const benchCards = Array.from(bench.querySelectorAll('.player-card'));
        const realBenchPlayers = benchCards
            .map(c => JSON.parse(c.dataset.playerJson))
            .filter(p => !p.isPlaceholder);
        
        newRoster.push(...realBenchPlayers);
    }

    // 3. Speichern
    try {
        await setDoc(rosterDocRef, { roster: newRoster }, { merge: true });
    } catch (e) {
        console.error("Save Error:", e);
        window.showModal("Fehler beim Speichern.");
    }
}

        window.toggleSelectEditability = function() {
            document.querySelectorAll('.assignment-select').forEach(el => { el.disabled = !window.isManager; });
        };
        window.toggleCompEditability = function() {
            if(!document.getElementById('import-btn')) return;
            document.querySelectorAll('#import-btn, #add-player-btn, #clear-roster-btn, #import-url-btn, .editable-name, .editable-class-select, .role-btn').forEach(el => { el.disabled = !window.isManager; });
        };

        async function handlePlayerUpdate(event, playerId, field) {
            if (!window.isManager) return;
            const docSnap = await getDoc(rosterDocRef);
            if (!docSnap.exists()) return;

            const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
            let roster = docSnap.data().roster || [];
            const playerIndex = roster.findIndex(p => p.id === playerId);
            if (playerIndex === -1) return;

            const oldPlayer = {...roster[playerIndex]};
            const newValue = event.target.value.trim();

            if (field === 'name' && newValue === '') {
                const deletedPlayerName = oldPlayer.name;
                roster.splice(playerIndex, 1);
                await updateDoc(rosterDocRef, { roster: roster });
                window.logHistory('Roster', 'Spieler gelöscht', deletedPlayerName, currentManager);
                window.showModal(`Spieler '${deletedPlayerName}' wurde gelöscht.`);
            } else {
                roster[playerIndex][field] = newValue;
                await updateDoc(rosterDocRef, { roster: roster });
                const changeText = field === 'name' ? `umbenannt in ${newValue}` : `Klasse geändert zu ${newValue}`;
                window.logHistory('Roster', `${oldPlayer.name} ${changeText}`, '', currentManager);
            }
        }
let currentPlayerIdToEdit = null;

// Event Listener für Buttons im Modal

// ══ Spec-Definitionen pro Klasse ══
// Diese Struktur matcht die Raidhelper-specNames (inkl. Suffixe wie "Holy1")
const CLASS_SPECS = {
    DEATHKNIGHT: [
        { name: 'Blood',    role: 'TANK' },
        { name: 'Frost1',   role: 'DPS'  },
        { name: 'Unholy',   role: 'DPS'  }
    ],
    DRUID: [
        { name: 'Balance',      role: 'DPS'    },
        { name: 'Feral',        role: 'DPS'    },
        { name: 'Guardian',     role: 'TANK'   },
        { name: 'Restoration',  role: 'HEALER' }
    ],
    HUNTER: [
        { name: 'Beastmastery', role: 'DPS' },
        { name: 'Marksmanship', role: 'DPS' },
        { name: 'Survival',     role: 'DPS' }
    ],
    MAGE: [
        { name: 'Arcane', role: 'DPS' },
        { name: 'Fire',   role: 'DPS' },
        { name: 'Frost',  role: 'DPS' }
    ],
    MONK: [
        { name: 'Brewmaster', role: 'TANK'   },
        { name: 'Mistweaver', role: 'HEALER' },
        { name: 'Windwalker', role: 'DPS'    }
    ],
    PALADIN: [
        { name: 'Holy1',        role: 'HEALER' },
        { name: 'Protection1',  role: 'TANK'   },
        { name: 'Retribution',  role: 'DPS'    }
    ],
    PRIEST: [
        { name: 'Discipline', role: 'HEALER' },
        { name: 'Holy',       role: 'HEALER' },
        { name: 'Shadow',     role: 'DPS'    }
    ],
    ROGUE: [
        { name: 'Assassination', role: 'DPS' },
        { name: 'Combat',        role: 'DPS' },
        { name: 'Subtlety',      role: 'DPS' }
    ],
    SHAMAN: [
        { name: 'Elemental',     role: 'DPS'    },
        { name: 'Enhancement',   role: 'DPS'    },
        { name: 'Restoration1',  role: 'HEALER' }
    ],
    WARLOCK: [
        { name: 'Affliction',  role: 'DPS' },
        { name: 'Demonology',  role: 'DPS' },
        { name: 'Destruction', role: 'DPS' }
    ],
    WARRIOR: [
        { name: 'Arms',        role: 'DPS'  },
        { name: 'Fury',        role: 'DPS'  },
        { name: 'Protection',  role: 'TANK' }
    ]
};
 

let isAddingNewPlayer = false;
 
function populateClassDropdown(classSelect) {
    if (classSelect.options.length > 0) return;  // Schon befüllt
    const classes = Object.keys(CLASS_SPECS);
    classes.forEach(cls => {
        const opt = document.createElement('option');
        opt.value = cls;
        opt.textContent = cls.charAt(0) + cls.slice(1).toLowerCase();
        opt.style.color = window.classColors[cls];
        opt.style.fontWeight = "bold";
        classSelect.appendChild(opt);
    });
}

function populateSpecDropdown(className, specSelect, selectedSpec) {
    specSelect.innerHTML = '';
    const specs = CLASS_SPECS[className] || [];
    specs.forEach(spec => {
        const opt = document.createElement('option');
        opt.value = spec.name;
        // Anzeige ohne Zahl-Suffix für User
        const displayName = spec.name.replace(/1$/, '');
        opt.textContent = displayName + ' (' + spec.role + ')';
        opt.dataset.role = spec.role;
        specSelect.appendChild(opt);
    });
    // Vorauswahl
    if (selectedSpec) {
        specSelect.value = selectedSpec;
    } else if (specs.length > 0) {
        specSelect.value = specs[0].name;  // Erste Spec als Default
    }
}
 
function autoSetRoleFromSpec(specSelect, roleSelect) {
    const opt = specSelect.options[specSelect.selectedIndex];
    if (opt && opt.dataset.role) {
        roleSelect.value = opt.dataset.role;
    }
}
 
function openPlayerEditModal(player) {
    if (!window.isManager) return;
 
    const modal = document.getElementById('player-edit-modal');
    const titleEl = document.getElementById('player-edit-modal-title');
    const nameInput = document.getElementById('edit-player-name-input');
    const classSelect = document.getElementById('edit-player-class-select');
    const specSelect = document.getElementById('edit-player-spec-select');
    const roleSelect = document.getElementById('edit-player-role-select');
    
    isAddingNewPlayer = !player;
    currentPlayerIdToEdit = player ? player.id : null;
 
    titleEl.textContent = isAddingNewPlayer ? 'Neuer Spieler' : 'Spieler bearbeiten';
    nameInput.value = player ? player.name : '';
 
    populateClassDropdown(classSelect);
 
    // Klasse setzen
    const currentClass = (player && player.class) ? player.class.toUpperCase() : 'WARRIOR';
    classSelect.value = currentClass;
    classSelect.style.color = window.classColors[currentClass] || '#fff';
 
    // Spec-Dropdown basierend auf Klasse füllen
    populateSpecDropdown(currentClass, specSelect, player ? player.spec : null);
 
    // Rolle setzen
    if (player && player.roles && player.roles[0]) {
        roleSelect.value = (player.roles[0]).toString().toUpperCase();
    } else {
        autoSetRoleFromSpec(specSelect, roleSelect);
    }
 
    // ── Klassen-Änderung: Spec-Dropdown neu befüllen ──
    classSelect.onchange = function() {
        this.style.color = window.classColors[this.value] || '#fff';
        populateSpecDropdown(this.value, specSelect, null);
        autoSetRoleFromSpec(specSelect, roleSelect);
    };
 
    // ── Spec-Änderung: Rolle automatisch setzen ──
    specSelect.onchange = function() {
        autoSetRoleFromSpec(this, roleSelect);
    };
 
    modal.classList.remove('hidden');
    nameInput.focus();
}
 
function closePlayerEditModal() {
    const modal = document.getElementById('player-edit-modal');
    modal.classList.add('hidden');
    currentPlayerIdToEdit = null;
    isAddingNewPlayer = false;
}
 
// Event Listener für Buttons im Modal
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-cancel-player-edit')?.addEventListener('click', closePlayerEditModal);
    
    document.getElementById('btn-save-player-edit')?.addEventListener('click', async () => {
        if (!window.isManager) return;
 
        const newName = document.getElementById('edit-player-name-input').value.trim();
        const newClass = document.getElementById('edit-player-class-select').value;
        const newSpec = document.getElementById('edit-player-spec-select').value;
        const newRole = document.getElementById('edit-player-role-select').value;
 
        if (!newName && !isAddingNewPlayer) {
            // Leerer Name beim Edit = Löschen
            const docSnap = await getDoc(rosterDocRef);
            if (docSnap.exists()) {
                let roster = docSnap.data().roster || [];
                const idx = roster.findIndex(p => p.id === currentPlayerIdToEdit);
                if (idx > -1) {
                    const oldName = roster[idx].name;
                    const confirmed = await window.showModal(`Soll der Spieler '${oldName}' wirklich gelöscht werden?`, true);
                    if (confirmed) {
                        roster.splice(idx, 1);
                        await updateDoc(rosterDocRef, { roster: roster });
                        const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
                        window.logHistory('Roster', `Spieler gelöscht (via Edit)`, oldName, currentManager);
                        window.showModal(`Spieler '${oldName}' wurde entfernt.`);
                    }
                }
            }
            closePlayerEditModal();
            return;
        }
 
        if (!newName) {
            window.showModal("Bitte einen Namen eingeben.");
            return;
        }
 
        const docSnap = await getDoc(rosterDocRef);
        let roster = docSnap.exists() ? (docSnap.data().roster || []) : [];
        const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
 
        if (isAddingNewPlayer) {
            // ── NEUER SPIELER ──
            const newPlayer = {
                id: crypto.randomUUID(),
                name: newName,
                class: newClass,
                spec: newSpec,
                roles: [newRole]
            };
            roster.push(newPlayer);
            await setDoc(rosterDocRef, { roster: roster }, { merge: true });
            window.logHistory('Roster', `Spieler hinzugefügt`, `${newName} (${newClass}/${newSpec})`, currentManager);
            window.showModal(`'${newName}' wurde als ${newClass}/${newSpec} hinzugefügt.`);
        } else {
            // ── BESTEHENDEN SPIELER UPDATE ──
            const idx = roster.findIndex(p => p.id === currentPlayerIdToEdit);
            if (idx > -1) {
                const oldName = roster[idx].name;
                roster[idx].name = newName;
                roster[idx].class = newClass;
                roster[idx].spec = newSpec;
                roster[idx].roles = [newRole];
                await updateDoc(rosterDocRef, { roster: roster });
                window.logHistory('Roster', `Spieler bearbeitet (${oldName})`, `${newName} / ${newClass} / ${newSpec} / ${newRole}`, currentManager);
            }
        }
 
        closePlayerEditModal();
    });
});

async function togglePlayerRole(playerId, roleToToggle) {
    if (!window.isManager) return;
    
    // Aktuelles Roster laden (um sicherzugehen, dass wir nicht mit alten Daten arbeiten)
    const docSnap = await getDoc(rosterDocRef);
    if (!docSnap.exists()) return;

    const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
    let roster = docSnap.data().roster || [];
    const playerIndex = roster.findIndex(p => p.id === playerId);
    
    if (playerIndex === -1) return;

    const player = roster[playerIndex];
    let changeText = '';

    // Prüfen, ob Rolle schon da ist
    const roleIndex = player.roles.indexOf(roleToToggle);

    if (roleIndex > -1) {
        // Rolle entfernen (nur wenn es nicht die letzte ist)
        if (player.roles.length > 1) {
            player.roles.splice(roleIndex, 1);
            changeText = `Rolle ${roleToToggle} entfernt`;
        } else {
            // Optional: Feedback, dass man die letzte Rolle nicht löschen kann
            console.warn("Kann letzte Rolle nicht entfernen.");
            return; 
        }
    } else {
        // Rolle hinzufügen
        player.roles.push(roleToToggle);
        changeText = `Rolle ${roleToToggle} hinzugefügt`;
    }

    // Speichern
    if (changeText) {
        await updateDoc(rosterDocRef, { roster: roster });
        // Loggen (optional, kann bei vielen Klicks spammen)
        // window.logHistory('Roster', changeText, player.name, currentManager);
    }
}

window.getPlayerInfoFromEntry = getPlayerInfoFromEntry;
window.displayRoster = displayRoster;
window.createCompactPlayerCard = createCompactPlayerCard;
window.saveRosterOrder = saveRosterOrder;
window.handleAddPlayer = handleAddPlayer;
window.handleClearRoster = handleClearRoster;
window.handlePlayerUpdate = handlePlayerUpdate;
window.populateClassDropdown = populateClassDropdown;
window.populateSpecDropdown = populateSpecDropdown;
window.autoSetRoleFromSpec = autoSetRoleFromSpec;
window.openPlayerEditModal = openPlayerEditModal;
window.closePlayerEditModal = closePlayerEditModal;
window.togglePlayerRole = togglePlayerRole;

// =============================================================================
// IMPORT-ROSTER & BUFF-/SOULSTONE-ZUWEISUNG
// =============================================================================

// ============== COMP SETUP & EXPORT MANAGER ==============

// 1. Setup SPEICHERN
window.saveCompSetup = async function(slotId) {
    if (!window.isManager) return window.showModal("Nur Manager können Setups speichern.");
    
    if (!window.rosterData || window.rosterData.length === 0) {
        return window.showModal("Roster ist leer.");
    }

    const setupDocRef = window.firebaseTools.doc(window.firebaseTools.db, "raid-tool-data", `comp-setup-${slotId}`);
    const currentLabel = document.getElementById(`setup-label-${slotId}`)?.textContent || String(slotId);
    
    const dataToSave = { 
        roster: window.rosterData,
        label: currentLabel,
        savedBy: sessionStorage.getItem('currentManager'),
        savedAt: new Date().toISOString()
    };

    try {
        await window.firebaseTools.updateDoc(setupDocRef, dataToSave).catch(async (err) => {
            const { setDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
            await setDoc(setupDocRef, dataToSave);
        });

        window.showModal(`✅ Setup ${slotId} gespeichert!`);
    } catch (e) {
        console.error(e);
        window.showModal("Fehler beim Speichern: " + e.message);
    }
};

// 2. Setup LADEN
window.loadCompSetup = async function(slotId) {
    if (!window.isManager) return window.showModal("Nur Manager können Setups laden.");

    const confirmed = await window.showModal(`Möchtest du Setup ${slotId} laden? Dies überschreibt die aktuelle Aufstellung für ALLE.`, true);
    if (!confirmed) return;

    try {
        const setupDocRef = window.firebaseTools.doc(window.firebaseTools.db, "raid-tool-data", `comp-setup-${slotId}`);
        const snap = await window.firebaseTools.getDoc(setupDocRef);

        if (!snap.exists()) {
            return window.showModal(`Setup ${slotId} ist leer.`);
        }

        const data = snap.data();
        
        // Wir überschreiben das Live-Roster
        // Da das Index.html Script auf Änderungen an 'currentRoster' lauscht,
        // aktualisiert sich die Anzeige bei allen Clients automatisch.
        const rosterDocRef = window.firebaseTools.doc(window.firebaseTools.db, "raid-tool-data", "currentRoster");
        
        // Import updateDoc/setDoc falls nötig (da module scope)
        const { setDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        
        await setDoc(rosterDocRef, { roster: data.roster }, { merge: true });
        
        window.showModal(`Setup ${slotId} erfolgreich geladen!`);

    } catch (e) {
        console.error(e);
        window.showModal("Fehler beim Laden: " + e.message);
    }
};

// 3. EXPORT (Nur Namen, nach Gruppen sortiert)
window.exportSimpleComp = function() {
    let output = "";
    let count = 0;

    // Wir iterieren durch die DOM-Gruppen, um die visuelle Reihenfolge exakt abzubilden
    for (let i = 1; i <= 8; i++) { // Bis zu 8 Gruppen unterstützen
        const groupList = document.getElementById(`group-list-${i}`);
        if (!groupList) continue;

        const cards = groupList.querySelectorAll('.player-card');
        if (cards.length > 0) {
            cards.forEach(card => {
                // Wir holen den Namen aus dem span Element
                const nameSpan = card.querySelector('.player-name-compact');
                if (nameSpan) {
                    output += nameSpan.textContent.trim() + "\n";
                    count++;
                }
            });
        }
    }

    if (output === "") {
        return window.showModal("Keine Spieler gefunden.");
    }

    // In Zwischenablage
    navigator.clipboard.writeText(output).then(() => {
        window.showModal(`📋 ${count} Namen in die Zwischenablage kopiert!`);
    }).catch(err => {
        console.error('Konnte nicht kopieren: ', err);
        window.showModal("Kopieren fehlgeschlagen. Siehe Konsole.");
    });
};
async function handleImportRoster() {
            if (!window.isManager) return;
            const jsonString = document.getElementById('json-input').value;
            if (!jsonString) return window.showModal("Bitte JSON einfügen.");
            try {
                const data = JSON.parse(jsonString);
                

                const rawSlots = data.slots || data.signUps || data.raidDrop;

                if (!rawSlots || !Array.isArray(rawSlots)) {
                    throw new Error("Ungültiges JSON: 'slots' Array fehlt (V4 Format nicht erkannt).");
                }

                const newRoster = rawSlots.map(slot => {

                    if (slot.signupType === 'absent' || slot.spec === 'Absence') return null;

                    return getPlayerInfoFromEntry({
                        name: slot.name,
                        class: slot.className || slot.class, 
                        spec: slot.specName || slot.spec,
                        // Zusätzliche Infos mitnehmen, falls nötig
                        id: slot.id,
                        group: slot.groupNumber,
                        status: slot.isConfirmed || slot.signupType
                    });
                }).filter(p => p !== null); // Leere Einträge entfernen


                await setDoc(rosterDocRef, { roster: newRoster, rawJson: jsonString });
                
                const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
                window.logHistory('Roster', `Importiert`, `${newRoster.length} Spieler`, currentManager);
                window.showModal(`Roster mit ${newRoster.length} Spielern importiert!`);
                
                // Ansicht neu laden, damit die Spieler sofort sichtbar sind
                if (typeof window.renderCurrentState === 'function') window.renderCurrentState();

            } catch (error) {
                console.error(error);
                window.showModal("Fehler beim Verarbeiten des JSON: " + error.message);
            }
        }

        async function handleAddPlayer() {
            if (!window.isManager) return;
            // Statt prompt: öffne das Edit-Modal im "Add"-Modus
            openPlayerEditModal(null);
        }

        async function handleClearRoster() {
            if (!window.isManager) return;
            const confirmed = await window.showModal("Sollen wirklich alle Spieler aus dem Roster entfernt werden?", true);
            if (confirmed) {
                await setDoc(rosterDocRef, { roster: [], rawJson: '' });
                document.getElementById('json-input').value = '';
                const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
                window.logHistory('Roster', 'Geleert', '', currentManager);
                window.showModal("Roster wurde geleert.");
            }
        }

async function initBuffAssignments(roster) {
    const container = document.getElementById('offensive-buff-assignments');
    if (!container) return;

    const assignmentsDocRef = doc(db, DATA_COLLECTION, "comp-buff-assignments");
    const assignmentsSnap = await getDoc(assignmentsDocRef);
    const assignments = assignmentsSnap.exists() ? assignmentsSnap.data() : {};

    let html = '';
    for (const buffName in offensiveBuffsForAssignment) {
        const availableClasses = offensiveBuffsForAssignment[buffName];
        const eligiblePlayers = roster.filter(p => availableClasses.includes(p.class));
        const selectedPlayerName = assignments[`${buffName}_player`] || '';

        const optionsHtml = buildPlayerOptionsHtml(eligiblePlayers, selectedPlayerName);

        html += `
            <div class="assignment-block">
                <ul class="assignment-list">
                    <li style="grid-template-columns: 1.5fr 1.2fr 1fr;">
                        <span class="font-semibold text-gray-300">${buffName}</span>
                        <select class="assignment-select buff-player-select text-like-select" data-buff-name="${buffName}" ${!window.isManager ? 'disabled' : ''}>
                            <option value="">-- Spieler wählen --</option>
                            ${optionsHtml}
                        </select>
                        <span class="buff-source-text text-sm text-gray-400 pl-2"></span>
                    </li>
                </ul>
            </div>
        `;
    }
    container.innerHTML = html;

    // Nach dem Erstellen der HTML-Struktur, die Zustände wiederherstellen
    container.querySelectorAll('.buff-player-select').forEach(select => {
        select.addEventListener('change', (e) => handleBuffPlayerChange(e, roster));
        
        // Initialen Zustand (Farbe und Buff-Quelle) setzen
        const selectedOption = select.options[select.selectedIndex];
        if (selectedOption && selectedOption.value) {
            const player = roster.find(p => p.name === selectedOption.value);
            if (player) {
                const buffName = select.dataset.buffName;
                const buffSource = getBuffSource(buffName, player.class);
                const sourceSpan = select.nextElementSibling;
                sourceSpan.textContent = `(${buffSource})`;
                select.style.color = window.classColors[player.class.toUpperCase()] || '#FFFFFF';
                // Bench-Spieler auch im geschlossenen Select kursiv hervorheben
                select.style.fontStyle = isPlayerOnBench(player.name) ? 'italic' : 'normal';
            }
        } else {
             select.style.color = '#FFFFFF';
             select.style.fontStyle = 'normal';
        }
    });
}

async function handleBuffPlayerChange(event, roster) {
    if (!window.isManager) return;
    const select = event.target;
    const buffName = select.dataset.buffName;
    const playerName = select.value;

    // 1. Zuweisung speichern
    const assignmentsDocRef = doc(db, DATA_COLLECTION, "comp-buff-assignments");
    await setDoc(assignmentsDocRef, { [`${buffName}_player`]: playerName }, { merge: true });

    // 2. Buff-Quelle und Farbe aktualisieren
    const sourceSpan = select.nextElementSibling;
    if (playerName) {
        const player = roster.find(p => p.name === playerName);
        if (player) {
            sourceSpan.textContent = `(${getBuffSource(buffName, player.class)})`;
            select.style.color = window.classColors[player.class.toUpperCase()] || '#FFFFFF';
            select.style.fontStyle = isPlayerOnBench(player.name) ? 'italic' : 'normal';
        }
    } else {
        sourceSpan.textContent = '';
        select.style.color = '#FFFFFF';
        select.style.fontStyle = 'normal';
    }
}
async function initSoulstoneAssignments(roster) {
    const container = document.getElementById('soulstone-assignments');
    if (!container) return;

    const warlocks = roster.filter(p => p.class === 'WARLOCK');

    if (warlocks.length === 0) {
        container.innerHTML = '';
        return;
    }

    const assignmentsDocRef = doc(db, DATA_COLLECTION, "comp-soulstone-assignments");
    const assignmentsSnap = await getDoc(assignmentsDocRef);
    const assignments = assignmentsSnap.exists() ? assignmentsSnap.data() : {};

    let warlockRowsHtml = '';
    warlocks.forEach(warlock => {
        const assignmentId = `soulstone_for_${warlock.name.replace(/\s/g, '_')}`;
        const selectedTargetName = assignments[assignmentId] || '';

        // Dropdown mit ALLEN Spielern als Ziel füllen (mit Bench-Section unten)
        const targetOptionsHtml = buildPlayerOptionsHtml(roster, selectedTargetName);

        warlockRowsHtml += `
            <li style="grid-template-columns: 1fr 2fr; align-items: baseline;">
                <span style="color: ${window.classColors.WARLOCK};">${warlock.name}'s Seelenstein:</span>
                
                <select class="assignment-select soulstone-target-select text-like-select" data-assignment-id="${assignmentId}" ${!window.isManager ? 'disabled' : ''}>
                    <option value="" style="color: #FFFFFF;">-- Ziel wählen --</option>
                    ${targetOptionsHtml}
                </select>
            </li>
        `;
    });
    
    container.innerHTML = `
        <div class="assignment-block">
            <h4 class="text-lg font-bold">Seelenstein-Vergabe</h4>
            <ul class="assignment-list">${warlockRowsHtml}</ul>
        </div>
    `;

    // Nach dem Erstellen der HTML-Struktur die Zustände (Farbe) wiederherstellen
    container.querySelectorAll('.soulstone-target-select').forEach(select => {
        select.addEventListener('change', (e) => handleSoulstoneAssignmentChange(e, roster));
        
        const selectedOption = select.options[select.selectedIndex];
        if (selectedOption && selectedOption.value) {
            const player = roster.find(p => p.name === selectedOption.value);
            select.style.color = player ? (window.classColors[player.class.toUpperCase()] || '#FFFFFF') : '#FFFFFF';
        } else {
             select.style.color = '#FFFFFF';
        }
    });
}

async function handleSoulstoneAssignmentChange(event, roster) {
    if (!window.isManager) return;
    const select = event.target;
    const playerName = select.value;
    const assignmentId = select.dataset.assignmentId;
    
    // 1. Zuweisung speichern (Debounced)
    const assignmentsDocRef = doc(db, DATA_COLLECTION, "comp-soulstone-assignments");
    if (!window.pendingSSUpdates) window.pendingSSUpdates = {};
    window.pendingSSUpdates[assignmentId] = playerName;
    
    if (window.ssUpdateTimer) clearTimeout(window.ssUpdateTimer);
    window.ssUpdateTimer = setTimeout(async () => {
        const payload = window.pendingSSUpdates;
        window.pendingSSUpdates = {};
        if (Object.keys(payload).length > 0) {
            await setDoc(assignmentsDocRef, payload, { merge: true });
        }
    }, 1500);

    // 2. Farbe des Select-Elements aktualisieren
    if (playerName) {
        const player = roster.find(p => p.name === playerName);
        select.style.color = player ? (window.classColors[player.class.toUpperCase()] || '#FFFFFF') : '#FFFFFF';
    } else {
        select.style.color = '#FFFFFF';
    }
}
function getBuffSource(buffName, playerClass) {
    const buffData = raidBuffsClassesMap[buffName];
    if (buffData && buffData.classes && buffData.classes[playerClass]) {
        // Gibt den ersten verfügbaren Buff-Namen für die Klasse zurück (für den Fall, dass es mal mehrere gäbe)
        const source = buffData.classes[playerClass];
        return Array.isArray(source) ? source[0] : source;
    }
    return playerClass.toLowerCase(); // Fallback
}
function updateBuffPlayerDropdown(buffName, selectedClass, roster, selectedPlayer = '') {
    const playerSelect = document.querySelector(`.buff-player-select[data-buff-name="${buffName}"]`);
    if (!playerSelect) return;

    playerSelect.innerHTML = '<option value="">-- Spieler --</option>';
    if (!selectedClass) return;

    const playersOfClass = roster.filter(p => p.class === selectedClass);
    playersOfClass.forEach(player => {
        const option = new Option(player.name, player.name);
        if (player.name === selectedPlayer) {
            option.selected = true;
        }
        playerSelect.appendChild(option);
    });
}
async function handleBuffAssignmentChange(buffName, field, value) {
    if (!window.isManager) return;
    const assignmentsDocRef = doc(db, DATA_COLLECTION, "comp-buff-assignments");
    const key = `${buffName}_${field}`;

    if (!window.pendingBuffUpdates) window.pendingBuffUpdates = {};
    window.pendingBuffUpdates[key] = value;
    
    if (field === 'class') {
        window.pendingBuffUpdates[`${buffName}_player`] = "";
    }

    if (window.buffUpdateTimer) clearTimeout(window.buffUpdateTimer);
    window.buffUpdateTimer = setTimeout(async () => {
        const payload = window.pendingBuffUpdates;
        window.pendingBuffUpdates = {};
        if (Object.keys(payload).length > 0) {
            await setDoc(assignmentsDocRef, payload, { merge: true });
        }
    }, 1500);
}

// Hilfsfunktionen für die Event Listener
function handleBuffClassChange(event, roster) {
    const select = event.target;
    const buffName = select.dataset.buffName;
    const selectedClass = select.value;
    updateBuffPlayerDropdown(buffName, selectedClass, roster);
    handleBuffAssignmentChange(buffName, 'class', selectedClass);
}

window.handleImportRoster = handleImportRoster;
window.initBuffAssignments = initBuffAssignments;
window.handleBuffPlayerChange = handleBuffPlayerChange;
window.initSoulstoneAssignments = initSoulstoneAssignments;
window.handleSoulstoneAssignmentChange = handleSoulstoneAssignmentChange;
window.getBuffSource = getBuffSource;
window.updateBuffPlayerDropdown = updateBuffPlayerDropdown;
window.handleBuffAssignmentChange = handleBuffAssignmentChange;
window.handleBuffClassChange = handleBuffClassChange;

// =============================================================================
// RAID-BUFFS, SPIELER ERSETZEN, PLAYER-SUMMARY
// =============================================================================

        // ============== RAID BUFF LOGIK ==============
        const raidBuffsClassesMap = {
            // Offensive Buffs
            "5% Stärke, Beweglichkeit, Intelligenz": { classes: { "PALADIN": "Segen der Könige", "DRUID": "Mal der Wildnis", "MONK": "Vermächtnis des Kaisers", "HUNTER": "Umarmung der Schieferkrabbe (Pet)" } },
            "10% Angriffskraft": { classes: { "DEATHKNIGHT": "Horn des Winters", "HUNTER": "Volltreffer Aura", "WARRIOR": "Kampfruf" } },
            "10% Angriffsgeschwindigkeit": { classes: { "DEATHKNIGHT": "Unheilige Aura", "HUNTER": ["Kicherndes Heulen (Hyänen-Pet)", "Schlangenschnelligkeit (Schlangen-Pet)"], "ROGUE": "List des Schnellklinglers", "SHAMAN": "Entfesselte Wut" } },
            "3000 Meisterschaft": { classes: { "HUNTER": ["Brüllen des Mutes (Katzen-Pet)", "Segen des Geisterbestien (Geisterbestien-Pet)"], "PALADIN": "Segen der Macht", "SHAMAN": "Anmut der Luft" } },
            "5% Kritische Trefferchance": { classes: { "DRUID": "Rudelführer", "HUNTER": ["Furchterregendes Brüllen (Wolfs-Pet)", "Ruhiges Wasser (Wasserläufer-Pet)"], "MAGE": "Arkane Brillanz", "MONK": "Vermächtnis des Weißen Tigers", "PRIEST": "Inneres Feuer" } },
            "10% Zaubermacht": { classes: { "HUNTER": "Ruhiges Wasser (Wasserläufer-Pet)", "MAGE": "Arkane Brillanz", "SHAMAN": "Brennender Zorn", "WARLOCK": "Dunkle Absicht" } },
            "5% Zaubertempo": { classes: { "DRUID": "Mondkingestalt", "HUNTER": "Gedankenstärkung (Sporensegler-Pet)", "PRIEST": "Schattenform", "SHAMAN": "Elementar" } },
            // Defensive Buffs
            "10% Ausdauer": { classes: { "HUNTER": "Qiraji-Standhaftigkeit (Silithiden-Pet)", "PRIEST": "Machtwort: Seelenstärke", "WARLOCK": "Dunkle Absicht", "WARRIOR": "Befehlsruf" } },
            "-10% physischer Schaden (Weakened Blows)": { classes: { "DEATHKNIGHT": "Scharlachrotes Fieber (Blut)", "DRUID": "Verwüsten", "HUNTER": ["Demoralisierendes Gebrüll (Bären-Pet)", "Demoralisierender Schrei (Aasvogel-Pet)"], "MONK": "Fass-Sturm (Braumeister)", "PALADIN": "Hammer des Rechtschaffenen (Schutz/Vergeltung)", "SHAMAN": "Erdbeben (Elementar/Verstärkung)", "WARLOCK": "Fluch der Entkräftung", "WARRIOR": "Donnerknall" } },
            // Debuffs (für Gegner)
            "+4% erlittener physischer Schaden (Physical Vulnerability)": { classes: { "DEATHKNIGHT": ["Spröde Knochen (Frost/Unheilig)", "Ebonplaguesprenger (Frost/Unheilig)"], "HUNTER": ["Gore (Eber-Pet)", "Stampede (Nashorn-Pet)", "Säurespucke (Wurm-Pet)", "Verwüsten (Schreiter-Pet)"], "PALADIN": "Urteile des Kühnen (Vergeltung)", "WARRIOR": "Kolossales Zerschmettern (Waffen/Furor)" } },
            "-4% Rüstung (Weakened Armor)": { classes: { "DRUID": "Feenfeuer", "HUNTER": ["Rüstung zerreißen (Raptoren-Pet)", "Staubwolke (Langbein-Pet)"], "ROGUE": "Rüstung zerreißen", "WARRIOR": ["Rüstung zerreißen (Waffen/Furor)", "Verwüsten (Schutz)"] } },
            "+5% erlittener Zauberschaden": { classes: { "HUNTER": ["Feueratem (Drachenfalken-Pet)", "Blitzatem (Windnatter-Pet)"], "ROGUE": "Meistergiftmischer", "WARLOCK": "Fluch der Elemente" } },
            "Heilungsreduktion (Mortal Wounds)": { classes: { "HUNTER": ["Witwengift", "Monströser Biss (Teufelssaurier-Pet)"], "MONK": "Aufsteigende Sonnenkick (Windläufer)", "ROGUE": "Wundgift", "WARRIOR": ["Tödlicher Stoß (Waffen/Furor)", "Wilder Stoß (Waffen/Furor)"] } },
            "Zaubergeschwindigkeitsreduktion": { classes: { "DEATHKNIGHT": "Nekrotischer Stoß", "HUNTER": ["Lava-Atem (Kernhund-Pet)", "Sporenwolke (Sporebat-Pet)"], "MAGE": "Verlangsamen (Arkan)", "ROGUE": "Gedankenbenebelndes Gift", "WARLOCK": "Fluch der Entkräftung" } },
            // Raid Cooldowns
            "Blutdurst/Heldentum": { classes: { "SHAMAN": "Heldentum", "MAGE": "Zeitkrümmung", "HUNTER": "Uralte Hysterie (Exotisches Kernelementar-Pet)" } },
            "Schädelfahne": { classes: { "WARRIOR": "Schädelbanner" } },
            "Sturmhagel-Totem": { classes: { "SHAMAN": "Totem der Sturmpeitsche" } },
            "Antimagische Zone": { classes: { "DEATHKNIGHT": "Antimagische Zone" } },
            "Demoralisierende Standarte": { classes: { "WARRIOR": "Demoralisierendes Banner" } },
            "Hingabe-Aura": { classes: { "PALADIN": "Hingabe-Aura" } },
            "Machtwort: Barriere": { classes: { "PRIEST": "Machtwort: Barriere" } },
            "Sammelruf": { classes: { "WARRIOR": "Schlachtruf" } },
            "Rauchbombe": { classes: { "ROGUE": "Rauchbombe" } },
            "Geisterverbindungstotem": { classes: { "SHAMAN": "Geisterverbindungstotem" } }
        };

        window.updateRaidBuffsDisplay = function(roster) {
            if (!roster) return;

            const rosterClassCounts = {};
            roster.forEach(player => {
                const playerClass = player.class.toUpperCase();
                rosterClassCounts[playerClass] = (rosterClassCounts[playerClass] || 0) + 1;
            });

            document.querySelectorAll('.buff-item').forEach(buffItem => {
                const buffName = buffItem.dataset.buffName;
                const buffData = raidBuffsClassesMap[buffName];
                const buffInfoSpan = buffItem.querySelector('.buff-info');
                if (!buffInfoSpan) return;

                let availableCount = 0;
                let tooltipLines = [];

                if (buffData && buffData.classes) {
                    for (const className in buffData.classes) {
                        const countInRoster = rosterClassCounts[className] || 0;
                        if (countInRoster > 0) {
                            availableCount += countInRoster;
                            const classAbility = buffData.classes[className];
                            const abilityNames = Array.isArray(classAbility) ? classAbility : [classAbility];
                            const color = window.classColors[className] || '#FFFFFF';
                            abilityNames.forEach(abilityName => {
                                 tooltipLines.push(`<span style="color: ${color};">${className.charAt(0).toUpperCase() + className.slice(1).toLowerCase()}</span>: ${abilityName}`);
                            });
                        }
                    }
                }

                if (availableCount > 0) {
                    buffItem.classList.remove('opacity-50');
                    buffItem.style.fontWeight = 'bold';
                    buffItem.style.color = 'inherit';
                    buffInfoSpan.textContent = ` (${availableCount})`;
                } else {
                    buffItem.classList.add('opacity-50');
                    buffItem.style.fontWeight = 'normal';
                    buffItem.style.color = '#a0aec0';
                    buffInfoSpan.textContent = ` (0)`;
                }

                buffItem.style.position = 'relative';
                buffItem.style.cursor = 'help';
                
                let tooltipDiv = buffItem.querySelector('.buff-tooltip');
                if (!tooltipDiv) {
                    tooltipDiv = document.createElement('div');
                    tooltipDiv.className = 'buff-tooltip hidden';
                    buffItem.appendChild(tooltipDiv);
                }
                tooltipDiv.innerHTML = tooltipLines.join('<br>');

                buffItem.onmouseover = () => {
                    if (tooltipLines.length > 0) {
                        tooltipDiv.classList.remove('hidden');
                    }
                };
                buffItem.onmouseout = () => {
                    tooltipDiv.classList.add('hidden');
                };
            });
        };
        function showPlayerSummaryView() {
            const displayContainer = document.getElementById('loot-details-display');
            const viewTitle = document.getElementById('loot-view-title');
            if (!displayContainer || !viewTitle) return;

            viewTitle.textContent = "Spieler-Zusammenfassung";
            window.playerSummaryState = {}; // Zustand zurücksetzen
            window.summarySortState = { column: 'total', direction: 'desc' };


        if (window.allLootDocuments.length === 0) {
                const allLootQuery = query(lootCollectionRef, orderBy("raidDate", "desc"));
                getDocs(allLootQuery).then(snapshot => {
                    window.allLootDocuments = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data().lootData }));
                });
        }

            const datesHtml = window.allLootDocuments.map(doc => `
                <label class="flex items-center space-x-2 p-2 rounded-md hover:bg-slate-700 cursor-pointer transition-colors duration-150">
                    <input type="checkbox" data-date-id="${doc.id}" class="summary-date-checkbox form-checkbox h-5 w-5 rounded bg-slate-900 border-slate-600 text-jade-400 focus:ring-jade-400">
                    <span>${new Date(doc.id + 'T12:00:00Z').toLocaleDateString('de-DE', { month: 'long', day: 'numeric' })}</span>
                </label>
            `).join('');

            displayContainer.innerHTML = `
                <div class="flex justify-between items-center mb-4">
                    <p class="text-gray-400">Wähle die Daten aus, die einbezogen werden sollen.</p>
                    <div class="flex gap-2">
                        <button id="summary-select-all-btn" class="text-sm py-1 px-3 rounded-md bg-blue-600 hover:bg-blue-700">Alle</button>
                        <button id="summary-deselect-all-btn" class="text-sm py-1 px-3 rounded-md bg-slate-600 hover:bg-slate-500">Keine</button>
                    </div>
                </div>
                <div id="summary-dates-grid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 mb-6 p-4 bg-slate-900/50 rounded-lg border border-slate-700">
                    ${datesHtml}
                </div>
                <div id="player-summary-results">
                    <p class="text-gray-500 text-center py-4">Bitte mindestens ein Datum auswählen.</p>
                </div>
            `;
            
            // KORREKTUR: Der Listener wird präziser gesetzt, um das Bubbling-Problem zu beheben.
            document.getElementById('summary-dates-grid').addEventListener('change', (event) => {
                if (event.target.classList.contains('summary-date-checkbox')) {
                    handleSummaryDateSelection();
                }
            });
            document.getElementById('summary-select-all-btn')?.addEventListener('click', () => toggleAllSummaryCheckboxes(true));
            document.getElementById('summary-deselect-all-btn')?.addEventListener('click', () => toggleAllSummaryCheckboxes(false));
        }

        function toggleAllSummaryCheckboxes(select) {
            document.querySelectorAll('.summary-date-checkbox').forEach(cb => cb.checked = select);
            handleSummaryDateSelection();
        }

function handleSummaryDateSelection() {
            const selectedDates = Array.from(document.querySelectorAll('.summary-date-checkbox:checked'))
                                       .map(cb => cb.dataset.dateId);

            const oldState = { ...playerSummaryState }; // Den alten Zustand für die offenen Menüs sichern
            window.playerSummaryState = {}; 

            if (selectedDates.length > 0) {
                const filteredLootItems = window.allLootDocuments
                    .filter(doc => selectedDates.includes(doc.id))
                    .flatMap(doc => doc.data);

                filteredLootItems.forEach(item => {
                    if (!item.received || !item.checksum) return; // Sicherstellen, dass ein Checksum vorhanden ist
                    
                    const winner = item.awardedTo.split('-')[0];
                    let rollTypeSource = '';

                    if (item.winningRollType) {
                        rollTypeSource = item.winningRollType;
                    } else {
                        const winningRoll = item.Rolls.find(roll => roll.player === winner);
                        if (winningRoll && winningRoll.classification) {
                            rollTypeSource = winningRoll.classification;
                        } else { return; }
                    }

                    const rollType = rollTypeSource.toUpperCase();
                    let category;
                    
                    if (item.winningRollType === 'Bonus Roll') {
                        category = 'bonusroll';
                    } 
                    // Danach prüfen wir die normalen Roll-Typen.
                    else if (rollType === 'MS') {
                        category = 'ms';
                    } else if (rollType === 'OS') {
                        category = 'os';
                    } else if (['T-MOG', 'TRANSMOG', 'STYLE'].includes(rollType)) {
                        category = 'transmog';
                    } else {
                        return; // Item überspringen, wenn keine Kategorie passt
                    }

                    if (!window.playerSummaryState[winner]) {
                        window.playerSummaryState[winner] = { items: [], isDetailsOpen: oldState[winner]?.isDetailsOpen || false };
                    }
                    
                    window.playerSummaryState[winner].items.push({
                        name: item.itemLink.replace(/[\[\]]/g, ''),
                        id: item.itemID,
                        // KORREKTUR: Wir verwenden item.checksum statt item.itemGUID
                        uniqueId: item.checksum, 
                        category: category,
                        included: true
                    });
                });
            }
            
            drawPlayerSummaryTable();
        }

// ==================== SPIELER ERSETZEN (RAIDWEIT) ====================

window.replacePlayerRaidWide = async function() {
    if (!window.isManager) return window.showModal("Nur Manager dürfen Spieler ersetzen.");

    const selectedRaidId = document.getElementById('raid-selector').value;
    const raidInfo = (typeof window.raidData !== 'undefined') ? window.raidData[selectedRaidId] : null;
    if (!raidInfo || !raidInfo.bosses) return window.showModal("Keine Raid-Daten gefunden.");

    const roster = window.rosterData || [];
    if (roster.length === 0) return window.showModal("Roster ist leer.");

    // --- Spieler-Auswahl Modal bauen ---
    const sortedRoster = [...roster].sort((a, b) => a.name.localeCompare(b.name));
    const optionsHtml = sortedRoster.map(p => {
        const color = window.classColors[p.class.toUpperCase()] || '#FFFFFF';
        return `<option value="${p.name}" style="color:${color}">${p.name}</option>`;
    }).join('');

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-[100] p-4';
    modal.innerHTML = `
        <div class="bg-slate-900 border border-gold-border rounded-lg p-6 max-w-md w-full shadow-2xl">
            <h3 class="text-xl font-bold text-gold mb-4"><i class="fas fa-exchange-alt mr-2"></i>Spieler raidweit ersetzen</h3>
            <p class="text-gray-400 text-sm mb-4">Ersetzt alle Vorkommen eines Spielers bei <strong class="text-gold">${raidInfo.name}</strong> (nur Einteilungen, nicht CD-Planer).</p>
            
            <div class="space-y-3 mb-6">
                <div>
                    <label class="block text-sm font-medium text-red-400 mb-1"><i class="fas fa-user-minus mr-1"></i>Wer fällt aus?</label>
                    <select id="replace-from" class="w-full bg-slate-800 text-white p-2 rounded border border-slate-600 focus:border-gold focus:outline-none">
                        <option value="">-- Spieler wählen --</option>
                        ${optionsHtml}
                    </select>
                </div>
                <div class="text-center text-2xl text-gold">↓</div>
                <div>
                    <label class="block text-sm font-medium text-green-400 mb-1"><i class="fas fa-user-plus mr-1"></i>Wer kommt stattdessen?</label>
                    <select id="replace-to" class="w-full bg-slate-800 text-white p-2 rounded border border-slate-600 focus:border-gold focus:outline-none">
                        <option value="">-- Ersatz wählen --</option>
                        ${optionsHtml}
                    </select>
                </div>
            </div>

            <div id="replace-preview" class="mb-4 max-h-48 overflow-y-auto" style="display:none;"></div>

            <div class="flex gap-3 justify-end">
                <button id="replace-preview-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm transition-colors">
                    <i class="fas fa-search mr-1"></i>Vorschau
                </button>
                <button id="replace-execute-btn" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 px-4 rounded text-sm transition-colors" disabled>
                    <i class="fas fa-check mr-1"></i>Ersetzen
                </button>
                <button id="replace-cancel-btn" class="bg-slate-600 hover:bg-slate-500 text-white font-bold py-2 px-4 rounded text-sm transition-colors">
                    Abbrechen
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // State
    let previewData = null;

    document.getElementById('replace-cancel-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // Vorschau
    document.getElementById('replace-preview-btn').addEventListener('click', async () => {
        const fromPlayer = document.getElementById('replace-from').value;
        const toPlayer = document.getElementById('replace-to').value;
        if (!fromPlayer) return window.showModal("Bitte wähle den Spieler der ausfällt.");
        if (!toPlayer) return window.showModal("Bitte wähle den Ersatzspieler.");
        if (fromPlayer === toPlayer) return window.showModal("Spieler und Ersatz dürfen nicht identisch sein.");

        const previewDiv = document.getElementById('replace-preview');
        previewDiv.style.display = 'block';
        previewDiv.innerHTML = '<p class="text-gray-400 text-sm animate-pulse">Scanne alle Bosse...</p>';

        const bossIds = raidInfo.bosses.map(b => ({ id: b.id, name: b.name, docId: 'boss-' + b.id }));
        const snapshots = await Promise.all(
            bossIds.map(b => getDoc(doc(db, 'raid-tool-data', b.docId)))
        );

        previewData = [];
        snapshots.forEach((snap, idx) => {
            if (!snap.exists()) return;
            const data = snap.data();
            const boss = bossIds[idx];

            Object.keys(data).forEach(key => {
                if (key.includes('-planner-row')) return; // CD-Planer überspringen
                const val = data[key];
                if (val && typeof val === 'object') {
                    if (val.player === fromPlayer || val.cooldown === fromPlayer) {
                        previewData.push({
                            bossDocId: boss.docId,
                            bossName: boss.name,
                            key: key,
                            field: val.player === fromPlayer ? 'player' : 'cooldown',
                            label: formatReplaceLabel(key, boss.id)
                        });
                    }
                }
            });
        });

        if (previewData.length === 0) {
            previewDiv.innerHTML = `<p class="text-amber-400 text-sm"><i class="fas fa-info-circle mr-1"></i>${fromPlayer} ist bei keinem Boss in ${raidInfo.name} eingetragen.</p>`;
            document.getElementById('replace-execute-btn').disabled = true;
        } else {
            const byBoss = {};
            previewData.forEach(e => {
                if (!byBoss[e.bossName]) byBoss[e.bossName] = [];
                byBoss[e.bossName].push(e);
            });

            let html = `<div class="bg-slate-800/60 rounded p-3 border border-slate-700 text-sm">
                <p class="text-green-400 font-bold mb-2"><i class="fas fa-list mr-1"></i>${previewData.length} Einträge gefunden:</p>`;
            for (const [bossName, entries] of Object.entries(byBoss)) {
                html += `<div class="mb-2"><span class="text-gold font-bold text-xs">${bossName}</span>
                    <div class="ml-3 text-xs text-gray-300">${entries.map(e => `<div>• ${e.label}</div>`).join('')}</div></div>`;
            }
            html += '</div>';
            previewDiv.innerHTML = html;
            document.getElementById('replace-execute-btn').disabled = false;
        }
    });

    // Ausführen
    document.getElementById('replace-execute-btn').addEventListener('click', async () => {
        if (!previewData || previewData.length === 0) return;
        const fromPlayer = document.getElementById('replace-from').value;
        const toPlayer = document.getElementById('replace-to').value;
        const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';

        const confirmed = await window.showModal(
            `${previewData.length} Einträge von "${fromPlayer}" werden durch "${toPlayer}" ersetzt. Fortfahren?`, true
        );
        if (!confirmed) return;

        try {
            // Gruppiere Updates nach Boss-Dokument
            const updatesByDoc = {};
            previewData.forEach(entry => {
                if (!updatesByDoc[entry.bossDocId]) updatesByDoc[entry.bossDocId] = {};
                updatesByDoc[entry.bossDocId][entry.key] = {
                    [entry.field]: toPlayer,
                    editor: currentManager,
                    timestamp: serverTimestamp()
                };
            });

            // Batch-Schreiben pro Boss
            const promises = Object.entries(updatesByDoc).map(([docId, updates]) => {
                return setDoc(doc(db, 'raid-tool-data', docId), updates, { merge: true });
            });
            await Promise.all(promises);

            window.logHistory('Raidweit', `Spieler ersetzt: ${fromPlayer} → ${toPlayer}`, `${previewData.length} Einträge`, currentManager);
            modal.remove();
            window.showModal(`Fertig! ${previewData.length} Einträge wurden von "${fromPlayer}" zu "${toPlayer}" geändert.`);

            // Master-View aktualisieren falls sichtbar
            if (typeof window.loadMasterViewData === 'function') {
                setTimeout(window.loadMasterViewData, 500);
            }
        } catch (error) {
            console.error('Replace Error:', error);
            window.showModal('Fehler: ' + error.message);
        }
    });
};

function formatReplaceLabel(key, bossId) {
    let label = key;
    label = label.replace(new RegExp('^' + bossId.replace(/-/g, '[-_]?') + '[-_]?', 'i'), '');
    const shortPrefix = bossId.replace(/-/g, '').substring(0, 4);
    label = label.replace(new RegExp('^' + shortPrefix + '[-_]?', 'i'), '');
    label = label.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    if (label.includes('planner row')) {
        const match = label.match(/planner row(\d+)/);
        if (match) label = `CD-Planer Zeile ${match[1]}`;
    }
    return label.charAt(0).toUpperCase() + label.slice(1);
}

window.manageAllAssignments = async function() {
    if (!window.isManager) return window.showModal("Nur Manager dürfen die Datenbank verwalten.");

    // 1. IMPORTE
    // Wir nehmen Date.now() statt serverTimestamp für Sicherheit bzgl Limits
    const { getFirestore, getDoc, doc, setDoc } 
        = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");

    const db = window.db || getFirestore(); 

    window.showModal("Konsultiere die Geister...", false); 

    const selectedRaidId = document.getElementById('raid-selector').value; 
    const raidInfo = (typeof window.raidData !== 'undefined') ? window.raidData[selectedRaidId] : null;
    
    if (!raidInfo || !raidInfo.bosses) return window.showModal("Keine Raid-Daten gefunden.");

    // 2. DATEN SAMMELN (PARALLEL FÜR GESCHWINDIGKEIT)
    let assignmentMap = {}; 
    const bossIds = raidInfo.bosses.map(b => ({ docId: "boss-" + b.id, name: b.name }));

    try {
        // Alle Bosse gleichzeitig abfragen statt nacheinander (viel schneller)
        const snapshots = await Promise.all(
            bossIds.map(b => getDoc(doc(db, "raid-tool-data", b.docId)))
        );

        snapshots.forEach((snap, index) => {
            if (!snap.exists()) return;
            
            const bossName = bossIds[index].name;
            const bossDocId = bossIds[index].docId;
            const data = snap.data();

            Object.keys(data).forEach(key => {
                // Wir suchen nach Feldern, die auf "-player" enden
                if (key.includes('-planner-row') && key.endsWith('-player')) {
                    const assignedPlayer = data[key].player;
                    
                    if (assignedPlayer && assignedPlayer.trim() !== "") {
                        if (!assignmentMap[assignedPlayer]) assignmentMap[assignedPlayer] = [];
                        
                        const baseKey = key.substring(0, key.lastIndexOf('-player'));
                        
                        // Details auslesen
                        let triggerVal = data[baseKey + '-trigger']?.player || "";
                        triggerVal = triggerVal.replace(/^[A-Z]+_/, '').replace(/_/g, ' ').toLowerCase();
                        
                        const conditionVal = data[baseKey + '-condition']?.text || "";
                        const timeVal = data[baseKey + '-time']?.text || "";
                        const cdVal = data[baseKey + '-cooldown']?.cooldown || "";

                        assignmentMap[assignedPlayer].push({
                            bossId: bossDocId,
                            bossName: bossName,
                            baseKey: baseKey, 
                            playerKey: key,
                            triggerKey: baseKey + '-trigger',
                            trigger: triggerVal,
                            condition: conditionVal,
                            time: timeVal,
                            cd: cdVal
                        });
                    }
                }
            });
        });

    } catch(e) { 
        console.error("Fehler beim Scannen:", e); 
        return window.showModal("Fehler beim Lesen der Schriftrollen: " + e.message);
    }

    // Altes Lade-Modal schließen
    const oldModal = document.querySelector('.fixed.inset-0.z-50');
    if(oldModal && oldModal.textContent.includes("Geister")) oldModal.remove();

    const playersFound = Object.keys(assignmentMap).sort();
    if (playersFound.length === 0) {
        return window.showModal("Die Schriftrollen sind leer. Alles sauber.");
    }

    // 3. HELPER: Detail-HTML bauen
    const buildDetails = (entries) => {
        const byBoss = {};
        entries.forEach(e => {
            if(!byBoss[e.bossName]) byBoss[e.bossName] = [];
            byBoss[e.bossName].push(e);
        });

        let html = `<div class="p-3 bg-black/40 border-t border-emerald-900/50 text-xs font-mono grid gap-3">`;
        
        for (const [bossName, items] of Object.entries(byBoss)) {
            html += `
            <div>
                <h5 class="text-amber-500 font-bold mb-1 border-b border-amber-900/30 pb-0.5">${bossName}</h5>
                <div class="space-y-1">
                    ${items.map(item => `
                        <div class="flex items-center text-gray-400 hover:text-gray-200">
                            <span class="w-24 truncate text-emerald-600/80 mr-2" title="${item.trigger}">${item.trigger || '-'}</span>
                            <span class="w-12 text-center text-gray-500 border-r border-gray-700 mr-2">${item.condition ? item.condition+'%' : (item.time ? item.time+'s' : '-')}</span>
                            <span class="flex-1 text-amber-100/70 truncate">${item.cd || 'Kein CD'}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }
        html += `</div>`;
        return html;
    };

    // 4. UI BAUEN (JADE THEME)
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-[100] p-4';
    
    let listHtml = playersFound.map((pName, index) => {
        const entries = assignmentMap[pName];
        const count = entries.length;
        const detailId = `details-${index}`;
        const iconId = `icon-${index}`;
        
        return `
        <div class="mb-2 rounded border border-emerald-900/40 bg-slate-900/80 overflow-hidden transition-all duration-300" id="row-${pName.replace(/\s/g, '-')}">
            <div class="flex items-center justify-between p-3 cursor-pointer hover:bg-emerald-900/10 transition-colors"
                 onclick="document.getElementById('${detailId}').classList.toggle('hidden'); document.getElementById('${iconId}').classList.toggle('rotate-90');">
                
                <div class="flex items-center gap-3">
                    <i id="${iconId}" class="fas fa-chevron-right text-emerald-600 text-xs transition-transform duration-200"></i>
                    <div>
                        <div class="font-bold text-emerald-400 text-lg drop-shadow-sm">${pName}</div>
                        <div class="text-[10px] text-gray-500 uppercase tracking-widest">${count} Einträge</div>
                    </div>
                </div>

                <div class="flex gap-2" onclick="event.stopPropagation()"> 
                    <button class="px-3 py-1 bg-emerald-950 text-emerald-500 border border-emerald-800/50 rounded hover:bg-emerald-900 hover:text-emerald-200 hover:border-emerald-500 text-xs font-bold transition-all"
                            onclick="window.processPlayerAssignments('${pName}', 'inactive')" title="Trigger entfernen, Name behalten">
                        INAKTIV
                    </button>
                    <button class="px-3 py-1 bg-red-950/40 text-red-500 border border-red-900/50 rounded hover:bg-red-900/60 hover:text-red-300 hover:border-red-600 text-xs font-bold transition-all"
                            onclick="window.processPlayerAssignments('${pName}', 'delete')" title="Komplett entfernen">
                        LÖSCHEN
                    </button>
                </div>
            </div>

            <div id="${detailId}" class="hidden">
                ${buildDetails(entries)}
            </div>
        </div>`;
    }).join('');

    modal.innerHTML = `
        <div class="bg-slate-900 border-2 border-emerald-800/60 shadow-[0_0_50px_rgba(16,185,129,0.1)] rounded-lg max-w-2xl w-full max-h-[85vh] flex flex-col">
            
            <div class="flex justify-between items-center border-b border-emerald-800/30 p-5 bg-gradient-to-r from-slate-900 to-emerald-950/20">
                <div>
                    <h3 class="text-xl font-bold text-emerald-400 tracking-wide font-serif flex items-center gap-2">
                        <i class="fas fa-dragon"></i> Jade Register
                    </h3>
                    <p class="text-emerald-200/40 text-xs mt-1">
                        Alle aktiven Zuweisungen im Überblick.
                    </p>
                </div>
                <span class="px-3 py-1 bg-emerald-900/20 border border-emerald-700/30 rounded text-emerald-400 text-xs font-mono shadow-[0_0_10px_rgba(52,211,153,0.1)]">
                    ${playersFound.length} Champions
                </span>
            </div>
            
            <div class="overflow-y-auto flex-1 p-4 custom-scrollbar space-y-1">
                ${listHtml}
            </div>

            <div class="p-4 border-t border-emerald-800/30 bg-slate-900 flex justify-end">
                <button onclick="this.closest('.fixed').remove()" class="px-5 py-2 text-emerald-600 hover:text-emerald-300 transition-colors text-sm font-bold uppercase tracking-wider">
                    Schließen
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // 5. ACTION HANDLER (OPTIMIERT)
    window.processPlayerAssignments = async (pName, mode) => {
        // Kein serverTimestamp importieren, um Limits zu umgehen
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const db = window.db || getFirestore();

        const entries = assignmentMap[pName];
        if (!entries) return;

        const rowId = `row-${pName.replace(/\s/g, '-')}`;
        const rowEl = document.getElementById(rowId);
        if(rowEl) rowEl.style.opacity = '0.5';

        const updatesByBoss = {};
        const safeTs = Date.now(); // Sicherer Zeitstempel (Keine Rechenoperation für Firebase)

        entries.forEach(entry => {
            if (!updatesByBoss[entry.bossId]) updatesByBoss[entry.bossId] = {};
            
            if (mode === 'inactive') {
                updatesByBoss[entry.bossId][entry.triggerKey] = { player: "", timestamp: safeTs };
            } 
            else if (mode === 'delete') {
                const suffixes = [
                    { key: 'trigger', field: 'player' }, { key: 'player', field: 'player' },
                    { key: 'npc', field: 'player' }, { key: 'cooldown', field: 'cooldown' },
                    { key: 'condition', field: 'text' }, { key: 'time', field: 'text' },      
                    { key: 'note', field: 'text' }, { key: 'tts', field: 'text' },       
                    { key: 'varname', field: 'text' }, { key: 'icon', field: 'text' }       
                ];
                suffixes.forEach(s => {
                    const fullKey = `${entry.baseKey}-${s.key}`;
                    updatesByBoss[entry.bossId][fullKey] = { [s.field]: "", timestamp: safeTs };
                });
            }
        });

        try {
            // Parallel speichern
            const promises = Object.keys(updatesByBoss).map(bid => {
                return setDoc(doc(db, "raid-tool-data", bid), updatesByBoss[bid], { merge: true });
            });
            await Promise.all(promises);

            if(rowEl) {
                rowEl.innerHTML = `<div class="text-center w-full text-emerald-400 font-bold py-4 bg-emerald-900/20"><i class="fas fa-check-circle"></i> Läutert...</div>`;
                setTimeout(() => {
                    rowEl.style.height = '0';
                    rowEl.style.marginBottom = '0';
                    rowEl.style.opacity = '0';
                    setTimeout(() => rowEl.remove(), 300);
                }, 800);
            }
        } catch(e) {
            alert("Fehler: " + e.message);
            if(rowEl) rowEl.style.opacity = '1';
        }
    };
};
function renderPlayerSummary(selectedDates) {
            const resultsContainer = document.getElementById('player-summary-results');
            if (selectedDates.length === 0) {
                resultsContainer.innerHTML = '<p class="text-gray-500 text-center py-4">Bitte mindestens ein Datum auswählen.</p>';
                return;
            }

            const playerStats = {};
            const filteredLootItems = window.allLootDocuments
                .filter(doc => selectedDates.includes(doc.id))
                .flatMap(doc => doc.data);

            filteredLootItems.forEach(item => {
                if (!item.received) return;
                
                const winner = item.awardedTo.split('-')[0];
                let rollTypeSource = '';

                // --- NEUE, INTELLIGENTERE LOGIK ---
                // 1. Versuche, den direkten Typ zu verwenden
                if (item.winningRollType) {
                    rollTypeSource = item.winningRollType;
                } 
                // 2. Wenn das Feld fehlt, finde den Wurf des Gewinners und nutze dessen Klassifizierung
                else {
                    const winningRoll = item.Rolls.find(roll => roll.player === winner);
                    if (winningRoll && winningRoll.classification) {
                        rollTypeSource = winningRoll.classification;
                    } else {
                        // Wenn wir den Typ nicht bestimmen können, überspringe das Item.
                        return;
                    }
                }
                // --- ENDE DER NEUEN LOGIK ---

                const rollType = rollTypeSource.toUpperCase();
                let category;
                // NEU: Bonus Rolls werden zuerst geprüft
                if (item.winningRollType === 'Bonus Roll') {
                    category = 'bonusroll';
                } else if (rollType === 'MS') {
                    category = 'ms';
                } else if (rollType === 'OS') {
                    category = 'os';
                } else if (['T-MOG', 'TRANSMOG', 'STYLE'].includes(rollType)) {
                    category = 'transmog';
                } else {
                    return; // Item überspringen, wenn keine Kategorie passt
                }

                if (!playerStats[winner]) {
                    playerStats[winner] = { ms: 0, os: 0, transmog: 0, total: 0 };
                }

                playerStats[winner][category]++;
                playerStats[winner].total++;
            });

            const statsArray = Object.entries(playerStats).map(([name, stats]) => ({ name, ...stats }));
            statsArray.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

            const tableRows = statsArray.map(player => `
                <tr class="border-b border-slate-700 hover:bg-slate-750/50">
                    <td class="px-4 py-3 font-medium">${player.name}</td>
                    <td class="px-4 py-3 text-center">${player.ms}</td>
                    <td class="px-4 py-3 text-center">${player.os}</td>
                    <td class="px-4 py-3 text-center">${player.transmog}</td>
                    <td class="px-4 py-3 text-center">${player.bonusroll}</td>
                    <td class="px-4 py-3 text-center font-bold text-gold">${player.total}</td>
                </tr>
            `).join('');

            resultsContainer.innerHTML = `
                <div class="overflow-x-auto rounded-lg border border-slate-700">
                    <table class="min-w-full text-sm text-left text-gray-300">
                        <thead class="text-xs text-gray-400 uppercase bg-slate-700">
                            <tr>
                                <th scope="col" class="px-4 py-3">Spieler</th>
                                <th scope="col" class="px-4 py-3 text-center">MS</th>
                                <th scope="col" class="px-4 py-3 text-center">OS</th>
                                <th scope="col" class="px-4 py-3 text-center">Transmog</th>
                                <th scope="col" class="px-4 py-3 text-center">Total</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-700">
                            ${tableRows.length > 0 ? tableRows : '<tr><td colspan="5" class="text-center p-4 text-gray-500">Keine zählbaren Loot-Daten für die Auswahl gefunden.</td></tr>'}
                        </tbody>
                    </table>
                </div>
            `;
        }
function drawPlayerSummaryTable() {
            const resultsContainer = document.getElementById('player-summary-results');
            const players = Object.keys(window.playerSummaryState);

            if (players.length === 0) {
                resultsContainer.innerHTML = '<p class="text-gray-500 text-center py-4">Bitte mindestens ein Datum auswählen.</p>';
                return;
            }

            const statsArray = players.map(name => {
                const includedItems = window.playerSummaryState[name].items.filter(item => item.included);
                return {
                    name: name,
                    ms: includedItems.filter(item => item.category === 'ms').length,
                    os: includedItems.filter(item => item.category === 'os').length,
                    transmog: includedItems.filter(item => item.category === 'transmog').length,
                    bonusroll: includedItems.filter(item => item.category === 'bonusroll').length, // NEU
                    total: includedItems.length
                };
            });
            
            // --- NEU: Sortierlogik ---
            const { column, direction } = window.summarySortState;
            statsArray.sort((a, b) => {
                if (a[column] !== b[column]) {
                    return direction === 'desc' ? b[column] - a[column] : a[column] - b[column];
                }
                // Sekundäre Sortierung nach Total, dann nach Name
                if (b.total !== a.total) return b.total - a.total;
                return a.name.localeCompare(b.name);
            });
            // --- ENDE Sortierlogik ---

            const tableRows = statsArray.map(player => {
                const itemsHtml = window.playerSummaryState[player.name].items.map(item => {
                    const wowheadUrl = `https://www.wowhead.com/mop-classic/item=${item.id}`;
                    return `<div class="flex items-center gap-2 px-2 py-1"><input type="checkbox" class="item-inclusion-checkbox" data-player-name="${player.name}" data-item-id="${item.uniqueId}" ${item.included ? 'checked' : ''}><a href="${wowheadUrl}" target="_blank" rel="noopener noreferrer" class="hover:underline text-sm">[${item.name}]</a><span class="text-xs uppercase bg-slate-600 px-1.5 py-0.5 rounded-full">${item.category}</span></div>`;
                }).join('');
                const isHidden = window.playerSummaryState[player.name].isDetailsOpen ? '' : 'hidden';
                const rotation = window.playerSummaryState[player.name].isDetailsOpen ? 'rotate-90' : '';
                return `<tr class="border-b border-slate-700 hover:bg-slate-750/50">
                                <td class="px-4 py-3 font-medium"><button class="toggle-details-btn flex items-center gap-2" data-player-name="${player.name}">${player.name} <span class="text-xs text-gray-400 transition-transform ${rotation}">▶</span></button></td>
                                <td class="px-4 py-3 text-center">${player.ms}</td>
                                <td class="px-4 py-3 text-center">${player.os}</td>
                                <td class="px-4 py-3 text-center">${player.transmog}</td>
                                <td class="px-4 py-3 text-center">${player.bonusroll}</td> <td class="px-4 py-3 text-center font-bold text-gold">${player.total}</td>
                            </tr>
                            <tr class="item-details-row ${isHidden} bg-slate-800">
                                <td colspan="6" class="p-2"><div class="flex flex-col gap-1">${itemsHtml}</div></td> </tr>`;
                }).join('');

            // --- NEU: Dynamische Kopfzeile mit Sortier-Buttons ---
            const sortableColumns = { 'MS': 'ms', 'OS': 'os', 'Transmog': 'transmog', 'Bonus': 'bonusroll', 'Total': 'total' };
            const headerHtml = Object.entries(sortableColumns).map(([title, key]) => {
                const isActive = window.summarySortState.column === key;
                const indicator = isActive ? (window.summarySortState.direction === 'desc' ? '▼' : '▲') : '';
                return `<th scope="col" class="px-4 py-3 text-center"><button class="sort-btn font-bold uppercase ${isActive ? 'text-gold' : 'text-gray-400'}" data-sort-column="${key}">${title} <span class="indicator w-4 inline-block">${indicator}</span></button></th>`;
            }).join('');

            resultsContainer.innerHTML = `<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="min-w-full text-sm text-left text-gray-300"><thead class="text-xs uppercase bg-slate-700"><tr><th scope="col" class="px-4 py-3">Spieler</th>${headerHtml}</tr></thead><tbody class="divide-y divide-slate-700">${tableRows}</tbody></table></div>`;
            
            // Event Listener hinzufügen
            resultsContainer.querySelectorAll('.toggle-details-btn').forEach(btn => btn.addEventListener('click', handleToggleDetails));
            resultsContainer.querySelectorAll('.item-inclusion-checkbox').forEach(cb => cb.addEventListener('change', handleItemInclusionChange));
            resultsContainer.querySelectorAll('.sort-btn').forEach(btn => btn.addEventListener('click', handleSummarySort));
        }
		function handleSummarySort(event) {
            const newColumn = event.currentTarget.dataset.sortColumn;
            if (window.summarySortState.column === newColumn) {
                // Wenn die selbe Spalte geklickt wird, Richtung umkehren
                window.summarySortState.direction = window.summarySortState.direction === 'desc' ? 'asc' : 'desc';
            } else {
                // Bei Klick auf eine neue Spalte, diese als aktiv setzen und Standardrichtung (desc) wählen
                window.summarySortState.column = newColumn;
                window.summarySortState.direction = 'desc';
            }
            // Tabelle mit neuer Sortierung neu zeichnen
            drawPlayerSummaryTable();
        }

        // ZWEI WEITERE NEUE FUNKTIONEN
function handleToggleDetails(event) {
            const button = event.currentTarget;
            // KORREKTUR: Spielername wird aus data-Attribut gelesen (sicherer)
            const playerName = button.dataset.playerName;
            
            if (window.playerSummaryState[playerName]) {
                // Den Zustand im State-Objekt umschalten
                window.playerSummaryState[playerName].isDetailsOpen = !window.playerSummaryState[playerName].isDetailsOpen;
            }
            
            // Tabelle neu zeichnen, um die Änderung (offen/geschlossen) anzuzeigen
            drawPlayerSummaryTable();
        }

function handleItemInclusionChange(event) {
            const checkbox = event.target;
            const playerName = checkbox.dataset.playerName;
            // KORREKTUR: Wir lesen das data-item-id Attribut
            const itemId = checkbox.dataset.itemId;

            // KORREKTUR: Wir finden das Item anhand der neuen uniqueId Eigenschaft
            const item = window.playerSummaryState[playerName]?.items.find(i => i.uniqueId === itemId);
            if (item) {
                item.included = checkbox.checked;
            }
            drawPlayerSummaryTable();
        }
// In der Datei: index.html, im <script>-Block

window.showPlayerSummaryView = showPlayerSummaryView;
window.toggleAllSummaryCheckboxes = toggleAllSummaryCheckboxes;
window.handleSummaryDateSelection = handleSummaryDateSelection;
window.formatReplaceLabel = formatReplaceLabel;
window.renderPlayerSummary = renderPlayerSummary;
window.drawPlayerSummaryTable = drawPlayerSummaryTable;
window.handleSummarySort = handleSummarySort;
window.handleToggleDetails = handleToggleDetails;
window.handleItemInclusionChange = handleItemInclusionChange;