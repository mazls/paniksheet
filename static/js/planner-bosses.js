/* =========================================================================
   planner-bosses.js — Boss-Seiten, CD-Planner, Discord, Loot, MasterView
   =========================================================================
   Alles, was passiert, wenn ein Boss ausgewählt ist:
   - Planner-Pools (updateAssignmentPools)
   - Globale Cooldown-WeakAura-Export (generateGlobalWaString — sehr groß!)
     mit Helfern buildCdExportForBoss, buildJiKunWaveExport, buildDurumuSpectrumExport, updateCdExport
   - Top-Level handleAssignmentChange (speichert Assignment-Änderungen)
   - URL-Import-Logik (handleImportFromUrl, "ROBUST V4")
   - Cooldown-Stammdaten laden (fetchAllCooldowns)
   - Snapshot-System (save/load/delete/populate)
   - Master-View (alles auf einen Blick)
   - Discord-Webhook + buildDiscordEmbeds
   - History-Seite
   - Loot-Seite (initLootPage, Import, Detail-Anzeige)
   - initBossPage (Sprungmarken, Sektionen, das ganze Boss-Seiten-Setup)
   - Cooldown-Editor (CRUD für CD-Stammdaten)
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

import { state, offensiveBuffsForAssignment, getCurrentRaidId, debounce, debouncedUpdatePools, debouncedUpdateSummary } from './state.js';


// =============================================================================
// PLANNER-CORE: updateAssignmentPools
// =============================================================================

function updateAssignmentPools() {
    const pools = {};
    document.querySelectorAll('[data-assignment-pool]').forEach(select => {
        const poolName = select.dataset.assignmentPool;
        if (!pools[poolName]) {
            pools[poolName] = [];
        }
        pools[poolName].push(select);
    });

    for (const poolName in pools) {
        const selectsInPool = pools[poolName];
        const assignmentsMap = new Map();

        // 1. Setze zuerst alle Optionen in diesem Pool zurück
        selectsInPool.forEach(select => {
            select.querySelectorAll('option').forEach(option => {
                option.disabled = false;
                // Entfernt einen eventuell vorhandenen gelben Punkt
                if (option.textContent.startsWith('🟡 ')) {
                    option.textContent = option.textContent.substring(2);
                }
            });
        });
        
        // 2. Finde heraus, wer wo eingeteilt ist
        selectsInPool.forEach(select => {
            if (select.value) {
                const groupName = select.closest('[data-group-name]')?.dataset.groupName || 'Unbekannt';
                assignmentsMap.set(select.value, groupName);
            }
        });

        // 3. Markiere die bereits eingeteilten Spieler mit einem Punkt
        selectsInPool.forEach(currentSelect => {
            currentSelect.querySelectorAll('option').forEach(option => {
                const playerName = option.value;
                // Prüft, ob der Spieler in einer ANDEREN Gruppe eingeteilt ist
                if (assignmentsMap.has(playerName) && currentSelect.value !== playerName) {
                    // Spieler wird NICHT mehr deaktiviert
                    option.textContent = `🟡 ${option.textContent}`;
                }
            });
        });
    }
}

window.updateAssignmentPools = updateAssignmentPools;

// =============================================================================
// MODUL-EBENE HILFSFUNKTIONEN für Sha / Norushen / LaneGroups-Exports
// — werden sowohl von generateGlobalWaString als auch von buildDiscordEmbeds
//   genutzt. Daher hier außerhalb der Funktionen.
// =============================================================================

// Marker-Lookup für LaneGroups-Anzeige (keine Modul-Abhängigkeit)
const LG_MARKER_BY_ID = {
    '':        { id: '',         label: 'Kein Marker', emoji: '·'  },
    'star':    { id: 'star',     label: 'Star',         emoji: '⭐' },
    'circle':  { id: 'circle',   label: 'Circle',       emoji: '🟠' },
    'diamond': { id: 'diamond',  label: 'Diamond',      emoji: '💜' },
    'triangle':{ id: 'triangle', label: 'Triangle',     emoji: '🔺' },
    'moon':    { id: 'moon',     label: 'Moon',         emoji: '🌙' },
    'square':  { id: 'square',   label: 'Square',       emoji: '🟦' },
    'cross':   { id: 'cross',    label: 'Cross',        emoji: '❌' },
    'skull':   { id: 'skull',    label: 'Skull',        emoji: '💀' }
};

// Spec-Slot oder direkten Spielernamen zu echtem Roster-Namen auflösen.
// Spec-Slot-Keys (über window.SlotSystem) → resolved. Klassen-Wildcards /
// Group-Keys bleiben als Token erhalten.
function resolveSlotOrPlayer(val) {
    if (!val || typeof val !== 'string') return '';
    const ss = window.SlotSystem;
    if (ss && ss.isSlotKey && ss.isSlotKey(val)) {
        const resolved = ss.resolvePlayerName(val, true);
        if (!resolved) return '';
        if (Array.isArray(window.rosterData)) {
            const inRoster = window.rosterData.some(p => p && p.name === resolved);
            if (!inRoster) return '';
        }
        return resolved;
    }
    return val;
}

// Sha-of-Pride 4-Platten Export.
// Liest boss-sha-of-pride.sha-plates.platesData[].{rt, slots}.
// Format pro Platte: "{rtX}-Spieler1,Spieler2" — mehrere Platten durch \n.
function buildShaPlatesExport(data) {
    if (!data) return "";
    const block = data['sha-plates'];
    if (!block || !Array.isArray(block.platesData)) return "";
    const lines = [];
    block.platesData.forEach(plate => {
        if (!plate || !Array.isArray(plate.slots)) return;
        const players = plate.slots
            .map(s => resolveSlotOrPlayer(s))
            .filter(Boolean);
        if (players.length === 0) return;
        const prefix = plate.rt ? `{${plate.rt}}-` : '';
        lines.push(prefix + players.join(','));
    });
    return lines.join('\n');
}

// Norushen Orb-Reihenfolge Export.
// Liest boss-norushen.norushen-orb-order.orderData[].{player, delay}.
// Format: "Spieler1-Delay1,Spieler2-Delay2,..."
function buildNorushenOrbExport(data) {
    if (!data) return "";
    const block = data['norushen-orb-order'];
    if (!block || !Array.isArray(block.orderData)) return "";
    return block.orderData
        .filter(r => r && r.player && r.delay !== '' && r.delay !== null && r.delay !== undefined)
        .map(r => `${resolveSlotOrPlayer(r.player) || r.player}-${r.delay}`)
        .join(',');
}

// Generischer LaneGroups-Export: durchsucht das Firestore-Doc nach allen
// Feldern mit einem `blocks`-Array (LaneGroups-Persistenz-Format) und baut
// einen lesbaren Text-Dump. Spec-Slots werden aufgelöst.
function buildLaneGroupsExport(data) {
    if (!data) return "";
    const sections = [];
    Object.keys(data).forEach(key => {
        const v = data[key];
        if (!v || typeof v !== 'object' || !Array.isArray(v.blocks)) return;
        v.blocks.forEach(block => {
            const blockLines = [];
            (block.lanes || []).forEach((lane, li) => {
                const players = (lane.slots || [])
                    .map(s => resolveSlotOrPlayer(s))
                    .filter(Boolean);
                if (players.length === 0) return;
                let label;
                if (block.type === 'multi-lane') {
                    const m = LG_MARKER_BY_ID[lane.marker || ''] || LG_MARKER_BY_ID[''];
                    if (lane.title) label = `${m.emoji} ${lane.title}`;
                    else if (m.id)  label = `${m.emoji} ${m.label}`;
                    else            label = `Spalte ${li + 1}`;
                } else {
                    label = 'Liste';
                }
                blockLines.push(`  ${label}: ${players.join(', ')}`);
            });
            if (blockLines.length === 0) return;
            sections.push(`${block.title || '(Unbenannt)'}`);
            blockLines.forEach(l => sections.push(l));
            sections.push('');
        });
    });
    return sections.join('\n').trim();
}

// Siegecrafter Black-Iron-Killorder Export.
// Liest boss-siegecrafter.blackfuse-killorder.killOrder = ['Missile','Mine',...]
// Format: 'Missile,Mine,Laser,...' — Tokens, keine Spielernamen → keine Resolution.
function buildSiegecrafterKillorderExport(data) {
    if (!data) return "";
    const block = data['blackfuse-killorder'];
    if (!block) return "";
    let arr = block.killOrder;
    if (!Array.isArray(arr)) {
        if (arr && typeof arr === 'object') arr = Object.values(arr);
        else return "";
    }
    const filtered = arr.filter(s => s && typeof s === 'string' && s.trim());
    return filtered.length > 0 ? filtered.join(',') : "";
}

// Siegecrafter Lines Export (Conveyor-Belt-Teams).
// Liest boss-siegecrafter.blackfuse-lines:
//   teamsData = [{slots:[p1,p2,...]}, {slots:[...]}]  (2 Teams mit Spielern;
//               Legacy-Format: direkte Arrays statt {slots} — beides supported)
//   lineTeams = ['0','1','—',...]                     (welches Team auf welcher Line)
// Format: 'LINE1-Marcel,Sarah,LINE2-Steffi,Niyrana'
function buildSiegecrafterLinesExport(data) {
    if (!data) return "";
    const block = data['blackfuse-lines'];
    if (!block || !Array.isArray(block.teamsData) || !Array.isArray(block.lineTeams)) return "";

    const parts = [];
    block.lineTeams.forEach((teamIdx, l) => {
        if (teamIdx !== '0' && teamIdx !== '1' && teamIdx !== 0 && teamIdx !== 1) return;
        const idx = parseInt(teamIdx);
        const teamRaw = block.teamsData[idx];
        // teamsData[i] kann sein:
        //   {slots: [p1, p2, ...]}        (aktuelles Save-Format)
        //   [p1, p2, ...]                 (Legacy / Fallback)
        //   {0: p1, 1: p2, ...}           (Object-Form aus alten Saves)
        let team = [];
        if (Array.isArray(teamRaw)) {
            team = teamRaw;
        } else if (teamRaw && Array.isArray(teamRaw.slots)) {
            team = teamRaw.slots;
        } else if (teamRaw && typeof teamRaw === 'object') {
            team = Object.values(teamRaw);
        }
        const players = team.map(s => resolveSlotOrPlayer(s)).filter(Boolean);
        if (players.length > 0) parts.push(`LINE${l + 1}-${players.join(',')}`);
    });
    return parts.join(',');
}

// Paragons Killorder Export.
// Liest boss-paragons.paragons-killorder.killOrder = ['Iyyokuk','Skeer',...]
// Format: 'Iyyokuk,Skeer,...' — Boss-Namen, keine Spieler → keine Resolution.
function buildParagonsKillorderExport(data) {
    if (!data) return "";
    const block = data['paragons-killorder'];
    if (!block) return "";
    // killOrder kann als Array oder Object {0:..., 1:..., ...} kommen
    let arr = block.killOrder;
    if (!Array.isArray(arr)) {
        if (arr && typeof arr === 'object') arr = Object.values(arr);
        else return "";
    }
    const filtered = arr.filter(s => s && typeof s === 'string' && s.trim());
    return filtered.length > 0 ? filtered.join(',') : "";
}

// =============================================================================
// GLOBAL WEAKAURA EXPORT (generateGlobalWaString)
// — incl. buildCdExportForBoss, buildJiKunWaveExport, buildDurumuSpectrumExport,
//   updateCdExport (alles innerhalb der einen großen async-Funktion)
// =============================================================================

window.generateGlobalWaString = async function() {
    if (!window.isManager) return window.showModal("Nur Gildenräte können exportieren.");
    if (!window.allCooldowns || window.allCooldowns.length === 0) await fetchAllCooldowns();

    const selectedRaidId = document.getElementById('raid-selector').value;
    const raidInfo = window.raidData[selectedRaidId];
    if (!raidInfo || !raidInfo.bosses) return window.showModal("Keine Daten.");



    // --- 1. ALLE DATEN PARALLEL LADEN ---
    const bossDocIds = raidInfo.bosses.map(b => `boss-${b.id}`);
    const snaps = await Promise.all(bossDocIds.map(b => getDoc(doc(db, "raid-tool-data", b))));
    
    const bossDataMap = {};
    snaps.forEach((snap, idx) => {
        if (snap.exists()) bossDataMap[raidInfo.bosses[idx].id] = snap.data();
    });

    // --- 2. HILFSFUNKTION: CD-Planner Export für einen Boss ---
    function buildCdExportForBoss(bossId, data) {
        let entries = [];
        const npcName = data[`${bossId}-npc_name`]?.text || "Unknown NPC";

        // Boss-spezifisches Slot-Mapping (global + Slot-Overrides aus _rosterPatches)
        const globalMapping = (window.SlotSystem && window.SlotSystem.getMapping)
            ? window.SlotSystem.getMapping() : {};
        const bossSlotOverrides = (data._rosterPatches && data._rosterPatches.slotOverrides) || {};
        const effectiveMapping = { ...globalMapping };
        Object.entries(bossSlotOverrides).forEach(([slotKey, value]) => {
            if (value === null || value === '') {
                delete effectiveMapping[slotKey];
            } else {
                effectiveMapping[slotKey] = value;
            }
        });
        const rosterNamesSet = new Set((window.rosterData || []).map(p => p.name));

        const prefixMap = {
            'immerseus': 'immerseus',
            'fallen-protectors': 'protectors',
            'norushen': 'norushen',
            'sha-of-pride': 'sha-of-pride',
            'galakras': 'galakras',
            'iron-juggernaut': 'juggernaut',
            'korkron-dark-shamans': 'korkron-dark-shamans',
            'general-nazgrim': 'general-nazgrim',
            'malkorok': 'malkorok',
            'spoils-of-pandaria': 'spoils',
            'thok': 'thok',
            'siegecrafter': 'blackfuse',
            'paragons': 'paragons',
            'garrosh': 'garrosh'
        };
        const pfx = prefixMap[bossId] || bossId;

        const rows = Object.keys(data)
            .filter(k => k.startsWith(pfx + '-planner-row') && k.endsWith('-trigger'))
            .sort((a, b) => {
                const getNum = s => parseInt(s.match(/row(\d+)/)?.[1] || 999);
                return getNum(a) - getNum(b);
            });

        rows.forEach(rowKey => {
            const base = rowKey.replace('-trigger', '');
            const trigger = data[rowKey]?.player;
            if (!trigger || trigger === "") return;

            const condition = data[`${base}-condition`]?.text || "0";
            const time = data[`${base}-time`]?.text || "0";
            const rawPlayer = data[`${base}-player`]?.player || "ALL";
            const rowNpc = data[`${base}-npc`]?.player;
            const valText = data[`${base}-note`]?.text || "nil";
            const valTTS = data[`${base}-tts`]?.text || "nil";
            const valName = data[`${base}-varname`]?.text || "nil";
            const valIcon = data[`${base}-icon`]?.text || "nil";

            // Slot-Wert (z.B. HPALA1) zu echtem Spielernamen auflösen mit dem
            // Boss-spezifischen Mapping.
            //   - Slot ungemappt (oder Override = leer) → Zeile auslassen
            //   - Aufgelöster Spieler nicht im Roster → Zeile auslassen
            //   - Group-Keys (ALL, MAGE, TANKS, ...) gehen unverändert durch
            let player = rawPlayer;
            if (window.SlotSystem && window.SlotSystem.isSlotKey(rawPlayer)) {
                player = effectiveMapping[rawPlayer];
                if (!player) return;
            }
            const isGroupKey = window.SlotSystem && window.SlotSystem.isGroupKey(player);
            if (player && !isGroupKey && !rosterNamesSet.has(player)) {
                return;
            }

            const spellName = data[`${base}-cooldown`]?.cooldown;
            let spellId = "nil";
            if (spellName) {
                const cd = window.allCooldowns.find(c => c.name === spellName);
                if (cd && cd.spellId) spellId = cd.spellId;
            }

            let entry = "";
            if (trigger.includes("_HEALTH")) {
                const targetNpc = rowNpc || npcName || "nil";
                entry = `${trigger}/${condition}/${player}/${time}/${spellId}/${targetNpc}/${valText}/${valTTS}/${valName}/${valIcon}`;
            } else {
                entry = `${trigger}/${condition}/${player}/${time}/${spellId}/${valText}/${valTTS}/${valName}/${valIcon}`;
            }
            entries.push(entry);
        });
        return entries;
    }

    // --- 3. HILFSFUNKTION: Ji-Kun Wellen Export aus DB ---
    function buildJiKunWaveExport(data) {
        if (!data) return "";
        
        const WAVES = [
            { id: 1, count: 1 }, { id: 2, count: 1 }, { id: 3, count: 1 },
            { id: 4, count: 2 }, { id: 5, count: 2 }, { id: 6, count: 1 },
            { id: 7, count: 2 }, { id: 8, count: 2 }, { id: 9, count: 2 },
            { id: 10, count: 2 },
        ];

        // Die Standard-Ausrichtungen, falls sie in der DB fehlen (weil nie vom User im Dropdown geändert)
        const WAVE_DEFAULTS = {
            "1-0": { lvl: "LOWER", dir: "NE" },
            "2-0": { lvl: "LOWER", dir: "SE" },
            "3-0": { lvl: "LOWER", dir: "SW" },
            "4-0": { lvl: "LOWER", dir: "W" },  "4-1": { lvl: "UPPER", dir: "NE" },
            "5-0": { lvl: "LOWER", dir: "NW" }, "5-1": { lvl: "UPPER", dir: "SE" },
            "6-0": { lvl: "UPPER", dir: "MIDDLE" },
            "7-0": { lvl: "LOWER", dir: "NE" }, "7-1": { lvl: "UPPER", dir: "SW" },
            "8-0": { lvl: "LOWER", dir: "SE" }, "8-1": { lvl: "UPPER", dir: "NW" },
            "9-0": { lvl: "LOWER", dir: "SW" }, "9-1": { lvl: "UPPER", dir: "NW" },
            "10-0": { lvl: "LOWER", dir: "W" },  "10-1": { lvl: "UPPER", dir: "NE" },
        };

        const suffixes = ['', 'b', 'c'];
        
        const tank1 = data['jikun-nest-tank1']?.player || "Tank1";
        const tank2 = data['jikun-nest-tank2']?.player || "Tank2";
        
        // Teams aus DB laden
        const teams = {};
        for (let t = 1; t <= 5; t++) {
            teams[t] = [];
            for (let p = 1; p <= 5; p++) {
                const name = data[`jikun-team-${t}-p${p}`]?.player;
                if (name && name.trim() !== '') teams[t].push(name);
            }
        }
        
        let wRows = [];
        WAVES.forEach(wave => {
            for (let i = 0; i < wave.count; i++) {
                const suffix = suffixes[i];
                const key = `jikun-wave-${wave.id}${suffix}`;
                
                // Greift auf die Defaults zurück, wenn nichts vorhanden ist
                const def = WAVE_DEFAULTS[`${wave.id}-${i}`] || { lvl: "LOWER", dir: "NE" };
                
                // Lese aus der DB oder nutze den Default
                const lvl = data[`${key}-lvl`]?.player || def.lvl;
                let dir = data[`${key}-dir`]?.player || def.dir;
                
                // Falls noch das alte 'M' für Middle im System gegeistert, korrigieren wir das hier sauber
                if (dir === "M") dir = "MIDDLE";
                
                const teamId = data[`${key}-team`]?.player;
                const useT1 = data[`${key}-tank-t1`]?.active === true;
                const useT2 = data[`${key}-tank-t2`]?.active === true;
                
                if (teamId && lvl && dir) {
                    let players = [...(teams[teamId] || [])];
                    
                    // Tank-Override: 5. Spieler ersetzen
                    if (players.length >= 5) {
                        if (useT1) players[4] = tank1;
                        else if (useT2) players[4] = tank2;
                    }
                    
                    if (players.length > 0) {
                        const location = `${lvl}${dir}`;
                        const playerStr = players.join(',');
                        
                        // Bei Folgeeinsätzen ('b', 'c') in einer Welle weglassen des "WAVE"-Präfix (wie vom User / WA gewünscht)
                        if (suffix === 'b' || suffix === 'c') {
                            wRows.push(`${location}-${playerStr}`);
                        } else {
                            wRows.push(`WAVE${wave.id}-${location}-${playerStr}`);
                        }
                    }
                }
            }
        });
        return wRows.join(',');
    }

    // --- 4. HILFSFUNKTION: Durumu Lichtspektrum Export aus DB ---
    function buildDurumuSpectrumExport(data) {
        if (!data) return "";
        
        const colors = ['BLUE', 'RED', 'YELLOW'];
        let parts = [];
        
        colors.forEach(color => {
            let players = [];
            for (let i = 1; i <= 10; i++) {
                const name = data[`durumu-cone-${color.toLowerCase()}-${i}`]?.player;
                if (name && name.trim() !== '') players.push(name);
            }
            if (players.length > 0) {
                parts.push(`${color}-${players.join(',')}`);
            }
        });
        return parts.join(',');
    }

    // --- 5. MODAL BAUEN ---
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'export-wa-modal';
    modal.style.zIndex = '5000';

    // Boss-Checkboxen
    let bossCheckboxesHtml = raidInfo.bosses.map(boss => {
        const hasData = !!bossDataMap[boss.id];
        const entryCount = hasData ? buildCdExportForBoss(boss.id, bossDataMap[boss.id]).length : 0;
        return `
            <label class="flex items-center gap-2 p-1.5 rounded hover:bg-slate-700/50 cursor-pointer ${!hasData ? 'opacity-40' : ''}">
                <input type="checkbox" class="boss-export-cb accent-emerald-500 w-4 h-4" 
                       data-boss-id="${boss.id}" ${hasData && entryCount > 0 ? 'checked' : ''} ${!hasData ? 'disabled' : ''}>
                <span class="text-sm">${boss.name}</span>
                <span class="text-[10px] text-gray-500 ml-auto">${entryCount} Einträge</span>
            </label>`;
    }).join('');

    // Extras (raidspezifisch — pro Boss mit WeakAura-Export ein eigener Block)
    let extrasHtml = '';
    {
        const specials = [];

        // --- Throne of Thunder Specials ---
        if (selectedRaidId === 'throneofthunder') {
            const jikunWaveStr = buildJiKunWaveExport(bossDataMap['ji-kun']);
            const durumuSpecStr = buildDurumuSpectrumExport(bossDataMap['durumu']);
            if (jikunWaveStr) specials.push({
                key: 'jikun-waves', label: 'Ji-Kun Wellen', icon: 'fa-feather-alt',
                color: 'emerald', value: jikunWaveStr, countLabel: 'Einträge'
            });
            if (durumuSpecStr) specials.push({
                key: 'durumu-spectrum', label: 'Durumu Lichtspektrum', icon: 'fa-eye',
                color: 'purple', value: durumuSpecStr, countLabel: 'Gruppen'
            });
        }

        // --- Siege of Orgrimmar Specials ---
        if (selectedRaidId === 'siegeoforgrimmar') {
            const shaPlatesStr = buildShaPlatesExport(bossDataMap['sha-of-pride']);
            if (shaPlatesStr) specials.push({
                key: 'sha-plates', label: 'Sha-of-Pride Platten', icon: 'fa-shield-alt',
                color: 'pink', value: shaPlatesStr, countLabel: 'Platten', isMultiline: true
            });
            const norushenStr = buildNorushenOrbExport(bossDataMap['norushen']);
            if (norushenStr) specials.push({
                key: 'norushen-orbs', label: 'Norushen Orb-Reihenfolge', icon: 'fa-circle',
                color: 'cyan', value: norushenStr, countLabel: 'Einträge'
            });
            const blackfuseKillStr = buildSiegecrafterKillorderExport(bossDataMap['siegecrafter']);
            if (blackfuseKillStr) specials.push({
                key: 'blackfuse-killorder', label: 'Siegecrafter Kill-Reihenfolge', icon: 'fa-crosshairs',
                color: 'orange', value: blackfuseKillStr, countLabel: 'Adds'
            });
            const blackfuseLinesStr = buildSiegecrafterLinesExport(bossDataMap['siegecrafter']);
            if (blackfuseLinesStr) specials.push({
                key: 'blackfuse-lines', label: 'Siegecrafter Conveyor-Lines', icon: 'fa-grip-lines',
                color: 'yellow', value: blackfuseLinesStr, countLabel: 'Lines'
            });
            const paragonsKillStr = buildParagonsKillorderExport(bossDataMap['paragons']);
            if (paragonsKillStr) specials.push({
                key: 'paragons-killorder', label: 'Paragons Kill-Reihenfolge', icon: 'fa-crosshairs',
                color: 'red', value: paragonsKillStr, countLabel: 'Adds'
            });
        }

        // Hinweis: Weitere Bosse mit eigenen WeakAura-Exports werden hier ergänzt,
        // z.B. durch Hilfsfunktionen analog zu buildShaPlatesExport. Format:
        //   specials.push({
        //       key: '...', label: '...', icon: 'fa-...',
        //       color: '...', value: <Helper-Aufruf>, countLabel: '...',
        //       isMultiline: <bool>
        //   });

        if (specials.length > 0) {
            extrasHtml = `
            <div class="border-t border-slate-600 pt-4 mt-4">
                <h4 class="text-gold font-bold text-sm uppercase tracking-wider mb-3">
                    <i class="fas fa-puzzle-piece mr-1"></i> Spezial-Exports
                </h4>

                <div class="space-y-3">
                    ${specials.map(s => {
                        const countText = s.value
                            ? (s.isMultiline
                                ? s.value.split('\n').filter(l => l.trim() && !l.startsWith(' ')).length + ' ' + s.countLabel
                                : s.value.split(',').length + ' ' + s.countLabel)
                            : '';
                        return `
                        <div class="bg-slate-900/60 p-3 rounded border border-slate-700">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-sm font-bold text-${s.color}-400">
                                    <i class="fas ${s.icon} mr-1"></i> ${s.label}
                                </span>
                                <button class="export-copy-btn bg-${s.color}-700 hover:bg-${s.color}-600 text-white text-[10px] font-bold py-1 px-2 rounded transition-colors"
                                        data-target="export-${s.key}">Kopieren</button>
                            </div>
                            ${s.isMultiline
                                ? `<textarea id="export-${s.key}" readonly rows="${Math.min(Math.max(s.value.split('\n').length, 2), 12)}"
                                            class="w-full bg-black text-green-400 font-mono text-[10px] p-2 rounded border border-slate-700 resize-y cursor-text">${s.value}</textarea>`
                                : `<input type="text" id="export-${s.key}" readonly
                                            class="w-full bg-black text-green-400 font-mono text-[10px] p-2 rounded border border-slate-700 cursor-text"
                                            value="${s.value.replace(/"/g, '&quot;')}">`
                            }
                            <span class="text-[9px] text-gray-500">${countText}</span>
                        </div>
                        `;
                    }).join('')}
                </div>
            </div>`;
        }
    }

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px; max-height: 90vh; overflow-y: auto; text-align: left;">
            <h1 class="text-center mb-1">
                <i class="fas fa-file-export mr-2"></i>WA Export
            </h1>
            <p class="text-center text-sm text-gray-400 mb-4">${raidInfo.name}</p>
            
            <div class="mb-4">
                <div class="flex justify-between items-center mb-2">
                    <h3 class="text-sm font-bold text-gold uppercase tracking-wider">
                        <i class="fas fa-dragon mr-1"></i> CD-Planung pro Boss
                    </h3>
                    <div class="flex gap-1">
                        <button id="export-check-all" class="text-[10px] py-0.5 px-2 rounded bg-slate-600 hover:bg-slate-500 text-gray-300">Alle</button>
                        <button id="export-check-none" class="text-[10px] py-0.5 px-2 rounded bg-slate-600 hover:bg-slate-500 text-gray-300">Keine</button>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-1 max-h-[250px] overflow-y-auto bg-slate-900/40 p-2 rounded border border-slate-700">
                    ${bossCheckboxesHtml}
                </div>
            </div>

            <div class="bg-slate-900/60 p-3 rounded border border-slate-700 mb-4">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-bold text-yellow-400">
                        <i class="fas fa-scroll mr-1"></i> CD-Planer Export
                    </span>
                    <button id="export-cd-copy-btn" class="export-copy-btn bg-yellow-700 hover:bg-yellow-600 text-white text-[10px] font-bold py-1 px-2 rounded transition-colors"
                            data-target="export-cd-output">Kopieren</button>
                </div>
                <textarea id="export-cd-output" readonly rows="3"
                          class="w-full bg-black text-green-400 font-mono text-[10px] p-2 rounded border border-slate-700 resize-none cursor-text"></textarea>
                <span id="export-cd-count" class="text-[9px] text-gray-500"></span>
            </div>

            <div class="bg-slate-900/60 p-3 rounded border border-slate-700 mb-4">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-bold text-cyan-300">
                        <i class="fas fa-users mr-1"></i> WA Master-Roster-Mapping
                    </span>
                    <button id="export-mapping-copy-btn" class="export-copy-btn bg-cyan-800 hover:bg-cyan-700 text-white text-[10px] font-bold py-1 px-2 rounded transition-colors"
                            data-target="export-mapping-output">Kopieren</button>
                </div>
                <p class="text-[9px] text-gray-400 mb-1">
                    Format: <code class="text-cyan-300">HPALA1-Spieler1,HPALA2-Spieler2,...</code> &mdash; nur globales Mapping. Boss-Slot-Overrides werden im CD-Export oben angewendet.
                </p>
                <textarea id="export-mapping-output" readonly rows="2"
                          class="w-full bg-black text-cyan-300 font-mono text-[10px] p-2 rounded border border-slate-700 resize-none cursor-text"></textarea>
                <span id="export-mapping-count" class="text-[9px] text-gray-500"></span>
            </div>

            ${extrasHtml}
            
            <div class="modal-buttons mt-6">
                <button id="export-close-btn" class="cancel-btn">Schließen</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // --- 6. INTERAKTIVITÄT ---
    
    // CD-Export aktualisieren basierend auf Checkboxen
    function updateCdExport() {
        const checked = Array.from(modal.querySelectorAll('.boss-export-cb:checked'));
        let allEntries = [];
        let totalRows = 0;
        let bossesWithOverrides = 0;

        checked.forEach(cb => {
            const bossId = cb.dataset.bossId;
            const data = bossDataMap[bossId];
            if (data) {
                // Roh-Anzahl der Trigger-Zeilen für Skip-Statistik
                const rawCount = Object.keys(data)
                    .filter(k => k.includes('planner-row') && k.endsWith('-trigger'))
                    .filter(k => data[k]?.player && data[k].player !== "")
                    .length;
                totalRows += rawCount;
                // Boss hat Slot-Overrides aktiv?
                const overrides = (data._rosterPatches && data._rosterPatches.slotOverrides) || {};
                if (Object.keys(overrides).length > 0) bossesWithOverrides++;
                allEntries.push(...buildCdExportForBoss(bossId, data));
            }
        });

        const output = modal.querySelector('#export-cd-output');
        const count = modal.querySelector('#export-cd-count');
        const exportStr = allEntries.join('*');
        output.value = exportStr;

        const skipped = totalRows - allEntries.length;
        let countText;
        if (allEntries.length === 0 && checked.length === 0) {
            countText = 'Keine Bosse ausgewählt';
        } else {
            countText = `${allEntries.length} Einträge von ${checked.length} Bossen`;
            if (skipped > 0) countText += ` (${skipped} ausgelassen — Slot/Spieler nicht im Kader)`;
            if (bossesWithOverrides > 0) countText += ` · ${bossesWithOverrides} mit Slot-Overrides`;
        }
        count.textContent = countText;

        // Master-Roster-Mapping aktualisieren (globales Mapping)
        const mappingOutput = modal.querySelector('#export-mapping-output');
        const mappingCount = modal.querySelector('#export-mapping-count');
        if (mappingOutput && window.SlotSystem) {
            const validNames = new Set((window.rosterData || []).map(p => p.name));
            const mappingStr = window.SlotSystem.buildSlotMappingString(validNames);
            mappingOutput.value = mappingStr;

            const mappedCount = mappingStr ? mappingStr.split(',').length : 0;
            const fullMapping = window.SlotSystem.getMapping();
            const totalMappedSlots = Object.values(fullMapping).filter(n => n && n.trim()).length;
            const skippedMapping = totalMappedSlots - mappedCount;

            let mappingText = `${mappedCount} ${mappedCount === 1 ? 'Slot' : 'Slots'}`;
            if (skippedMapping > 0) mappingText += ` (${skippedMapping} ohne Kader-Spieler übersprungen)`;
            mappingCount.textContent = mappingText;
        }
    }

    // Checkboxen → Update
    modal.querySelectorAll('.boss-export-cb').forEach(cb => {
        cb.addEventListener('change', updateCdExport);
    });
    
    // Alle / Keine Buttons
    modal.querySelector('#export-check-all').addEventListener('click', () => {
        modal.querySelectorAll('.boss-export-cb:not(:disabled)').forEach(cb => cb.checked = true);
        updateCdExport();
    });
    modal.querySelector('#export-check-none').addEventListener('click', () => {
        modal.querySelectorAll('.boss-export-cb').forEach(cb => cb.checked = false);
        updateCdExport();
    });

    // Kopieren-Buttons (generisch für alle)
    modal.querySelectorAll('.export-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const input = modal.querySelector(`#${targetId}`);
            if (!input || !input.value || input.value === '(keine Daten)') return;
            
            if (targetId === 'export-cd-output' && selectedRaidId === 'siegeoforgrimmar') {
                if (window.showModal) {
                    window.showModal("Exportiere bitte auch die Platten bei Sha-des-Stolzes und die Reihenfolge bei Norushen und die Line Teams bei Siegecrafter");
                } else {
                    alert("Exportiere bitte auch die Platten bei Sha-des-Stolzes und die Reihenfolge bei Norushen und die Line Teams bei Siegecrafter");
                }
            }
            
            navigator.clipboard.writeText(input.value).then(() => {
                const orig = btn.textContent;
                btn.textContent = '✓ Kopiert!';
                btn.classList.add('bg-green-600');
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.classList.remove('bg-green-600');
                }, 1500);
            });
        });
    });

    // Schließen
    modal.querySelector('#export-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // Initialer Export
    updateCdExport();
};
window.updatePlannerSummary = function() {
    // 1. AUTOMATISCHE ERKENNUNG
    const container = document.querySelector('[id$="-planner-summary"]');
    if (!container) return; 

    const prefix = container.id.replace('-planner-summary', '');
    const cooldownDB = window.globalCooldowns || [];
    const rosterDB = window.globalRoster || [];
    
    let seqGroups = {};
    let healthGroups = {};

    const parseTime = (str) => {
        if (!str) return 0;
        const parts = str.split(':');
        if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        return parseInt(str) || 0;
    };

    // 2. DATEN SAMMELN
    for (let i = 1; i <= 200; i++) {
        const triggerEl = document.querySelector(`[data-assignment-id="${prefix}-planner-row${i}-trigger"]`);
        const playerEl = document.querySelector(`[data-assignment-id="${prefix}-planner-row${i}-player"]`);
        const cdEl = document.querySelector(`[data-assignment-id="${prefix}-planner-row${i}-cooldown"]`);
        const condEl = document.querySelector(`[data-assignment-id="${prefix}-planner-row${i}-condition"]`);
        const timeEl = document.querySelector(`[data-assignment-id="${prefix}-planner-row${i}-time"]`);
        const npcEl = document.querySelector(`[data-assignment-id="${prefix}-planner-row${i}-npc"]`);

        // Nur Zeilen mit Trigger & (Spieler ODER CD)
        if (!triggerEl || !triggerEl.value || (!playerEl.value && !cdEl.value)) continue;

        const triggerText = triggerEl.options[triggerEl.selectedIndex].text;
        const triggerVal = triggerEl.value;
        const conditionRaw = condEl.value || "0"; 
        const timeVal = timeEl.value || "";
        const timeSeconds = parseTime(timeVal);
        const playerVal = playerEl.value;
        const cdText = cdEl.value;
        
        // Cooldown Farbe
        let cdColor = "#e2e8f0"; 
        if (cdEl.selectedIndex >= 0) {
            const opt = cdEl.options[cdEl.selectedIndex];
            if (opt && opt.dataset.color) cdColor = opt.dataset.color;
        }

        // Spieler Farbe
        let playerColor = "#ffffff";
        const playerObj = rosterDB.find(p => p.name === playerVal);
        if (playerObj) {
            playerColor = window.classColors[playerObj.class] || playerObj.color || "#ffffff";
        }

        const entry = { time: timeVal, timeSec: timeSeconds, player: playerVal, playerColor: playerColor, cd: cdText, color: cdColor };
        const isHealth = triggerText.includes("Health") || triggerVal.includes("HEALTH");

        // --- KOMMA SPLIT (z.B. "7, 22") ---
        const conditions = conditionRaw.split(',').map(s => s.trim()).filter(s => s !== "");
        if (conditions.length === 0) conditions.push("0");

        conditions.forEach(cond => {
            const sortValue = parseFloat(cond) || 0;

            if (isHealth) {
                const npcName = npcEl && npcEl.value ? npcEl.value : "Boss";
                const key = `${npcName}_${cond}`;
                if (!healthGroups[key]) healthGroups[key] = { title: `${cond}% ${npcName}`, percent: sortValue, entries: [] };
                healthGroups[key].entries.push({ ...entry });
            } else {
                const key = `${cond}_${triggerText}`;
                if (!seqGroups[key]) seqGroups[key] = { title: `#${cond} ${triggerText}`, triggerName: triggerText, count: sortValue, entries: [] };
                seqGroups[key].entries.push({ ...entry });
            }
        });
    }

    // 3. SORTIEREN & RENDERN
    let seqArray = Object.values(seqGroups).sort((a, b) => {
        if (a.count !== b.count) return a.count - b.count; 
        return a.triggerName.localeCompare(b.triggerName);
    });
    let healthArray = Object.values(healthGroups).sort((a, b) => b.percent - a.percent);

    const sortEntries = (groups) => groups.forEach(g => g.entries.sort((a, b) => a.timeSec - b.timeSec));
    sortEntries(seqArray);
    sortEntries(healthArray);

    let html = "";
    const renderBlock = (title, entries, colorClass, borderClass) => {
        return `
        <div class="mb-1.5 relative pl-2 border-l-2 ${borderClass} break-inside-avoid">
            <h5 class="text-${colorClass} font-bold text-[10px] uppercase tracking-wide mb-0.5 opacity-80">${title}</h5>
            <div class="space-y-0.5">
                ${entries.map(e => {
                    // ÄNDERUNG: KEIN LINK, NUR TEXT
                    let linkContent = `<span style="color:${e.color}; font-weight:600;">${e.cd}</span>`;
                    
                    return `
                    <div class="text-[11px] text-gray-300 bg-slate-800/40 px-1.5 py-0.5 rounded flex items-center gap-2 hover:bg-slate-800 transition-colors">
                        <span class="text-gray-500 font-mono w-8 text-right shrink-0">${e.time}s</span>
                        <div class="flex-1 truncate">
                            <strong style="color: ${e.playerColor}" class="mr-1">${e.player}</strong>
                            <span class="text-gray-500 text-[9px] mr-1">➜</span>
                            ${linkContent}
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    };

    if (seqArray.length > 0) {
        html += `<div class="mb-4"><h4 class="text-yellow-400 text-xs font-bold border-b border-slate-700 pb-1 mb-2 uppercase tracking-widest">⚡ Ablauf (#)</h4>`;
        seqArray.forEach(g => html += renderBlock(g.title, g.entries, "yellow-200", "border-yellow-600/40"));
        html += `</div>`;
    }
    if (healthArray.length > 0) {
        html += `<div><h4 class="text-red-400 text-xs font-bold border-b border-slate-700 pb-1 mb-2 uppercase tracking-widest">❤️ Phasen (%)</h4>`;
        healthArray.forEach(g => html += renderBlock(g.title, g.entries, "red-200", "border-red-600/40"));
        html += `</div>`;
    }
    if (!html) html = `<div class="col-span-2 text-center text-gray-600 text-xs py-4 italic">Keine Einträge.</div>`;

    container.innerHTML = html;
};
window.initPlannerRowFeatures = function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const prefix = containerId.replace('-rows-container', '');

    // 1. SORTABLE (Zeilen verschieben)
if (typeof Sortable !== 'undefined') {
        new Sortable(container, {
            handle: '.row-drag-handle', 
            animation: 150,
            ghostClass: 'bg-slate-700',
            
            onEnd: async function(evt) {
                // Wenn nichts verschoben wurde, abbrechen
                if (evt.newIndex === evt.oldIndex) return;

                // Manager-Schutz — nicht-eingeloggte User dürfen nicht reordern
                if (!window.isManager) {
                    if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                    // Visuell zurücksetzen (Sortable hat das DOM bereits geändert)
                    if (typeof evt.from !== 'undefined' && typeof evt.oldIndex === 'number') {
                        const moved = evt.item;
                        const siblings = Array.from(evt.from.children);
                        const refNode = siblings[evt.oldIndex] || null;
                        evt.from.insertBefore(moved, refNode);
                    }
                    return;
                }

                console.log("Sortierung erkannt. Speichere sicher...");
                container.style.borderLeft = "4px solid #fcd34d"; // Gelb = Arbeitet

                const rows = Array.from(container.children);
                
                // WICHTIG: Imports für Firestore holen
                const { doc, setDoc, getFirestore } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
                const db = window.db || getFirestore();
                const bossDocRef = window.assignmentsDocRef || doc(db, "raid-tool-data", "boss-" + prefix);

                // WICHTIG: Aufteilen in Pakete + Date.now() nutzen
                const batch1 = {}; // 0-40
                const batch2 = {}; // 40-80
                const batch3 = {}; // 80+
                const safeTs = Date.now(); // Zählt NICHT als Transform-Limit!

                rows.forEach((row, index) => {
                    const newRowIndex = index + 1; 
                    
                    row.querySelectorAll('[data-assignment-id]').forEach(input => {
                        const oldId = input.dataset.assignmentId;
                        // Extrahiert den Suffix (z.B. "-player", "-time", "-cooldown")
                        // Wir suchen ab dem ersten Bindestrich nach "rowX"
                        // Einfachere Methode: Split am letzten Bindestrich
                        const parts = oldId.split('-');
                        const suffix = parts[parts.length - 1]; // "player", "time", etc.

                        const newId = `${prefix}-planner-row${newRowIndex}-${suffix}`;
                        
                        // HTML sofort updaten für UX
                        input.dataset.assignmentId = newId;

                        let val = input.value;
                        let dbField = 'text'; // Standard für Inputs

                        // DB Feldname bestimmen
                        if (suffix === 'cooldown') dbField = 'cooldown';
                        else if (['player', 'trigger', 'npc'].includes(suffix)) dbField = 'player';
                        
                        // Datenobjekt
                        const dataObj = { [dbField]: val, timestamp: safeTs };

                        // In Pakete verteilen
                        if (index < 40) batch1[newId] = dataObj;
                        else if (index < 80) batch2[newId] = dataObj;
                        else batch3[newId] = dataObj;
                    });
                });

                try {
                    // Pakete nacheinander senden
                    const promises = [];
                    if (Object.keys(batch1).length > 0) promises.push(setDoc(bossDocRef, batch1, { merge: true }));
                    if (Object.keys(batch2).length > 0) promises.push(setDoc(bossDocRef, batch2, { merge: true }));
                    if (Object.keys(batch3).length > 0) promises.push(setDoc(bossDocRef, batch3, { merge: true }));

                    await Promise.all(promises);
                    
                    container.style.borderLeft = "4px solid #4ade80"; // Grün
                    setTimeout(() => container.style.borderLeft = "", 1000);
                } catch (e) {
                    console.error(e);
                    window.showModal("Fehler beim Sortieren: " + e.message);
                    container.style.borderLeft = "4px solid #f87171"; // Rot
                }
            }
        });
    }

    // 2. BUTTONS (Copy, Paste, Delete)
    container.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const row = btn.closest('.planner-row');

        // --- KOPIEREN ---
        if (btn.classList.contains('copy-row-btn')) {
            const rowData = {};
            const fields = ['condition', 'time', 'player', 'cooldown', 'note', 'tts', 'varname', 'icon'];
            fields.forEach(f => {
                const el = row.querySelector(`[data-assignment-id$="-${f}"]`);
                if(el) rowData[f] = el.value;
            });
            localStorage.setItem('plannerClipboard', JSON.stringify(rowData));
            
            const originalIcon = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check text-green-400"></i>';
            setTimeout(() => btn.innerHTML = originalIcon, 1000);
        }

        // --- EINFÜGEN ---
        if (btn.classList.contains('paste-row-btn')) {
            // Manager-Schutz — nicht-eingeloggte User dürfen nichts schreiben
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            const dataStr = localStorage.getItem('plannerClipboard');
            if (!dataStr) return window.showModal('Zwischenablage ist leer.');
            const data = JSON.parse(dataStr);
            const updates = {};
            
            const fields = ['condition', 'time', 'player', 'cooldown', 'note', 'tts', 'varname', 'icon'];
            fields.forEach(f => {
                if (data[f] !== undefined) {
                    const input = row.querySelector(`[data-assignment-id$="-${f}"]`);
                    if (input) {
                        input.value = data[f];
                        if (input.tagName === 'SELECT') { 
                           const opt = Array.from(input.options).find(o => o.value === data[f]);
                           input.style.color = opt ? opt.dataset.color : '#fff';
                        }
                        const id = input.dataset.assignmentId;
                        let dbField = (input.tagName === 'INPUT') ? 'text' : (f === 'cooldown' ? 'cooldown' : 'player');
                        updates[id] = { [dbField]: data[f], timestamp: serverTimestamp() };
                    }
                }
            });
            const bossDocRef = window.assignmentsDocRef || doc(db, "raid-tool-data", "boss-" + prefix);
            await setDoc(bossDocRef, updates, { merge: true });
            
            const originalIcon = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check text-green-400"></i>';
            setTimeout(() => btn.innerHTML = originalIcon, 1000);
        }

        // --- LÖSCHEN (NEU) ---
        if (btn.classList.contains('delete-row-btn')) {
            // Manager-Schutz — nicht-eingeloggte User dürfen nichts löschen
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            // Eigenen Dialog erstellen
            const dialog = document.createElement('div');
            dialog.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[9999]';
            dialog.innerHTML = `
                <div class="bg-slate-800 border border-slate-600 p-6 rounded-lg shadow-2xl text-center max-w-sm mx-4">
                    <h3 class="text-xl font-bold text-white mb-2">Zeile löschen</h3>
                    <p class="text-gray-300 mb-6 text-sm">Möchtest du nur den Trigger deaktivieren oder die gesamte Zeile leeren?</p>
                    <div class="flex flex-col gap-3">
                        <button id="del-inactive" class="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded font-bold transition">Nur Inaktiv setzen</button>
                        <button id="del-clear" class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded font-bold transition">Alles leeren</button>
                        <button id="del-cancel" class="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-gray-200 rounded transition mt-2">Abbrechen</button>
                    </div>
                </div>
            `;
            document.body.appendChild(dialog);

            const handleChoice = async (choice) => {
                dialog.remove();
                if (choice === 'cancel') return;

                const updates = {};
                const ts = serverTimestamp();
                const inputs = row.querySelectorAll('[data-assignment-id]');

                inputs.forEach(input => {
                    const id = input.dataset.assignmentId;
                    
                    // Fall 1: Nur Inaktiv -> Nur Trigger leeren
                    if (choice === 'inactive') {
                        if (id.includes('-trigger')) {
                            input.value = "";
                            updates[id] = { player: "", text: "", cooldown: "", timestamp: ts };
                        }
                    }
                    // Fall 2: Alles leeren -> Alle Felder leeren
                    else if (choice === 'clear') {
                        input.value = "";
                        if (input.tagName === 'SELECT') input.style.color = '#fff';
                        
                        updates[id] = { player: "", text: "", cooldown: "", timestamp: ts };
                    }
                });

                // Speichern
                const bossDocRef = window.assignmentsDocRef || doc(db, "raid-tool-data", "boss-" + prefix);
                await setDoc(bossDocRef, updates, { merge: true });
            };

            dialog.querySelector('#del-inactive').onclick = () => handleChoice('inactive');
            dialog.querySelector('#del-clear').onclick = () => handleChoice('clear');
            dialog.querySelector('#del-cancel').onclick = () => handleChoice('cancel');
        }
    });
};
window.cleanUpInvalidRosterEntries = async function() {
    if (!window.isManager) return window.showModal("Nur Manager dürfen die Datenbank bereinigen.");
    
    if (!confirm("ACHTUNG: Dies überprüft ALLE Bosse im aktuellen Raid.\n\nAlle Einträge von Spielern, die NICHT mehr im Roster sind, werden auf 'Inaktiv' gesetzt und entfernt.\n\nMöchtest du fortfahren?")) return;

    // 1. Roster Namen sammeln
    let currentRosterNames = [];
    if (window.globalRoster && window.globalRoster.length > 0) {
        currentRosterNames = window.globalRoster.map(p => p.name);
    } else {
        // Fallback: Roster frisch laden, falls nicht verfügbar
        try {
            const rosterSnaps = await getDocs(collection(db, "roster"));
            currentRosterNames = rosterSnaps.docs.map(d => d.data().name);
        } catch (e) {
            return window.showModal("Fehler: Konnte Roster nicht laden.");
        }
    }

    // 2. Aktuelle Bosse identifizieren
    const selectedRaidId = document.getElementById('raid-selector').value; 
    const raidInfo = window.raidData[selectedRaidId];
    if (!raidInfo || !raidInfo.bosses) return window.showModal("Keine Raid-Daten gefunden.");

    let totalCleaned = 0;
    let bossesProcessed = 0;

    // 3. Durch alle Bosse iterieren
    for (const boss of raidInfo.bosses) {
        const bossDocId = "boss-" + boss.id;
        const docRef = doc(db, "raid-tool-data", bossDocId);
        const snap = await getDoc(docRef);

        if (!snap.exists()) continue;

        const data = snap.data();
        const updates = {};
        let hasChanges = false;
        const ts = serverTimestamp();

        // Alle Keys durchsuchen
        Object.keys(data).forEach(key => {
            // Wir suchen nur nach Spieler-Zuweisungen im Planer
            // Format: [prefix]-planner-row[X]-player
            if (key.includes('-planner-row') && key.endsWith('-player')) {
                const assignedPlayer = data[key].player;
                
                // PRÜFUNG: Ist ein Spieler eingetragen UND ist er NICHT im Roster?
                if (assignedPlayer && assignedPlayer !== "" && !currentRosterNames.includes(assignedPlayer)) {
                    
                    // A. Spieler aus dem Feld löschen
                    updates[key] = { player: "", timestamp: ts };
                    
                    // B. Trigger auf "Inaktiv" (Leerstring) setzen
                    // Der Key für den Trigger ist fast gleich, endet aber auf "-trigger"
                    const triggerKey = key.replace('-player', '-trigger');
                    updates[triggerKey] = { player: "", timestamp: ts }; // Selects nutzen 'player' als Value-Feld in deiner DB-Struktur

                    hasChanges = true;
                    totalCleaned++;
                }
            }
        });

        // Speichern, wenn nötig
        if (hasChanges) {
            await setDoc(docRef, updates, { merge: true });
            bossesProcessed++;
        }
    }

    if (totalCleaned > 0) {
        window.showModal(`Fertig! ${totalCleaned} Einträge bei ${bossesProcessed} Bossen wurden bereinigt.`);
    } else {
        window.showModal("Alles sauber! Keine veralteten Einträge gefunden.");
    }
};  
    // Initial Cooldowns laden
    //fetchAllCooldowns();
    
    // Hilfsobjekt global verfügbar machen, falls noch nicht geschehen
    window.firebaseTools = { db, doc, getDoc, collection, getDocs, updateDoc, setDoc };

window.assignmentUnsubscribe = window.assignmentUnsubscribe || null;
// NEU: Setup umbenennen
window.renameCompSetup = async function(slotId) {
    if (!window.isManager) return window.showModal("Nur Manager können Setups umbenennen.");
    
    const currentLabel = document.getElementById(`setup-label-${slotId}`)?.textContent || slotId;
    const newName = await window.showPrompt("Name für Setup " + slotId + ":", currentLabel);
    if (!newName || newName.trim() === '') return;
    
    const { setDoc, doc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const db = window.firebaseTools.db;
    const setupDocRef = doc(db, "raid-tool-data", `comp-setup-${slotId}`);
    
    await setDoc(setupDocRef, { label: newName.trim() }, { merge: true });
    
    const labelEl = document.getElementById(`setup-label-${slotId}`);
    if (labelEl) labelEl.textContent = newName.trim();
};

// NEU: Labels beim Laden der Comp-Seite aktualisieren
window.loadSetupLabels = async function() {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const db = window.firebaseTools.db;
    
    for (let i = 1; i <= 3; i++) {
        const labelEl = document.getElementById(`setup-label-${i}`);
        if (!labelEl) continue;
        
        try {
            const snap = await getDoc(doc(db, "raid-tool-data", `comp-setup-${i}`));
            if (snap.exists() && snap.data().label) {
                labelEl.textContent = snap.data().label;
            }
        } catch(e) { /* ignore */ }
    }
};

// =============================================================================
// handleAssignmentChange (Top-Level — wird in Boss-Page + überall referenziert)
// =============================================================================

async function handleAssignmentChange(event) {
        // Prüfen ob Referenz existiert
        if (typeof window.assignmentsDocRef === 'undefined' || !window.assignmentsDocRef) {
            console.error("Kein aktiver Boss geladen (window.assignmentsDocRef fehlt)!");
            return;
        }

        if (window._suspendAssignListeners) return;
        if (!window.isManager) return;
        
        const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
        const element = event.target;
        const assignmentId = element.dataset.assignmentId;
        const value = element.value; // 'val' korrigiert zu 'value'

        let dataToSave;

        if (element.tagName === 'SELECT') {
            // Dropdown Logik
            if (assignmentId.toLowerCase().includes('cooldown')) {
                dataToSave = { [assignmentId]: { cooldown: value, editor: currentManager, timestamp: serverTimestamp() } };
            } else if (assignmentId.includes('npc_name') || assignmentId.includes('condition') || assignmentId.includes('time')) {
                 // Speichere Text-Werte für Planer-Selects unter 'text' (Fallback, falls ein Select dafür genutzt wird)
                 dataToSave = { [assignmentId]: { text: value, editor: currentManager, timestamp: serverTimestamp() } };
            } else {
                // Normale Spieler oder Trigger (JINROKH_HEALTH etc.) -> speichern unter 'player'
                dataToSave = { [assignmentId]: { player: value, editor: currentManager, timestamp: serverTimestamp() } };
            }
            
            // Farbe aktualisieren
            const selectedOption = element.options[element.selectedIndex];
            element.style.color = selectedOption ? (selectedOption.dataset.color || '#FFFFFF') : '#FFFFFF';

        } else {
            // Text Input Logik (Fallback für handleTextInputChange, falls Events hier landen)
            dataToSave = { [assignmentId]: { text: value, editor: currentManager, timestamp: serverTimestamp() } };
        }

        // DEBOUNCED SPEICHERN
        if (!window.pendingAssignmentUpdates) window.pendingAssignmentUpdates = {};
        Object.assign(window.pendingAssignmentUpdates, dataToSave);

        // History Log direkt
        const playerForLog = value || "Niemand/Leer";
        const bossName = location.hash.split('/')[1] || "Boss";
        window.logHistory(bossName, `Einteilung: ${assignmentId}`, playerForLog, currentManager);

        if (window.assignmentUpdateTimer) clearTimeout(window.assignmentUpdateTimer);
        window.assignmentUpdateTimer = setTimeout(async () => {
            const payload = window.pendingAssignmentUpdates;
            window.pendingAssignmentUpdates = {};
            if (Object.keys(payload).length > 0 && window.assignmentsDocRef) {
                try {
                    await setDoc(window.assignmentsDocRef, payload, { merge: true });
                } catch (e) {
                    console.error("Fehler beim debounced Speichern:", e);
                }
            }
        }, 250);
    }

// Event Listener für Änderungen global registrieren (falls noch nicht geschehen)
document.addEventListener('change', (e) => {
    if (e.target.classList.contains('assignment-select') || e.target.classList.contains('assignment-text-input')) {
        handleAssignmentChange(e);
    }
});

window.handleAssignmentChange = handleAssignmentChange;

// =============================================================================
// URL-IMPORT (classic & robust v4)
// =============================================================================

// ============== KLASSISCHER URL IMPORT (ROBUST V4) ==============

        async function handleImportFromUrl() {
            if (!window.isManager) return window.showModal("Nur Manager dürfen importieren.");
            
            const urlInput = document.getElementById('json-url-input');
            const userInputUrl = urlInput.value.trim();

            if (!userInputUrl) {
                return window.showModal("Bitte eine URL einfügen.");
            }

            // 1. ID Extraktion (Nimmt die längste Zahl in der URL)
            const idMatch = userInputUrl.match(/(\d{15,})/); 
            const raidId = idMatch ? idMatch[0] : userInputUrl; // Fallback: Ganze Eingabe ist ID

            if (!raidId || raidId.length < 10) {
                return window.showModal("Konnte keine gültige ID aus dem Link lesen.");
            }

            // 2. Typ Bestimmung (Comp oder Event?)
            let apiType = 'events'; 


            const targetApiUrl = `https://raid-helper.dev/api/raidplan/${raidId}`;

            // 3. Backup Proxies
            const proxies = [
                'https://corsproxy.io/?',              // Favorit 1: Schnell & zuverlässig
                'https://api.allorigins.win/raw?url='  // Favorit 2: Guter Fallback
            ];

            const loadingModal = window.showModal("Lade Daten über Proxy...", false);
            let success = false;

            // 4. Proxies durchprobieren
            for (const proxy of proxies) {
                if (success) break;

                try {
                    console.log(`Versuche Proxy: ${proxy}`);
                    const fetchUrl = proxy + encodeURIComponent(targetApiUrl);
                    
                    const response = await fetch(fetchUrl);
                    if (!response.ok) throw new Error(`Status ${response.status}`);

                    const data = await response.json();

                    const rawSlots = data.slots || data.signUps || data.raidDrop; // raidDrop für V3 legacy

                    if (!rawSlots || !Array.isArray(rawSlots)) {
                        throw new Error("Keine Spieler-Daten im JSON gefunden.");
                    }

                    // 5. Mapping (V4 -> Intern)
                    const newRoster = rawSlots.map(slot => {
                        // Absagen filtern
                        if (slot.signupType === 'absent' || slot.spec === 'Absence') return null;

                        return window.getPlayerInfoFromEntry({
                            name: slot.name,
                            class: slot.className || slot.class, 
                            spec: slot.specName || slot.spec,
                            status: slot.signupType || 'unknown',
                            group: slot.groupNumber // Falls vorhanden (bei Comps)
                        });
                    }).filter(p => p !== null);

                    // Speichern
                    const jsonString = JSON.stringify(data, null, 2);
                    await window.firebaseTools.setDoc(
                        window.firebaseTools.doc(window.firebaseTools.db, "raid-tool-data", "currentRoster"), 
                        { roster: newRoster, rawJson: jsonString }
                    );

                    // UI Updates
                    document.getElementById('json-input').value = jsonString;
                    urlInput.value = '';
                    
                    loadingModal.then(()=>{});
                    window.showModal(`Erfolg!\n${newRoster.length} Spieler importiert.`);
                    
                    success = true;
                    if (typeof window.renderCurrentState === 'function') window.renderCurrentState();

                } catch (e) {
                    console.warn(`Proxy ${proxy} fehlgeschlagen:`, e);
                }
            }

            if (!success) {
                loadingModal.then(()=>{});
                window.showModal("Import gescheitert. Beide Proxies konnten die URL nicht laden.\nIst der Link öffentlich und korrekt?");
            }
        }

        window.handleImportFromJson = async function() {
            if (!window.isManager) return window.showModal("Nur Manager dürfen importieren.");
            
            const input = document.getElementById('json-input').value;
            if (!input.trim()) return window.showModal("Bitte JSON einfügen.");

            try {
                const data = JSON.parse(input);
                
                const rawSlots = data.slots || data.signUps || data.raidDrop; 
                
                if (!rawSlots || !Array.isArray(rawSlots)) {
                    throw new Error("Keine 'slots' oder 'signUps' Liste im JSON gefunden.");
                }

                const newRoster = rawSlots.map(slot => {
                     // Absagen rausfiltern (falls vorhanden)
                     if (slot.signupType === 'absent' || slot.spec === 'Absence') return null;

                     return window.getPlayerInfoFromEntry({
                        name: slot.name,

                        class: slot.className || slot.class, 
                        spec: slot.specName || slot.spec,
                        group: slot.groupNumber,
                        id: slot.id, 
                        status: slot.isConfirmed || slot.signupType || 'unknown'
                    });
                }).filter(p => p !== null);

                if (newRoster.length === 0) {
                    throw new Error("JSON wurde gelesen, enthielt aber 0 gültige Spieler.");
                }

                await window.firebaseTools.setDoc(
                    window.firebaseTools.doc(window.firebaseTools.db, "raid-tool-data", "currentRoster"), 
                    { roster: newRoster, rawJson: input }
                );
                
                window.showModal(`✅ JSON Importiert: ${newRoster.length} Spieler.`);
                

                if (typeof window.renderCurrentState === 'function') window.renderCurrentState();

            } catch(e) {
                console.error(e); // Für Debugging in der Konsole (F12)
                window.showModal("JSON Fehler: " + e.message);
            }
        }
		
        const raidData = {
            mogushan: {
                name: "Mogu'shangewölbe",
                bosses: [
                    { id: 'steinwache', name: 'Die Steinwache' },
                    { id: 'feng', name: 'Feng der Verfluchte' },
                    { id: 'garajal', name: 'Gara\'jal der Geisterbinder' },
                    { id: 'geisterkoenige', name: 'Die Geisterkönige' },
                    { id: 'elegon', name: 'Elegon' },
                    { id: 'wille', name: 'Wille des Kaisers' }
                ]
            },
            heartoffear: {
                name: "Das Herz der Angst",
                bosses: [
                    { id: 'zorlok', name: 'Kaiserlicher Wesir Zor\'lok' },
                    { id: 'tayak', name: 'Klingenfürst Ta\'yak' },
                    { id: 'garalon', name: 'Garalon' },
                    { id: 'meljarak', name: 'Windfürst Mel\'jarak' },
                    { id: 'unsof', name: 'Bernformer Un\'sok' },
                    { id: 'shekzeer', name: 'Großkaiserin Shek\'zeer' }
                ]
            },
            terraceofendlessspring: {
                name: "Terrasse des Endlosen Frühlings",
                bosses: [
                    { id: 'protectors', name: 'Beschützer des Endlosen' },
                    { id: 'tsulong', name: 'Tsulong' },
                    { id: 'lei-shi', name: 'Lei Shi' },
                    { id: 'sha-of-fear', name: 'Sha der Angst' }
                ]
            },
            throneofthunder: {
                name: "Der Thron des Donners",
                bosses: [
                    { id: 'jinrokh', name: 'Jin\'rokh der Zerstörer' },
                    { id: 'horridon', name: 'Horridon' },
                    { id: 'council', name: 'Rat der Ältesten' },
                    { id: 'tortos', name: 'Tortos' },
                    { id: 'megaira', name: 'Megaira' },
                    { id: 'ji-kun', name: 'Ji-Kun' },
                    { id: 'durumu', name: 'Durumu der Vergessene' },
                    { id: 'primordius', name: 'Primordius' },
                    { id: 'dark-animus', name: 'Dunkler Animus' },
                    { id: 'iron-qon', name: 'Eiserner Qon' },
                    { id: 'twin-consorts', name: 'Zwillingskonkubinen' },
                    { id: 'lei-shen', name: 'Lei Shen' },
                    { id: 'ra-den', name: 'Ra-den' }
                ]
            },
            siegeoforgrimmar: {
                name: "Schlacht um Orgrimmar",
                bosses: [
                    { id: 'immerseus', name: 'Immerseus' },
                    { id: 'fallen-protectors', name: 'Die gefallenen Beschützer' },
                    { id: 'norushen', name: 'Norushen' },
                    { id: 'sha-of-pride', name: 'Sha des Stolzes' },
                    { id: 'galakras', name: 'Galakras' },
                    { id: 'iron-juggernaut', name: 'Eiserner Koloss' },
                    { id: 'korkron-dark-shamans', name: 'Dunkelschamanen der Kor\'kron' },
                    { id: 'general-nazgrim', name: 'General Nazgrim' },
                    { id: 'malkorok', name: 'Malkorok' },
                    { id: 'spoils-of-pandaria', name: 'Die Schätze Pandarias' },
                    { id: 'thok', name: 'Thok der Blutrünstige' },
                    { id: 'siegecrafter', name: 'Belagerungsingenieur Rußschmied' },
                    { id: 'paragons', name: 'Die Getreuen der Klaxxi' },
                    { id: 'garrosh', name: 'Garrosh Höllschrei' }
                ]
            }
        };
window.raidData = raidData;

let allCooldowns = [];
window.allCooldowns = allCooldowns;

window.handleImportFromUrl = handleImportFromUrl;

// =============================================================================
// fetchAllCooldowns — lädt CD-Stammdaten (mit localStorage-Cache + Live-Updates)
// =============================================================================
// Strategie:
//   1. Sofort aus localStorage laden (0 Firestore-Reads)
//   2. onSnapshot-Listener registrieren für Live-Updates
//   3. Bei Änderungen: localStorage + window.allCooldowns aktualisieren
// =============================================================================

const COOLDOWN_CACHE_KEY = 'panik_cooldowns_cache';
const CD_CATEGORIES_CACHE_KEY = 'panik_cd_categories_cache';
let _cooldownListenerActive = false;

/**
 * Merged virtuelle Kategorien aus den CD-Kategorien in die Cooldown-Liste.
 */
function _mergeVirtualCategories(baseCooldowns, categoriesData) {
    const merged = [...baseCooldowns];
    if (!categoriesData || !categoriesData.categories) return merged;

    const cats = categoriesData.categories;
    let hasVirtuals = false;

    Object.values(cats).forEach(c => {
        if (c.isVirtual) {
            if (!hasVirtuals) {
                merged.push({ name: "--- Warnungen (Virtuell) ---", class: "General", spellId: "nil", order: 998 });
                hasVirtuals = true;
            }
            merged.push({
                name: c.name,
                class: "General",
                spellId: "nil",
                cooldownSec: 0,
                durationSec: 0,
                tooltip: `Virtuell. Ziel: ${c.defaultPlayer || 'Alle'}<br>TTS: ${c.defaultTts || '-'}<br>Hinweis: ${c.defaultNote || '-'}`,
                order: 999
            });
        }
    });
    return merged;
}

async function fetchAllCooldowns() {
    // ── 1. Sofort aus localStorage laden (Instant, 0 Reads) ──────────────
    if (!window.allCooldowns || window.allCooldowns.length === 0) {
        try {
            const cached = localStorage.getItem(COOLDOWN_CACHE_KEY);
            const cachedCats = localStorage.getItem(CD_CATEGORIES_CACHE_KEY);
            if (cached) {
                const baseCooldowns = JSON.parse(cached);
                const categoriesData = cachedCats ? JSON.parse(cachedCats) : null;
                allCooldowns = _mergeVirtualCategories(baseCooldowns, categoriesData);
                window.allCooldowns = allCooldowns;
                console.log('[Cooldowns] Aus Cache geladen:', allCooldowns.length, 'Einträge');
            }
        } catch (e) {
            console.warn('[Cooldowns] Cache-Lesen fehlgeschlagen:', e);
        }
    }

    // ── 2. onSnapshot-Listener (nur einmal registrieren) ─────────────────
    if (_cooldownListenerActive) return;
    _cooldownListenerActive = true;

    try {
        const cooldownsCollectionRef = collection(db, "cooldowns");
        const q = query(cooldownsCollectionRef, orderBy("order", "asc"), orderBy("name", "asc"));

        // Cooldowns-Listener
        onSnapshot(q, (snapshot) => {
            const baseCooldowns = snapshot.docs.map(d => d.data());

            // In localStorage cachen (nur die Basis-Daten, ohne virtuelle)
            try {
                localStorage.setItem(COOLDOWN_CACHE_KEY, JSON.stringify(baseCooldowns));
            } catch (e) { console.warn('[Cooldowns] Cache-Schreiben fehlgeschlagen:', e); }

            // Virtuelle Kategorien aus dem bestehenden Cache mergen
            let categoriesData = null;
            try {
                const cachedCats = localStorage.getItem(CD_CATEGORIES_CACHE_KEY);
                if (cachedCats) categoriesData = JSON.parse(cachedCats);
            } catch (e) { /* ignore */ }

            allCooldowns = _mergeVirtualCategories(baseCooldowns, categoriesData);
            window.allCooldowns = allCooldowns;
            console.log('[Cooldowns] Live-Update:', allCooldowns.length, 'Einträge');
        });

        // CD-Kategorien-Listener (für virtuelle Kategorien)
        onSnapshot(doc(db, "auto-planner", "_cd-categories"), (docSnap) => {
            const categoriesData = docSnap.exists() ? docSnap.data() : null;

            // In localStorage cachen
            try {
                if (categoriesData) {
                    localStorage.setItem(CD_CATEGORIES_CACHE_KEY, JSON.stringify(categoriesData));
                }
            } catch (e) { /* ignore */ }

            // Basis-Cooldowns aus localStorage holen und mit neuen Kategorien mergen
            try {
                const cached = localStorage.getItem(COOLDOWN_CACHE_KEY);
                if (cached) {
                    const baseCooldowns = JSON.parse(cached);
                    allCooldowns = _mergeVirtualCategories(baseCooldowns, categoriesData);
                    window.allCooldowns = allCooldowns;
                    console.log('[Cooldowns] Kategorien-Update, neu gemerged:', allCooldowns.length, 'Einträge');
                }
            } catch (e) { console.warn('[Cooldowns] Kategorien-Merge fehlgeschlagen:', e); }
        });

    } catch (error) {
        console.error("Fehler beim Einrichten der Cooldown-Listener:", error);
        _cooldownListenerActive = false;
    }
}

window.fetchAllCooldowns = fetchAllCooldowns;

// =============================================================================
// SNAPSHOTS (Save / Load / Delete / Populate Selector)
// =============================================================================

		// ============== NEUE SNAPSHOT FUNKTIONEN ==============
		
		async function saveSnapshot() {
			if (!window.isManager) return;
			const snapshotName = await window.showPrompt("Bitte gib einen Namen für den Snapshot ein (z.B. 'Progress-Setup KW25'):");
			if (!snapshotName || snapshotName.trim() === '') {
				window.showModal("Speichern abgebrochen. Kein Name angegeben.");
				return;
			}
		
			try {
				// 1. Aktuelles Roster holen
				const rosterSnap = await getDoc(rosterDocRef);
				const rosterData = rosterSnap.exists() ? rosterSnap.data() : {};
		
				// 2. Alle Boss-Einteilungen holen
				const bossAssignments = {};
				for (const raidId in window.raidData) {
					for (const boss of window.raidData[raidId].bosses) {
						const bossDocRef = doc(db, DATA_COLLECTION, `boss-${boss.id}`);
						const bossSnap = await getDoc(bossDocRef);
						if (bossSnap.exists()) {
							bossAssignments[`boss-${boss.id}`] = bossSnap.data();
						}
					}
				}
		
				// 3. Snapshot-Dokument erstellen
				const snapshotDoc = {
					name: snapshotName,
					createdAt: serverTimestamp(),
					editor: sessionStorage.getItem('currentManager') || 'Unbekannt',
					roster: rosterData,
					assignments: bossAssignments
				};
		
				// 4. In der neuen Collection speichern
				await addDoc(snapshotsCollectionRef, snapshotDoc);
				window.showModal(`Snapshot '${snapshotName}' wurde erfolgreich gespeichert!`);
				populateSnapshotSelector(); // Liste aktualisieren
			} catch (error) {
				console.error("Fehler beim Speichern des Snapshots:", error);
				window.showModal("Ein Fehler ist aufgetreten. Der Snapshot konnte nicht gespeichert werden.");
			}
		}

		async function loadSnapshot() {
			if (!window.isManager) return;
			const snapshotId = document.getElementById('snapshot-selector').value;
			if (!snapshotId) {
				window.showModal("Bitte wähle zuerst einen Snapshot aus der Liste aus.");
				return;
			}
		
			const confirmed = await window.showModal(
				"Achtung! Das Laden dieses Snapshots überschreibt die aktuelle Aufstellung und alle Boss-Einteilungen. Fortfahren?",
				true // Bestätigungsdialog anzeigen
			);
		
			if (!confirmed) return;
		
			try {
				// 1. Ausgewählten Snapshot holen
				const snapshotDocRef = doc(db, SNAPSHOTS_COLLECTION, snapshotId);
				const snapshotSnap = await getDoc(snapshotDocRef);
		
				if (!snapshotSnap.exists()) {
					throw new Error("Snapshot nicht gefunden.");
				}
				const snapshotData = snapshotSnap.data();
		
				// 2. Live-Roster überschreiben
				if (snapshotData.roster) {
					await setDoc(rosterDocRef, snapshotData.roster);
				}
		
				// 3. Alle Live-Boss-Einteilungen überschreiben
				if (snapshotData.assignments) {
					for (const docId in snapshotData.assignments) {
						const liveDocRef = doc(db, DATA_COLLECTION, docId);
						await setDoc(liveDocRef, snapshotData.assignments[docId]);
					}
				}
				
				window.showModal(`Snapshot '${snapshotData.name}' wurde erfolgreich geladen.`);
				// Ein Neuladen der Seite stellt sicher, dass alle Listener die neuen Daten korrekt anzeigen
				location.reload();
		
			} catch (error) {
				console.error("Fehler beim Laden des Snapshots:", error);
				window.showModal("Ein Fehler ist aufgetreten. Der Snapshot konnte nicht geladen werden.");
			}
		}
		
		async function deleteSnapshot() {
			if (!window.isManager) return;
			const selector = document.getElementById('snapshot-selector');
			const snapshotId = selector.value;
			if (!snapshotId) {
				window.showModal("Bitte wähle zuerst einen Snapshot aus, der gelöscht werden soll.");
				return;
			}
		
			const snapshotName = selector.options[selector.selectedIndex].text;
			const confirmed = await window.showModal(
				`Soll der Snapshot '${snapshotName}' wirklich endgültig gelöscht werden?`,
				true // Bestätigungsdialog anzeigen
			);
		
			if (!confirmed) return;
		
			try {
				await deleteDoc(doc(db, SNAPSHOTS_COLLECTION, snapshotId));
				window.showModal(`Snapshot '${snapshotName}' wurde gelöscht.`);
				populateSnapshotSelector(); // Liste aktualisieren
			} catch (error) {
				console.error("Fehler beim Löschen des Snapshots:", error);
				window.showModal("Ein Fehler ist aufgetreten. Der Snapshot konnte nicht gelöscht werden.");
			}
		}
		
		async function populateSnapshotSelector() {
			const selector = document.getElementById('snapshot-selector');
			if (!selector) return;
		
			try {
				const q = query(snapshotsCollectionRef, orderBy("createdAt", "desc"));
				const snapshotSnaps = await getDocs(q);
		
				selector.innerHTML = '<option value="">-- Snapshot auswählen --</option>'; // Zurücksetzen
				snapshotSnaps.forEach(snap => {
					const data = snap.data();
					const option = document.createElement('option');
					option.value = snap.id;
					option.textContent = data.name;
					selector.appendChild(option);
				});
			} catch (error) {
				console.error("Fehler beim Laden der Snapshot-Liste:", error);
			}
}

window.saveSnapshot = saveSnapshot;
window.loadSnapshot = loadSnapshot;
window.deleteSnapshot = deleteSnapshot;
window.populateSnapshotSelector = populateSnapshotSelector;

// =============================================================================
// MASTER-VIEW & DISCORD-WEBHOOK
// =============================================================================

function initMasterView() {
    const section = document.getElementById('master-view-section');
    if (!section) return;
    section.style.display = 'block';

    document.getElementById('mv-refresh-btn')?.addEventListener('click', () => loadMasterViewData());
    document.getElementById('mv-discord-post-btn')?.addEventListener('click', () => openDiscordPostModal());
    loadMasterViewData();
}

// ==================== DISCORD WEBHOOK LOGIK ====================

async function getWebhookUrl() {
    try {
        const webhookDoc = await getDoc(doc(db, 'raid-tool-data', 'discord-webhook'));
        return webhookDoc.exists() ? webhookDoc.data().url || '' : '';
    } catch (e) {
        console.error('Webhook laden fehlgeschlagen:', e);
        return '';
    }
}

async function saveWebhookUrl(url) {
    await setDoc(doc(db, 'raid-tool-data', 'discord-webhook'), { url: url }, { merge: true });
}

function getBaseUrl() {
    const loc = window.location;
    return window.location.origin + window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
}

async function openDiscordPostModal() {
    if (!window.isManager) return window.showModal("Nur Manager können Discord-Posts erstellen.");

    const selectedRaidId = document.getElementById('raid-selector').value;
    const raidInfo = (typeof window.raidData !== 'undefined') ? window.raidData[selectedRaidId] : null;
    if (!raidInfo || !raidInfo.bosses) return window.showModal("Keine Raid-Daten gefunden.");

    const savedWebhook = await getWebhookUrl();

    // 1. Lade-Fenster anzeigen
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-[100] p-4';
    modal.innerHTML = `
        <div class="bg-slate-900 border border-gold-border rounded-lg p-6 max-w-2xl w-full shadow-2xl flex flex-col max-h-[90vh]">
            <h3 class="text-xl font-bold text-gold mb-4"><i class="fab fa-discord mr-2 text-indigo-400"></i>Discord Post erstellen</h3>
            <div id="discord-modal-content" class="flex-1 flex justify-center items-center min-h-[200px]">
                <p class="text-gray-400 animate-pulse"><i class="fas fa-spinner fa-spin mr-2"></i>Scanne Boss-Einteilungen...</p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // 2. Boss-HTMLs laden
    const bossHtmls = await Promise.all(raidInfo.bosses.map(async b => {
        try {
            const resp = await fetch(`${selectedRaidId}/${b.id}.html`);
            return resp.ok ? await resp.text() : '';
        } catch(e) { return ''; }
    }));

    // 3. Intelligente Scan-Logik (Mit Ausnahmen + LaneGroups-Erweiterung)
    const bossStructures = await Promise.all(raidInfo.bosses.map(async (boss, idx) => {
        const html = bossHtmls[idx];
        let blocks = [];

        // --- AUSNAHMEN FÜR SPEZIELLE BOSSE ---
        if (boss.id === 'ji-kun') {
            blocks = ["Rotation (NHC)", "Rotation (HC)", "Teams (1-5)"];
        }
        else if (boss.id === 'dark-animus') {
            blocks = ["Links (A)", "Rechts (B)", "Boss (C)", "Spezialaufgaben"];
        }
        else if (boss.id === 'lei-shen') {
            blocks = ["Intermission 1 & 2", "Ball Baiter"];
        }
        else if (boss.id === 'twin-consorts') {
            blocks = ["🛡️ Tank-Einteilung", "🎨 Painter (Zeichner)", "✨ Aktivierungs-Reihenfolge", "📍 Positionen (17 Spieler)"];
        }
        else if (boss.id === 'iron-qon') {
            blocks = ["Tanks & BoP", "Positionen (Ranged & Healer)", "Positionen (Melee)", "Soak Teams"];
        }
        // --- NEUE BOSS-SPEZIFISCHE BLÖCKE ---
        else if (boss.id === 'sha-of-pride') {
            blocks = ["🌈 Sha-Platten (WA-String)"];
        }
        else if (boss.id === 'norushen') {
            blocks = ["🔮 Orb-Reihenfolge (WA-String)"];
        }
        else if (boss.id === 'siegecrafter') {
            blocks = ["⚙️ Kill-Reihenfolge (WA-String)", "📏 Conveyor-Lines (WA-String)"];
        }
        else if (boss.id === 'paragons') {
            blocks = ["🎯 Paragons Kill-Reihenfolge (WA-String)"];
        }
        // --- STANDARD-ERKENNUNG ---
        else if (html) {
            const parser = new DOMParser();
            const doc2 = parser.parseFromString('<div>' + html + '</div>', 'text/html');
            const assignSection = doc2.querySelector('#assignments .collapsible-content');
            if (assignSection) {
                assignSection.querySelectorAll('.assignment-block').forEach(block => {
                    if (block.querySelector('.assignment-select') || block.querySelector('.assignment-text-input')) {
                        const titleEl = block.querySelector('h4') || block.querySelector('h3');
                        if (titleEl) blocks.push(titleEl.textContent.trim());
                    }
                });
            }
        }

        // --- LANEGROUPS-BLÖCKE AUS FIRESTORE NACHLADEN ---
        // Wenn der Boss LaneGroups verwendet, sind die Block-Titel nicht im
        // HTML sondern in Firestore (`{assignmentId}.blocks[].title`).
        try {
            const fb = window.firebaseTools;
            if (fb && fb.db && fb.doc && fb.getDoc) {
                const snap = await fb.getDoc(fb.doc(fb.db, 'raid-tool-data', 'boss-' + boss.id));
                if (snap.exists()) {
                    const data = snap.data();
                    Object.keys(data).forEach(key => {
                        const v = data[key];
                        if (v && typeof v === 'object' && Array.isArray(v.blocks)) {
                            v.blocks.forEach(blk => {
                                if (blk && blk.title) {
                                    const label = `📋 ${blk.title}`;
                                    if (!blocks.includes(label)) blocks.push(label);
                                }
                            });
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('[Discord-Modal] LaneGroups-Blocks für', boss.id, 'konnten nicht geladen werden:', e);
        }

        return { ...boss, blocks };
    }));

    // 4. Anzeige-Oberfläche aufbauen
    const contentDiv = modal.querySelector('#discord-modal-content');
    contentDiv.className = 'flex-1 overflow-y-auto pr-2 flex flex-col custom-scrollbar';
    contentDiv.innerHTML = `
        <div class="mb-4 shrink-0">
            <label class="block text-sm font-medium text-gray-300 mb-1">Webhook-URL</label>
            <div class="flex gap-2">
                <input type="url" id="discord-webhook-input" value="${savedWebhook}"
                       class="flex-1 bg-slate-800 text-white p-2 rounded border border-slate-600 focus:border-gold focus:outline-none text-sm"
                       placeholder="https://discord.com/api/webhooks/...">
                <button id="discord-save-webhook-btn" class="bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 px-3 rounded text-sm">
                    <i class="fas fa-save"></i>
                </button>
            </div>
        </div>

        <div class="mb-4 shrink-0">
            <label class="block text-sm font-medium text-gray-300 mb-2">Globale Boss-Inhalte</label>
            <div class="flex flex-wrap gap-4 bg-slate-800/50 p-3 rounded border border-slate-700">
                <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white">
                    <input type="checkbox" id="discord-inc-cds" checked class="accent-gold"> CD-Planer
                </label>
                <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white">
                    <input type="checkbox" id="discord-inc-image" checked class="accent-gold"> Positionierungsbild
                </label>
                <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white">
                    <input type="checkbox" id="discord-inc-tactics" class="accent-gold"> Taktik-Kurzübersicht
                </label>
            </div>
        </div>

        <div class="mb-4 flex-1 flex flex-col min-h-0">
            <div class="flex justify-between items-center mb-2 shrink-0">
                <label class="block text-sm font-medium text-gray-300">Bosse & Einteilungen auswählen</label>
                <div class="flex gap-2">
                    <button id="discord-select-all" class="text-xs bg-slate-700 hover:bg-slate-600 text-white px-2 py-1 rounded">Alle</button>
                    <button id="discord-select-none" class="text-xs bg-slate-700 hover:bg-slate-600 text-white px-2 py-1 rounded">Keine</button>
                </div>
            </div>
            
            <div id="discord-boss-checkboxes" class="space-y-3 bg-slate-800/50 p-3 rounded border border-slate-700 overflow-y-auto flex-1">
                ${bossStructures.map(b => `
                    <div class="border border-slate-600 rounded bg-slate-800 p-2 shadow-sm">
                        <label class="flex items-center gap-2 text-sm font-bold text-gold cursor-pointer mb-1 hover:text-yellow-300 transition-colors">
                            <input type="checkbox" value="${b.id}" class="discord-boss-cb accent-gold" checked>
                            <span>${b.name}</span>
                        </label>
                        ${b.blocks.length > 0 ? `
                            <div class="ml-6 grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2 discord-block-container" data-boss="${b.id}">
                                ${b.blocks.map(blockName => `
                                    <label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer hover:text-white transition-colors">
                                        <input type="checkbox" value="${blockName.replace(/"/g, '&quot;')}" class="discord-block-cb accent-emerald-500" checked>
                                        <span class="truncate" title="${blockName.replace(/"/g, '&quot;')}">${blockName}</span>
                                    </label>
                                `).join('')}
                            </div>
                        ` : '<div class="ml-6 text-xs text-gray-500 italic">Keine detaillierten Einteilungsblöcke vorhanden</div>'}
                        <div class="ml-6 mt-2">
                            <textarea data-boss-note="${b.id}" class="w-full bg-slate-900 border border-slate-700 text-gray-300 text-xs p-1.5 rounded focus:border-gold focus:outline-none transition-colors" rows="1" placeholder="Optionale Notiz / Ansage für ${b.name} dazuschreiben..."></textarea>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>

        <div id="discord-post-status" class="mb-2 shrink-0" style="display:none;"></div>

        <div class="flex gap-3 justify-end pt-4 border-t border-slate-700 shrink-0">
            <button id="discord-preview-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm">
                <i class="fas fa-eye mr-1"></i>Vorschau
            </button>
            <button id="discord-send-btn" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded text-sm">
                <i class="fab fa-discord mr-1"></i>Absenden
            </button>
            <button id="discord-cancel-btn" class="bg-slate-600 hover:bg-slate-500 text-white font-bold py-2 px-4 rounded text-sm">
                Abbrechen
            </button>
        </div>

        <div id="discord-preview-area" class="mt-4 shrink-0" style="display:none;"></div>
    `;

    // --- Verhalten der Auswahlkästchen ---
    modal.querySelectorAll('.discord-boss-cb').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const container = e.target.closest('div.border').querySelector('.discord-block-container');
            if (container) {
                container.querySelectorAll('.discord-block-cb').forEach(subCb => subCb.checked = e.target.checked);
            }
        });
    });

    modal.querySelectorAll('.discord-block-cb').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const bossContainer = e.target.closest('div.border');
            const bossCb = bossContainer.querySelector('.discord-boss-cb');
            const allSubCbs = Array.from(bossContainer.querySelectorAll('.discord-block-cb'));
            bossCb.checked = allSubCbs.some(c => c.checked);
        });
    });

    document.getElementById('discord-cancel-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    document.getElementById('discord-save-webhook-btn').addEventListener('click', async () => {
        const url = document.getElementById('discord-webhook-input').value.trim();
        if (!url) return window.showModal('Bitte eine Webhook-URL eingeben.');
        await saveWebhookUrl(url);
        window.showModal('Webhook-URL gespeichert!');
    });

    document.getElementById('discord-select-all').addEventListener('click', () => {
        modal.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    });
    
    document.getElementById('discord-select-none').addEventListener('click', () => {
        modal.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    });

    const getSelectionState = () => {
        const state = { bosses: [], blocks: {}, notes: {} };
        modal.querySelectorAll('.discord-boss-cb:checked').forEach(cb => {
            state.bosses.push(cb.value);
            const blockContainer = cb.closest('div.border').querySelector('.discord-block-container');
            if (blockContainer) {
                const checkedBlocks = Array.from(blockContainer.querySelectorAll('.discord-block-cb:checked')).map(b => b.value);
                state.blocks[cb.value] = checkedBlocks;
            } else {
                state.blocks[cb.value] = [];
            }
        });
        modal.querySelectorAll('textarea[data-boss-note]').forEach(ta => {
            if (ta.value.trim()) state.notes[ta.dataset.bossNote] = ta.value.trim();
        });
        return state;
    };

    // Vorschau
    document.getElementById('discord-preview-btn').addEventListener('click', async () => {
        const selection = getSelectionState();
        const embeds = await buildDiscordEmbeds(raidInfo, selection);
        const previewArea = document.getElementById('discord-preview-area');
        previewArea.style.display = 'block';

        if (embeds.length === 0) {
            previewArea.innerHTML = '<p class="text-amber-400 text-sm">Keine Bosse ausgewählt oder keine Daten gefunden.</p>';
            return;
        }

        previewArea.innerHTML = `
            <h4 class="text-sm font-bold text-gray-400 mb-2">Vorschau (${embeds.length} Blöcke):</h4>
            <div class="space-y-2 max-h-64 overflow-y-auto">
                ${embeds.map(e => `
                    <div class="bg-slate-800 border-l-4 border-indigo-500 p-3 rounded text-sm">
                        <div class="font-bold text-indigo-300">${e.title || 'Kein Titel'}</div>
                        <pre class="text-xs text-gray-400 mt-1 whitespace-pre-wrap font-sans max-h-32 overflow-y-auto">${(e.description || '').substring(0, 500)}${(e.description || '').length > 500 ? '...' : ''}</pre>
                        ${e.image ? `<div class="text-xs text-green-400 mt-1"><i class="fas fa-image mr-1"></i>Bild vorhanden</div>` : ''}
                    </div>
                `).join('')}
            </div>`;
    });

    // Absenden (Ein Boss pro Nachricht mit 1,5 Sekunden Pause)
    document.getElementById('discord-send-btn').addEventListener('click', async () => {
        const webhookUrl = document.getElementById('discord-webhook-input').value.trim();
        if (!webhookUrl) return window.showModal('Bitte zuerst eine Webhook-URL eingeben und speichern.');

        const selection = getSelectionState();
        if (selection.bosses.length === 0) return window.showModal('Keine Bosse ausgewählt.');

        const embeds = await buildDiscordEmbeds(raidInfo, selection);
        if (embeds.length === 0) return window.showModal('Es gibt keine Daten zum Senden.');

        const statusDiv = document.getElementById('discord-post-status');
        statusDiv.style.display = 'block';
        statusDiv.innerHTML = '<p class="text-blue-400 text-sm animate-pulse"><i class="fas fa-spinner fa-spin mr-1"></i>Sende an Discord...</p>';

        try {
            // Senden mit 1,5 Sekunden Pause zwischen jedem Boss
            for (let i = 0; i < embeds.length; i++) {
                const payload = {
                    username: 'P Ä N I K Raidsheet',
                    // Der Titel mit dem Raid-Namen wird nur bei der allerersten Nachricht angehängt
                    content: i === 0 ? `📜 **${raidInfo.name}** — Einteilungen` : '',
                    // Exakt ein Boss-Block wird in diese Nachricht eingefügt
                    embeds: [embeds[i]]
                };

                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Verbindungsfehler ${response.status}: ${errText}`);
                }
                
                // 1,5 Sekunden Pause einlegen (außer nach der letzten Nachricht)
                if (i < embeds.length - 1) {
                    statusDiv.innerHTML = `<p class="text-amber-400 text-sm animate-pulse"><i class="fas fa-hourglass-half mr-1"></i>Boss gesendet (${i + 1}/${embeds.length}). Warte 1,5 Sekunden...</p>`;
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }

            statusDiv.innerHTML = `<p class="text-green-400 text-sm"><i class="fas fa-check-circle mr-1"></i>Erfolgreich gepostet! Alle ${embeds.length} Bosse wurden gesendet.</p>`;
            const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
            window.logHistory('Discord', `Post gesendet: ${raidInfo.name}`, `${embeds.length} Bosse gesendet`, currentManager);

        } catch (error) {
            statusDiv.innerHTML = `<p class="text-red-400 text-sm"><i class="fas fa-times-circle mr-1"></i>Fehler: ${error.message}</p>`;
        }
    });
}

async function buildDiscordEmbeds(raidInfo, selection) {
    const selectedBosses = selection.bosses;
    const incCDs = document.getElementById('discord-inc-cds').checked;
    const incImage = document.getElementById('discord-inc-image').checked;
    const incTactics = document.getElementById('discord-inc-tactics').checked;

    if (selectedBosses.length === 0) return [];

    const baseUrl = "https://mazls.github.io/paniksheet/";
    const selectedRaidId = document.getElementById('raid-selector').value;

    const bossInfos = raidInfo.bosses.filter(b => selectedBosses.includes(b.id));
    
    // Alles parallel laden
    const [snapshots, bossPages] = await Promise.all([
        Promise.all(bossInfos.map(b => window.firebaseTools.getDoc(window.firebaseTools.doc(window.firebaseTools.db, 'raid-tool-data', 'boss-' + b.id)))),
        Promise.all(bossInfos.map(async b => {
            try {
                const resp = await fetch(`${selectedRaidId}/${b.id}.html`);
                return resp.ok ? await resp.text() : '';
            } catch(e) { return ''; }
        }))
    ]);

    const embeds = [];

    snapshots.forEach((snap, idx) => {
        const boss = bossInfos[idx];
        const data = snap.exists() ? snap.data() : {};
        const pageHtml = bossPages[idx] || '';
        const allowedBlocks = selection.blocks[boss.id] || [];

        // Die richtige URL mit Hashtag-Routing
        const bossUrl = `${baseUrl}#${selectedRaidId}/${boss.id}`;

        let description = '';

        // --- Custom Note des Users einfügen ---
        if (selection.notes[boss.id]) {
            description += `📝 **Ansage / Notiz:**\n${selection.notes[boss.id]}\n\n`;
        }

        if (pageHtml && allowedBlocks.length > 0) {
            
            // --- CUSTOM PARSER: JI-KUN ---
            if (boss.id === 'ji-kun') {
                if (allowedBlocks.includes("Teams (1-5)")) {
                    let teamLines = [];
                    for (let t = 1; t <= 5; t++) {
                        let players = [];
                        for (let p = 1; p <= 5; p++) {
                            const pName = data[`jikun-team-${t}-p${p}`]?.player;
                            if (pName && pName !== '—') players.push(pName);
                        }
                        if (players.length > 0) teamLines.push(`> **Team ${t}:** ${players.join(', ')}`);
                    }
                    if (teamLines.length > 0) description += `\n**Teams (1-5)**\n${teamLines.join('\n')}\n`;
                }
                
                const hcChecked = allowedBlocks.includes("Rotation (HC)");
                const nhcChecked = allowedBlocks.includes("Rotation (NHC)");
                
                if (hcChecked || nhcChecked) {
                    const doc2 = new DOMParser().parseFromString('<div>' + pageHtml + '</div>', 'text/html');
                    const tablesToProcess = [];
                    if (nhcChecked) tablesToProcess.push({ id: '#body-nhc', name: 'NHC' });
                    if (hcChecked) tablesToProcess.push({ id: '#body-hc', name: 'HC' });
                    
                    tablesToProcess.forEach(t => {
                        const tbody = doc2.querySelector(t.id);
                        if (tbody) {
                            description += `\n**Rotation (${t.name})**\n`;
                            tbody.querySelectorAll('tr').forEach(row => {
                                const cells = row.querySelectorAll('td');
                                if (cells.length >= 4) {
                                    const wave = cells[0].textContent.trim();
                                    const time = cells[1].textContent.trim();
                                    const nestA = cells[2].textContent.replace(/\s+/g, ' ').trim();
                                    const nestB = cells[3].textContent.replace(/\s+/g, ' ').trim();
                                    
                                    const cleanNestA = nestA.replace(/Tank benötigt/g, '').replace(/🛡️/g, '').trim();
                                    const cleanNestB = nestB.replace(/Tank benötigt/g, '').replace(/🛡️/g, '').trim();

                                    let line = `> **#${wave}** (${time}) ➜ ${cleanNestA}`;
                                    if (cleanNestB !== '-' && cleanNestB !== '') line += ` | ${cleanNestB}`;
                                    description += line + '\n';
                                }
                            });
                        }
                    });
                }
            } 
            
            // --- CUSTOM PARSER: DUNKLER ANIMUS ---
            else if (boss.id === 'dark-animus') {
                const groups = [
                    { id: "Links (A)", keys: ['animus_a', 'animus_1a', 'animus_2a', 'animus_3a', 'animus_4a', 'animus_5a', 'animus_6a', 'animus_7a', 'animus_8a', 'animus_9a', 'animus_10a', 'animus_11a'] },
                    { id: "Rechts (B)", keys: ['animus_b', 'animus_1b', 'animus_2b', 'animus_3b', 'animus_4b', 'animus_5b', 'animus_6b', 'animus_7b', 'animus_8b', 'animus_9b', 'animus_10b', 'animus_11b'] },
                    { id: "Boss (C)", keys: ['animus_c', 'animus_1c', 'animus_2c', 'animus_3c'] },
                    { id: "Spezialaufgaben", keys: ['animus_ring_soaker_1', 'animus_ring_soaker_2', 'animus_swap_baiter_1', 'animus_swap_baiter_2', 'animus_dispeller_1', 'animus_dispeller_2'] }
                ];

                groups.forEach(g => {
                    if (allowedBlocks.includes(g.id)) {
                        let lines = [];
                        g.keys.forEach(k => {
                            const pName = data[k]?.player;
                            if (pName && pName !== '—') {
                                let label = k.replace('animus_', '').toUpperCase();
                                if (label.includes('RING_SOAKER')) label = label.replace('RING_SOAKER_', 'Ring Soaker ');
                                else if (label.includes('SWAP_BAITER')) label = label.replace('SWAP_BAITER_', 'Materientausch ');
                                else if (label.includes('DISPELLER')) label = label.replace('DISPELLER_', 'Dispeller ');
                                
                                lines.push(`> **${label}:** ${pName}`);
                            }
                        });
                        if (lines.length > 0) {
                            description += `\n**${g.id}**\n${lines.join('\n')}\n`;
                        }
                    }
                });
            }

            // --- CUSTOM PARSER: LEI SHEN ---
            else if (boss.id === 'lei-shen') {
                if (allowedBlocks.includes("Intermission 1 & 2")) {
                    const intGroups = [
                        { name: "🟦 Quadrat", prefix: "lei_int1_sq_" },
                        { name: "🟩 Dreieck", prefix: "lei_int1_tri_" },
                        { name: "🟪 Diamant", prefix: "lei_int1_dia_" },
                        { name: "🟥 Kreuz", prefix: "lei_int1_cross_" }
                    ];
                    
                    let intLines = [];
                    intGroups.forEach(g => {
                        let players = [];
                        for(let i=1; i<=6; i++) {
                            const p = data[`${g.prefix}${i}`]?.player;
                            if (p && p !== '—') players.push(p);
                        }
                        
                        let extraPlayers = [];
                        for(let i=1; i<=2; i++) {
                            const p = data[`${g.prefix}ex${i}`]?.player;
                            if (p && p !== '—') extraPlayers.push(p);
                        }
                        
                        if (players.length > 0) {
                            let line = `> **${g.name}:** ${players.join(', ')}`;
                            if (extraPlayers.length > 0) line += ` *(P2 Extra: ${extraPlayers.join(', ')})*`;
                            intLines.push(line);
                        }
                    });
                    
                    if (intLines.length > 0) {
                        description += `\n**Intermissions**\n${intLines.join('\n')}\n`;
                    }
                }

                if (allowedBlocks.includes("Ball Baiter")) {
                    let baiters = [];
                    for(let i=1; i<=8; i++) {
                        const p = data[`lei_baiter_${i}`]?.player;
                        if (p && p !== '—') baiters.push(p);
                    }
                    if (baiters.length > 0) {
                        description += `\n**⚽ Ball Baiter**\n> ${baiters.join(' | ')}\n`;
                    }
                }
            }

            // --- CUSTOM PARSER: ZWILLINGSKONKUBINEN ---
            else if (boss.id === 'twin-consorts') {
                if (allowedBlocks.some(b => b.includes("Tank-Einteilung"))) {
                    let lines = [];
                    [1, 2].forEach(i => {
                        const p = data[`twins-tank${i}`]?.player;
                        if (p && p !== '—') lines.push(`> **Tank ${i}:** ${p}`);
                    });
                    if (lines.length > 0) description += `\n**🛡️ Tank-Einteilung**\n${lines.join('\n')}\n`;
                }

                if (allowedBlocks.some(b => b.includes("Painter"))) {
                    let lines = [];
                    [1, 2].forEach(i => {
                        const p = data[`twins-painter-${i}`]?.player;
                        if (p && p !== '—') lines.push(`> **Painter ${i}:** ${p}`);
                    });
                    if (lines.length > 0) description += `\n**🎨 Painter (Zeichner)**\n${lines.join('\n')}\n`;
                }

                if (allowedBlocks.some(b => b.includes("Aktivierungs-Reihenfolge"))) {
                    const seq = [
                        { id: 'twins_seq_pull', label: 'Bei Pull' },
                        { id: 'twins_seq_p2_start', label: 'P2 Start' },
                        { id: 'twins_seq_inferno_1', label: 'Nukleares Inferno 1' },
                        { id: 'twins_seq_inferno_2', label: 'Nukleares Inferno 2' },
                        { id: 'twins_seq_p3_start', label: 'P3 Start' },
                        { id: 'twins_seq_tide_2', label: 'Gezeitenkraft 2' },
                        { id: 'twins_seq_tide_3', label: 'Gezeitenkraft 3' },
                        { id: 'twins_seq_opt', label: '? (Optional)' }
                    ];
                    let lines = [];
                    seq.forEach(s => {
                        const val = data[s.id]?.text || data[s.id]?.player || data[s.id]?.value || data[s.id];
                        let finalVal = typeof val === 'object' ? (val.text || val.player) : val;
                        if (finalVal && finalVal !== '—' && finalVal !== '- Wählen -') {
                            lines.push(`> **${s.label}:** ${finalVal}`);
                        }
                    });
                    if (lines.length > 0) description += `\n**✨ Aktivierungs-Reihenfolge**\n${lines.join('\n')}\n`;
                }

                if (allowedBlocks.some(b => b.includes("Positionen (17 Spieler)"))) {
                    let posLines = [];
                    for(let i=1; i<=17; i++) {
                        const p = data[`twins_celestial_${i}`]?.player;
                        if (p && p !== '—') posLines.push(`> **Position ${i}:** ${p}`);
                    }
                    if (posLines.length > 0) description += `\n**📍 Positionen (17 Spieler)**\n${posLines.join('\n')}\n`;
                }
            }

            // --- CUSTOM PARSER: EISERNER QON ---
            else if (boss.id === 'iron-qon') {
                if (allowedBlocks.includes("Tanks & BoP")) {
                    let lines = [];
                    const t1 = data['qon-tank1']?.player;
                    const t2 = data['qon-tank2']?.player;
                    if (t1 && t1 !== '—') lines.push(`> **MT (Boss):** ${t1}`);
                    if (t2 && t2 !== '—') lines.push(`> **OT (Add/Swap):** ${t2}`);
                    
                    const b1 = data['qon-bop1']?.player;
                    const b2 = data['qon-bop2']?.player;
                    let bops = [];
                    if (b1 && b1 !== '—') bops.push(b1);
                    if (b2 && b2 !== '—') bops.push(b2);
                    if (bops.length > 0) lines.push(`> **BoP Impale:** ${bops.join(', ')}`);
                    
                    if (lines.length > 0) description += `\n**🛡️ Tanks & Spezialaufgaben**\n${lines.join('\n')}\n`;
                }

                if (allowedBlocks.includes("Positionen (Ranged & Healer)")) {
                    const groups = [
                        { name: "R1 (Mond)", ids: [1, 2] },
                        { name: "R2 (Diamant)", ids: [3, 4] },
                        { name: "H1 (Kreuz)", ids: [5, 6] },
                        { name: "R3 (Quadrat)", ids: [7, 8] },
                        { name: "R4 (Kreis)", ids: [9, 10] },
                        { name: "R5 (Totenkopf)", ids: [11, 12] },
                        { name: "H2 (Dreieck)", ids: [13, 14] },
                        { name: "R6 (Stern)", ids: [15, 16] }
                    ];
                    let lines = [];
                    groups.forEach(g => {
                        let pList = [];
                        g.ids.forEach(id => {
                            const p = data[`qon_pos_${id}`]?.player;
                            if (p && p !== '—') pList.push(p);
                        });
                        if (pList.length > 0) lines.push(`> **${g.name}:** ${pList.join(' | ')}`);
                    });
                    if (lines.length > 0) description += `\n**✨ Ranged & Healer Positionen**\n${lines.join('\n')}\n`;
                }

                if (allowedBlocks.includes("Positionen (Melee)")) {
                    let lines = [];
                    for (let i = 1; i <= 3; i++) {
                        let pList = [];
                        const offset = 16 + (i - 1) * 4;
                        for (let j = 1; j <= 4; j++) {
                            const p = data[`qon_pos_${offset + j}`]?.player;
                            if (p && p !== '—') pList.push(p);
                        }
                        if (pList.length > 0) lines.push(`> **M${i}:** ${pList.join(', ')}`);
                    }
                    if (lines.length > 0) description += `\n**⚔️ Melee Gruppen**\n${lines.join('\n')}\n`;
                }

                if (allowedBlocks.includes("Soak Teams")) {
                    let lines = [];
                    [1, 2].forEach(team => {
                        let pList = [];
                        for (let i = 1; i <= 5; i++) {
                            const p = data[`qon-soak${team}-${i}`]?.player;
                            if (p && p !== '—') pList.push(p);
                        }
                        if (pList.length > 0) lines.push(`> **Team ${team}:** ${pList.join(', ')}`);
                    });
                    if (lines.length > 0) description += `\n**🔥 P1 Soak Teams**\n${lines.join('\n')}\n`;
                }
            }

            // --- CUSTOM PARSER: SHA-OF-PRIDE PLATTEN ---
            else if (boss.id === 'sha-of-pride') {
                if (allowedBlocks.some(b => b.includes("Sha-Platten"))) {
                    const shaStr = buildShaPlatesExport(data);
                    if (shaStr) {
                        description += `\n**🌈 Sha-Platten (WeakAura)**\n\`\`\`\n${shaStr}\n\`\`\`\n`;
                    }
                }
            }

            // --- CUSTOM PARSER: NORUSHEN ORB-REIHENFOLGE ---
            else if (boss.id === 'norushen') {
                if (allowedBlocks.some(b => b.includes("Orb-Reihenfolge"))) {
                    const orbStr = buildNorushenOrbExport(data);
                    if (orbStr) {
                        description += `\n**🔮 Orb-Reihenfolge (WeakAura)**\n\`\`\`\n${orbStr}\n\`\`\`\n`;
                    }
                }
            }

            // --- CUSTOM PARSER: SIEGECRAFTER (Killorder + Lines) ---
            else if (boss.id === 'siegecrafter') {
                if (allowedBlocks.some(b => b.includes("Kill-Reihenfolge"))) {
                    const koStr = buildSiegecrafterKillorderExport(data);
                    if (koStr) {
                        description += `\n**⚙️ Kill-Reihenfolge (WeakAura)**\n\`\`\`\n${koStr}\n\`\`\`\n`;
                    }
                }
                if (allowedBlocks.some(b => b.includes("Conveyor-Lines"))) {
                    const linesStr = buildSiegecrafterLinesExport(data);
                    if (linesStr) {
                        description += `\n**📏 Conveyor-Lines (WeakAura)**\n\`\`\`\n${linesStr}\n\`\`\`\n`;
                    }
                }
            }

            // --- CUSTOM PARSER: PARAGONS KILL-REIHENFOLGE ---
            else if (boss.id === 'paragons') {
                if (allowedBlocks.some(b => b.includes("Paragons Kill-Reihenfolge"))) {
                    const koStr = buildParagonsKillorderExport(data);
                    if (koStr) {
                        description += `\n**🎯 Kill-Reihenfolge (WeakAura)**\n\`\`\`\n${koStr}\n\`\`\`\n`;
                    }
                }
            }

            // --- GENERIC PARSER: Für alle anderen Bosse ---
            else {
                const parser = new DOMParser();
                const doc2 = parser.parseFromString('<div>' + pageHtml + '</div>', 'text/html');
                const assignSection = doc2.querySelector('#assignments .collapsible-content');
                
                if (assignSection) {
                    assignSection.querySelectorAll('.assignment-block').forEach(block => {
                        const titleEl = block.querySelector('h4') || block.querySelector('h3');
                        const blockTitle = titleEl ? titleEl.textContent.trim() : '';

                        if (!allowedBlocks.includes(blockTitle)) return; 

                        const selects = block.querySelectorAll('.assignment-select');
                        if (selects.length === 0) return;
                        
                        const table = block.querySelector('table');
                        
                        if (table) {
                            description += `\n**${blockTitle}**\n`;
                            const rows = table.querySelectorAll('tbody tr');
                            rows.forEach(row => {
                                const markCell = row.querySelector('td:first-child');
                                const markName = markCell ? markCell.textContent.trim() : '';
                                const rowSelects = row.querySelectorAll('.assignment-select');
                                const players = Array.from(rowSelects).map(sel => {
                                    const id = sel.dataset.assignmentId;
                                    return data[id]?.player || '—';
                                });
                                if (players.some(p => p !== '—')) {
                                    description += `> ${markName}: ${players.join(' | ')}\n`;
                                }
                            });
                        } else {
                            const lines = [];
                            block.querySelectorAll('.assignment-list li').forEach(li => {
                                const label = li.querySelector('span');
                                const sel = li.querySelector('.assignment-select');
                                if (!sel || !label) return;
                                if (li.classList.contains('list-subheader')) return;
                                
                                const id = sel.dataset.assignmentId;
                                const val = data[id]?.player || '';
                                if (val) {
                                    lines.push(`> **${label.textContent.trim()}** ${val}`);
                                }
                            });
                            if (lines.length > 0) {
                                description += `\n**${blockTitle}**\n${lines.join('\n')}\n`;
                            }
                        }
                    });
                }
            }

            // --- LANEGROUPS BLÖCKE (boss-übergreifend, aus Firestore) ---
            // Wird zusätzlich zu den Custom-Parsern oben ausgeführt, da
            // LaneGroups-Blöcke unabhängig vom HTML im Firestore-Doc liegen.
            Object.keys(data).forEach(key => {
                const v = data[key];
                if (!v || typeof v !== 'object' || !Array.isArray(v.blocks)) return;
                v.blocks.forEach(block => {
                    const label = `📋 ${block.title || '(Unbenannt)'}`;
                    if (!allowedBlocks.includes(label)) return;
                    const lines = [];
                    (block.lanes || []).forEach((lane, li) => {
                        const players = (lane.slots || [])
                            .map(s => resolveSlotOrPlayer(s))
                            .filter(Boolean);
                        if (players.length === 0) return;
                        let prefix;
                        if (block.type === 'multi-lane') {
                            const m = LG_MARKER_BY_ID[lane.marker || ''] || LG_MARKER_BY_ID[''];
                            if (lane.title) prefix = `> **${m.emoji} ${lane.title}:**`;
                            else if (m.id)  prefix = `> **${m.emoji} ${m.label}:**`;
                            else            prefix = `> **Spalte ${li + 1}:**`;
                        } else {
                            prefix = `>`;
                        }
                        lines.push(`${prefix} ${players.join(', ')}`);
                    });
                    if (lines.length > 0) {
                        description += `\n**${block.title || '(Unbenannt)'}**\n${lines.join('\n')}\n`;
                    }
                });
            });
        }

        // --- CD-Planer ---
        if (incCDs) {
            const cdEntries = [];
            Object.keys(data).forEach(key => {
                if (!key.includes('-planner-row') || !key.endsWith('-player')) return;
                const playerVal = data[key]?.player;
                if (!playerVal) return;
                const baseKey = key.substring(0, key.lastIndexOf('-player'));
                const trigger = data[baseKey + '-trigger']?.player || '';
                if (!trigger) return;
                const cd = data[baseKey + '-cooldown']?.cooldown || '';
                const condition = data[baseKey + '-condition']?.text || '';
                const time = data[baseKey + '-time']?.text || '';
                const triggerClean = trigger.replace(/^[A-Z_]+_/, '').replace(/_/g, ' ');
                cdEntries.push({ triggerClean, condition, time, playerVal, cd });
            });

            const byTrigger = {};
            cdEntries.forEach(e => {
                const groupKey = `${e.condition || '0'}|${e.triggerClean}`;
                if (!byTrigger[groupKey]) byTrigger[groupKey] = { label: e.triggerClean, condition: e.condition, entries: [] };
                byTrigger[groupKey].entries.push(e);
            });

            const cdLines = [];
            Object.values(byTrigger).forEach(group => {
                const condLabel = group.condition ? `#${group.condition}` : '';
                cdLines.push(`**${condLabel} ${group.label}**`);
                group.entries.forEach(e => {
                    cdLines.push(`> ${e.time || '-'}s — ${e.playerVal} ➜ ${e.cd || '-'}`);
                });
            });

            if (cdLines.length > 0) {
                description += `\n⚡ **CD-Plan**\n${cdLines.join('\n')}\n`;
            }
        }

        // --- Taktik-Kurzübersicht ---
        if (incTactics && pageHtml) {
            const overviewMatch = pageHtml.match(/<section id="overview"[^>]*>[\s\S]*?<p class="mb-4">([\s\S]*?)<\/p>/);
            if (overviewMatch) {
                let tactics = overviewMatch[1]
                    .replace(/<strong[^>]*>/g, '**').replace(/<\/strong>/g, '**')
                    .replace(/<[^>]+>/g, '').trim();
                if (tactics.length > 300) tactics = tactics.substring(0, 297) + '...';
                description += `\n📖 **Kurzübersicht**\n${tactics}\n`;
            }
        }

        // Kürzung des Textes, um das Discord-Limit nicht zu überschreiten
        if (description.length > 3900) {
            description = description.substring(0, 3897) + '...';
        }

        // Direkten Link zur Boss-Seite unten anfügen
        if (description.trim() !== '') {
            description += `\n\n🔗 **[Zum vollständigen Raid Sheet für den Boss](${bossUrl})**`;
        }

        // --- Bild-URL ---
        let imageUrl = null;
        if (incImage && pageHtml) {
            const imgMatch = pageHtml.match(/<img[^>]*class="[^"]*(?:positioning-image|window.lightbox-trigger)[^"]*"[^>]*src="([^"]+)"/);
            if (!imgMatch) {
                const imgMatch2 = pageHtml.match(/<img[^>]*src="([^"]+)"[^>]*class="[^"]*(?:positioning-image|window.lightbox-trigger)[^"]*"/);
                if (imgMatch2) imageUrl = imgMatch2[1];
            } else {
                imageUrl = imgMatch[1];
            }
            if (imageUrl && !imageUrl.startsWith('http')) {
                imageUrl = new URL(imageUrl, baseUrl).href; 
            }
        }

        if (description.trim() || imageUrl) {
            const embed = {
                title: `⚔️ ${boss.name}`,
                url: bossUrl, 
                description: description.trim() || undefined,
                color: 0xFCD34D,
                footer: { text: 'P Ä N I K Raidsheet' }
            };
            if (imageUrl) embed.image = { url: imageUrl };
            embeds.push(embed);
        }
    });

    return embeds;
}

async function loadMasterViewData() {
    const accordion = document.getElementById('mv-accordion');
    if (!accordion) return;

    const selectedRaidId = document.getElementById('raid-selector').value;
    const raidInfo = (typeof window.raidData !== 'undefined') ? window.raidData[selectedRaidId] : null;
    if (!raidInfo || !raidInfo.bosses) {
        accordion.innerHTML = '<p class="text-gray-400">Keine Raid-Daten gefunden.</p>';
        return;
    }

    document.getElementById('mv-raid-label').textContent = raidInfo.name;
    accordion.innerHTML = '<p class="text-gray-400 animate-pulse"><i class="fas fa-spinner fa-spin mr-2"></i>Lade Daten aller Bosse...</p>';

    const roster = window.rosterData || [];
    const rosterNames = roster.map(p => p.name);

    try {
        const bossIds = raidInfo.bosses.map(b => ({ id: b.id, name: b.name, docId: 'boss-' + b.id }));
        
        // Boss-Daten UND HTML-Seiten parallel laden
        const [snapshots, bossPages] = await Promise.all([
            Promise.all(bossIds.map(b => getDoc(doc(db, 'raid-tool-data', b.docId)))),
            Promise.all(bossIds.map(async b => {
                try {
                    const resp = await fetch(`${selectedRaidId}/${b.id}.html`);
                    return resp.ok ? await resp.text() : '';
                } catch(e) { return ''; }
            }))
        ]);

        let totalAssigned = 0;
        let totalMissing = 0;
        let totalCDs = 0;

        accordion.innerHTML = '';

        snapshots.forEach((snap, idx) => {
            const boss = bossIds[idx];
            const data = snap.exists() ? snap.data() : {};
            const pageHtml = bossPages[idx] || '';

            // Zähle Assignments und CDs
            let filledCount = 0;
            let emptySelectCount = 0;
            let cdCount = 0;
            const assignedPlayers = new Set();
            const invalidPlayers = [];

            Object.keys(data).forEach(key => {
                if (key.includes('-planner-row')) {
                    if (key.endsWith('-player') && data[key]?.player) {
                        const baseKey = key.substring(0, key.lastIndexOf('-player'));
                        if (data[baseKey + '-trigger']?.player) cdCount++;
                    }
                } else {
                    const val = data[key];
                    if (val && typeof val === 'object' && val.player !== undefined) {
                        if (val.player && val.player.trim()) {
                            filledCount++;
                            const pName = val.player;
                            if (!['ALL','Niemand','DEATHKNIGHT','DRUID','HUNTER','MAGE','MONK','PALADIN','PRIEST','ROGUE','SHAMAN','WARLOCK','WARRIOR'].includes(pName)) {
                                assignedPlayers.add(pName);
                                if (!rosterNames.includes(pName)) invalidPlayers.push(pName);
                            }
                        } else {
                            emptySelectCount++;
                        }
                    }
                }
            });

            totalAssigned += filledCount;
            totalMissing += emptySelectCount;
            totalCDs += cdCount;

            // Boss-Panel rendern
            const contentId = `mv-content-${boss.id}`;
            const iconId = `mv-icon-${boss.id}`;
            const statusColor = emptySelectCount === 0 ? 'text-green-400' : 'text-amber-400';
            const statusIcon = emptySelectCount === 0 ? 'fa-check-circle' : 'fa-exclamation-circle';

            const panel = document.createElement('div');
            panel.className = 'rounded-lg border border-gold-border-light overflow-hidden bg-slate-800/40';
            panel.innerHTML = `
                <div class="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-700/30 transition-colors"
                     onclick="document.getElementById('${contentId}').classList.toggle('hidden'); document.getElementById('${iconId}').classList.toggle('rotate-90');">
                    <div class="flex items-center gap-3">
                        <i id="${iconId}" class="fas fa-chevron-right text-gold text-xs transition-transform duration-200"></i>
                        <span class="font-bold text-gold text-lg">${boss.name}</span>
                        <span class="${statusColor} text-sm"><i class="fas ${statusIcon} mr-1"></i>${filledCount} besetzt</span>
                        ${cdCount > 0 ? `<span class="text-purple-400 text-sm"><i class="fas fa-bolt mr-1"></i>${cdCount} CDs</span>` : ''}
                        ${invalidPlayers.length > 0 ? `<span class="text-red-400 text-sm"><i class="fas fa-user-times mr-1"></i>${invalidPlayers.length} nicht im Roster</span>` : ''}
                    </div>
                    <a href="#${selectedRaidId}/${boss.id}" class="text-xs text-blue-400 hover:text-blue-300 underline" onclick="event.stopPropagation();">
                        <i class="fas fa-external-link-alt mr-1"></i>Boss-Seite
                    </a>
                </div>
                <div id="${contentId}" class="hidden border-t border-gold-border-light">
                    <div class="p-4 mv-boss-content" data-mv-boss-id="${boss.id}" data-mv-boss-docid="${boss.docId}">
                        ${renderMasterViewFromHtml(pageHtml, boss)}
                    </div>
                </div>
            `;
            accordion.appendChild(panel);
        });

        // Stats aktualisieren
        const mvStatBosses = document.getElementById('mv-stat-bosses');
        if (mvStatBosses) {
            mvStatBosses.textContent = bossIds.length;
            document.getElementById('mv-stat-assigned').textContent = totalAssigned;
            document.getElementById('mv-stat-missing').textContent = totalMissing;
            document.getElementById('mv-stat-cds').textContent = totalCDs;
        }

        // Snapshot-Daten als Map aufbereiten, damit setMasterViewValues
        // sie nicht nochmal laden muss (spart N × getDoc Reads!)
        const snapshotDataMap = {};
        snapshots.forEach((snap, idx) => {
            const docId = bossIds[idx].docId;
            snapshotDataMap[docId] = snap.exists() ? snap.data() : {};
        });

        // Dropdowns befüllen und Werte setzen (mit bereits geladenen Daten)
        setTimeout(async () => {
            populateMasterViewDropdowns();
            await setMasterViewValues(snapshotDataMap);
            attachMasterViewChangeHandlers();
        }, 100);

    } catch (error) {
        console.error('Master-View Fehler:', error);
        accordion.innerHTML = `<p class="text-red-400">Fehler beim Laden: ${error.message}</p>`;
    }
}

function renderMasterViewFromHtml(pageHtml, boss) {
    if (!pageHtml) {
        return '<p class="text-gray-500 text-sm italic">Keine Boss-Seite gefunden. Erstelle die HTML-Datei für diesen Boss.</p>';
    }

    // Assignments-Section aus dem HTML extrahieren
    const parser = new DOMParser();
    const doc2 = parser.parseFromString('<div>' + pageHtml + '</div>', 'text/html');
    
    const assignmentsSection = doc2.querySelector('#assignments .collapsible-content');
    if (!assignmentsSection) {
        return '<p class="text-gray-500 text-sm italic">Keine Einteilungs-Section gefunden.</p>';
    }

    // Entferne Elemente die im Master-View nicht gebraucht werden:
    // - Positioning toggle/images/text (die kommen separat)
    // - Mutationen-Listen und andere Info-Blöcke ohne Selects
    // - Script-Tags
    assignmentsSection.querySelectorAll('script, #positioning-toggle, .positioning-image, .positioning-text, video, .video-wrapper').forEach(el => el.remove());

    // Entferne assignment-blocks die keine selects enthalten (reine Info-Blöcke).
    // AUSNAHME: Blöcke mit einem LaneGroups-Container (id endet auf "-lane-groups")
    // dürfen NICHT entfernt werden — der Container ist leer, weil LaneGroups erst
    // zur Laufzeit die UI rendert. Master-View-Integration füllt ihn dann.
    assignmentsSection.querySelectorAll('.assignment-block').forEach(block => {
        const hasSelects = !!(block.querySelector('.assignment-select') || block.querySelector('.assignment-text-input'));
        const hasLaneGroupsContainer = !!block.querySelector('[id$="-lane-groups"]');
        if (!hasSelects && !hasLaneGroupsContainer) {
            block.remove();
        }
    });

    // Visuelle Hilfen Section komplett entfernen (Bilder, Toggle etc.)
    const visualSection = assignmentsSection.querySelector('h3.text-blue-450');
    if (visualSection) {
        let parent = visualSection.closest('div');
        if (parent) parent.remove();
    }

    // Alle selects mit einer mv-spezifischen Klasse versehen
    assignmentsSection.querySelectorAll('.assignment-select').forEach(sel => {
        sel.classList.add('mv-assignment-select');
        // data-manual-options Selects nicht anfassen (Trigger etc.)
        if (sel.getAttribute('data-manual-options') === 'true') return;
    });

    // Text-Inputs ebenfalls
    assignmentsSection.querySelectorAll('.assignment-text-input').forEach(inp => {
        inp.classList.add('mv-text-input');
    });

    let html = assignmentsSection.innerHTML;

    // Bild extrahieren und als kompaktes Thumbnail unten anfügen
    const imgEl = doc2.querySelector('.positioning-image, .lightbox-trigger');
    if (imgEl) {
        const imgSrc = imgEl.getAttribute('src') || '';
        const imgAlt = imgEl.getAttribute('alt') || 'Positionierung';
        html += `
        <div class="mt-4 pt-3 border-t border-slate-700">
            <img src="${imgSrc}" alt="${imgAlt}" 
                 class="w-full max-w-md rounded border border-slate-600 cursor-pointer"
                 onclick="if(window.openLightbox) window.openLightbox(this.src);">
        </div>`;
    }

    return html;
}

function populateMasterViewDropdowns() {
    const roster = window.rosterData || [];
    document.querySelectorAll('.mv-assignment-select:not([data-manual-options="true"])').forEach(select => {
        if (select.options.length > 1) return; // Bereits gefüllt
        // Boss-ID aus dem nächsten mv-boss-content-Container holen für boss-spezifisches Slot-Mapping
        const bossContainer = select.closest('.mv-boss-content');
        const bossId = bossContainer ? bossContainer.dataset.mvBossDocid : null;
        window.populateDropdownOptions(select, roster, bossId);
        if (!window.isManager) select.disabled = true;
    });
}

async function setMasterViewValues(preloadedDataMap) {
    // Für jeden Boss-Content-Block die Werte setzen.
    // Wenn preloadedDataMap übergeben wird, verwenden wir die bereits geladenen
    // Daten und sparen uns den erneuten getDoc-Aufruf (N × Reads gespart!).
    const containers = document.querySelectorAll('.mv-boss-content');

    const bossDocIds = Array.from(containers).map(c => c.dataset.mvBossDocid).filter(Boolean);
    if (bossDocIds.length === 0) return;

    // Daten beschaffen: aus preloadedDataMap oder (Fallback) aus Firestore
    let dataMap;
    if (preloadedDataMap) {
        dataMap = preloadedDataMap;
    } else {
        // Fallback: Daten aus Firestore laden (z.B. bei externem Aufruf ohne Cache)
        const snapshots = await Promise.all(
            bossDocIds.map(docId => getDoc(doc(db, 'raid-tool-data', docId)))
        );
        dataMap = {};
        snapshots.forEach((snap, idx) => {
            dataMap[bossDocIds[idx]] = snap.exists() ? snap.data() : {};
        });
    }

    containers.forEach((container) => {
        const docId = container.dataset.mvBossDocid;
        if (!docId) return;
        const data = dataMap[docId];
        if (!data) return;

        // Selects befüllen
        container.querySelectorAll('.assignment-select').forEach(select => {
            const assignmentId = select.dataset.assignmentId;
            if (!assignmentId) return;
            
            const isManual = select.getAttribute('data-manual-options') === 'true';
            const isCooldown = assignmentId.toLowerCase().includes('cooldown');
            const val = data[assignmentId] ? (data[assignmentId].cooldown || data[assignmentId].player) : '';

            if (val && select.value !== val) {
                // Bei manuellen Selects: Wenn Option nicht existiert, überspringen
                if (isManual && !Array.from(select.options).some(o => o.value === val)) return;
                
                select.value = val;

                // Invalid-Check für Nicht-Roster Spieler
                const rosterNames = (window.rosterData || []).map(p => p.name);
                const ALLOWED = ['ALL','DEATHKNIGHT','DRUID','HUNTER','MAGE','MONK','PALADIN','PRIEST','ROGUE','SHAMAN','WARLOCK','WARRIOR','Niemand',''];
                if (val && !isCooldown && !isManual && !rosterNames.includes(val) && !ALLOWED.includes(val)) {
                    select.classList.add('invalid-assignment');
                    if (!Array.from(select.options).some(o => o.value === val)) {
                        const invalidOpt = new Option(`❌ ${val} (Nicht im Roster)`, val);
                        invalidOpt.className = 'invalid-option';
                        select.appendChild(invalidOpt);
                        select.value = val;
                    }
                }
            }

            // Klassenfarbe setzen
            const selectedOption = Array.from(select.options).find(o => o.value === val);
            if (selectedOption?.dataset?.color) {
                select.style.color = selectedOption.dataset.color;
            }
            // Bench-Spieler im geschlossenen Select kursiv darstellen
            select.style.fontStyle = (selectedOption?.dataset?.bench === '1') ? 'italic' : 'normal';
        });

        // Text-Inputs befüllen
        container.querySelectorAll('.assignment-text-input').forEach(input => {
            const assignmentId = input.dataset.assignmentId;
            if (!assignmentId) return;
            const val = data[assignmentId]?.text || data[assignmentId]?.player || '';
            if (input.value !== val) input.value = val;
        });
    });
}

function attachMasterViewChangeHandlers() {
    // Change-Handler für alle Master-View Selects
    document.querySelectorAll('.mv-boss-content').forEach(container => {
        const bossDocId = container.dataset.mvBossDocid;
        if (!bossDocId) return;

        container.querySelectorAll('.assignment-select').forEach(select => {
            if (select.dataset.mvListenerAttached) return;
            select.dataset.mvListenerAttached = 'true';

            select.addEventListener('change', async () => {
                if (!window.isManager) return;
                const assignmentId = select.dataset.assignmentId;
                if (!assignmentId) return;

                const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
                const valueToSave = select.value;
                const bossDocRef = doc(db, 'raid-tool-data', bossDocId);

                let dataToSave;
                if (assignmentId.toLowerCase().includes('cooldown')) {
                    dataToSave = { cooldown: valueToSave, editor: currentManager, timestamp: serverTimestamp() };
                } else {
                    dataToSave = { player: valueToSave, editor: currentManager, timestamp: serverTimestamp() };
                }

                await setDoc(bossDocRef, { [assignmentId]: dataToSave }, { merge: true });

                // Farbe aktualisieren
                const selectedOption = Array.from(select.options).find(o => o.value === valueToSave);
                select.style.color = selectedOption?.dataset?.color || '#fff';
                select.style.fontStyle = (selectedOption?.dataset?.bench === '1') ? 'italic' : 'normal';

                const bossName = bossDocId.replace('boss-', '');
                window.logHistory(bossName, `Einteilung (Übersicht): ${assignmentId}`, valueToSave || 'Niemand', currentManager);
            });
        });

        container.querySelectorAll('.assignment-text-input').forEach(input => {
            if (input.dataset.mvListenerAttached) return;
            input.dataset.mvListenerAttached = 'true';

            let timer;
            input.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    if (!window.isManager) return;
                    const assignmentId = input.dataset.assignmentId;
                    if (!assignmentId) return;

                    const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
                    const bossDocRef = doc(db, 'raid-tool-data', bossDocId);
                    const dataToSave = { text: input.value, editor: currentManager, timestamp: serverTimestamp() };
                    await setDoc(bossDocRef, { [assignmentId]: dataToSave }, { merge: true });
                }, 500);
            });
        });
    });
}


window.initMasterView = initMasterView;
window.getWebhookUrl = getWebhookUrl;
window.saveWebhookUrl = saveWebhookUrl;
window.getBaseUrl = getBaseUrl;
window.openDiscordPostModal = openDiscordPostModal;
window.buildDiscordEmbeds = buildDiscordEmbeds;
window.loadMasterViewData = loadMasterViewData;
window.renderMasterViewFromHtml = renderMasterViewFromHtml;
window.populateMasterViewDropdowns = populateMasterViewDropdowns;
window.setMasterViewValues = setMasterViewValues;
window.attachMasterViewChangeHandlers = attachMasterViewChangeHandlers;

// =============================================================================
// HISTORY-SEITE
// =============================================================================

        function initHistoryPage() {
            const q = query(historyCollectionRef, orderBy("timestamp", "desc"), limit(50));
            const tableBody = document.getElementById('history-table-body');
            if (!tableBody) return;
            window.historyUnsubscribe = onSnapshot(q, (querySnapshot) => {
                tableBody.innerHTML = '';
                querySnapshot.forEach((doc) => {
                    const data = doc.data();
                    const row = tableBody.insertRow();
                    row.innerHTML = `
                        <td class="px-6 py-4">${data.boss || 'Allgemein'}</td>
                        <td class="px-6 py-4">${data.assignment}</td>
                        <td class="px-6 py-4 font-medium">${data.player}</td>
                        <td class="px-6 py-4">${data.editor}</td>
                        <td class="px-6 py-4">${data.timestamp ? new Date(data.timestamp.seconds * 1000).toLocaleString('de-DE') : 'Unbekannt'}</td>
                    `;
                });
            });
        }

window.initHistoryPage = initHistoryPage;

// =============================================================================
// LOOT-SEITE (Liste, Import, Snapshot-Player-Adder)
// =============================================================================

		function initLootPage() {
            const displayContainer = document.getElementById('loot-details-display');
            const titleContainer = document.getElementById('loot-view-title');

			const importSection = document.getElementById('loot-import-section');
			const importBtn = document.getElementById('import-loot-btn');

			if (window.isManager) {
				importSection.style.display = 'block';
				importBtn?.addEventListener('click', handleLootImport);
			}
            const handleClickEvents = (event) => {
                const target = event.target;
                if (target.matches('#delete-log-btn')) {
                    handleDeleteLootLog(target.dataset.dateId);
                } else if (target.matches('.delete-item-btn')) {
                    handleDeleteLootItem(target.dataset.dateId, target.dataset.checksum);
                } else if (target.matches('.edit-winner-btn')) {
                    handleEditLootWinner(target.dataset.dateId, target.dataset.checksum, target.dataset.currentWinner);
                }
            };

            displayContainer?.addEventListener('click', handleClickEvents);
            titleContainer?.addEventListener('click', handleClickEvents);

            // NEU: Event listener für den Zusammenfassungs-Button
            document.getElementById('show-player-summary-btn')?.addEventListener('click', window.showPlayerSummaryView);

            // Alle Loot-Daten einmalig beim Laden der Seite abrufen
            const allLootQuery = query(lootCollectionRef, orderBy("raidDate", "desc"));
            getDocs(allLootQuery).then(snapshot => {
                window.allLootDocuments = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data().lootData }));
            });

			const q = query(lootCollectionRef, orderBy("raidDate", "desc"));
			window.lootDatesUnsubscribe = onSnapshot(q, (snapshot) => {
				const datesList = document.getElementById('loot-dates-list');
				if (!datesList) return;

				if (snapshot.empty) {
					datesList.innerHTML = '<p class="text-gray-500">Keine Loot-Daten gefunden.</p>';
					return;
				}

				datesList.innerHTML = '';
				snapshot.forEach(doc => {
					const date = doc.id;
					const dateButton = document.createElement('button');
					dateButton.className = 'w-full text-left p-2 rounded-md nav-link';
					dateButton.textContent = new Date(date + 'T12:00:00Z').toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' });
					dateButton.dataset.dateId = date;
					dateButton.onclick = () => {
						document.querySelectorAll('#loot-dates-list button').forEach(btn => btn.classList.remove('active-tab'));
						dateButton.classList.add('active-tab');
						// Diese Funktion schaltet automatisch zurück zur Einzelansicht
						displayLootForDate(date);
					};
					datesList.appendChild(dateButton);
				});
			});
		}

		async function handleLootImport() {
			if (!window.isManager) return;
			const jsonString = document.getElementById('loot-json-input').value;
			if (!jsonString) return window.showModal("Bitte JSON einfügen.");
			
			try {
				const data = JSON.parse(jsonString);
				if (!Array.isArray(data) || data.length === 0) {
					throw new Error("JSON muss ein Array von Loot-Objekten sein und darf nicht leer sein.");
				}

				const firstTimestamp = data[0].timestamp;
				if (!firstTimestamp) throw new Error("Erstes Objekt im JSON hat keinen 'timestamp'.");

				const raidDate = new Date(firstTimestamp * 1000).toISOString().split('T')[0]; // Format: YYYY-MM-DD
				
				const lootDocRef = doc(db, LOOT_COLLECTION, raidDate);
				await setDoc(lootDocRef, { lootData: data, raidDate: raidDate });
				
				const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
				window.logHistory('Loot', `Importiert für ${raidDate}`, `${data.length} Items`, currentManager);
				window.showModal(`Loot für den ${new Date(raidDate + 'T12:00:00Z').toLocaleDateString('de-DE')} wurde erfolgreich importiert!`);
				document.getElementById('loot-json-input').value = '';

			} catch (error) {
				window.showModal("Fehler beim Verarbeiten des JSON: " + error.message);
				console.error(error);
			}
		}


async function initSnapshotPlayerAdder() {
    const playerSelector = document.getElementById('snapshot-player-selector');
    const addButton = document.getElementById('add-from-snapshot-btn');
    const deleteButton = document.getElementById('delete-from-snapshot-btn'); // Neuer Button
    if (!playerSelector || !addButton || !deleteButton) return;

    try {
        // 1. Lade die Deny-List
        const denylistSnapshot = await getDocs(denylistCollectionRef);
        const denylist = new Set(denylistSnapshot.docs.map(doc => doc.id));

        // 2. Lade alle Snapshots
        const querySnapshot = await getDocs(snapshotsCollectionRef);
        const uniquePlayers = new Map();

        // 3. Sammle Spieler und filtere sie gegen die Deny-List
        querySnapshot.forEach(doc => {
            const rosterData = doc.data().roster?.roster;
            if (rosterData && Array.isArray(rosterData)) {
                rosterData.forEach(player => {
                    // Füge den Spieler nur hinzu, wenn er NICHT auf der Deny-List steht
                    if (!denylist.has(player.name) && !uniquePlayers.has(player.name)) {
                        uniquePlayers.set(player.name, player);
                    }
                });
            }
        });

        const sortedPlayers = Array.from(uniquePlayers.values()).sort((a, b) => a.name.localeCompare(b.name));

        // 4. Dropdown füllen
        playerSelector.innerHTML = '<option value="">-- Spieler aus Snapshot wählen --</option>';
        sortedPlayers.forEach(player => {
            const option = document.createElement('option');
            option.value = player.name;
            option.textContent = player.name;
            option.dataset.playerInfo = JSON.stringify(player);
            playerSelector.appendChild(option);
        });

        // 5. Event Listener anpassen
        playerSelector.addEventListener('change', () => {
            const hasSelection = !!playerSelector.value;
            addButton.disabled = !hasSelection;
            deleteButton.disabled = !hasSelection; // Auch den Löschen-Button steuern
        });

        addButton.addEventListener('click', handleAddPlayerFromSnapshot);
        deleteButton.addEventListener('click', handleDeletePlayerFromSnapshotList); // Listener für den neuen Button

    } catch (error) {
        console.error("Fehler beim Laden der Spieler aus Snapshots:", error);
        playerSelector.innerHTML = '<option value="">Fehler beim Laden</option>';
    }
}


async function handleDeletePlayerFromSnapshotList() {
    if (!window.isManager) return;
    
    const playerSelector = document.getElementById('snapshot-player-selector');
    const playerName = playerSelector.value;
    
    if (!playerName) return;

    const confirmed = await window.showModal(
        `Soll der Spieler '${playerName}' wirklich permanent aus allen zukünftigen Snapshot-Importlisten entfernt werden? Die originalen Snapshots bleiben unberührt.`,
        true // Bestätigungsdialog
    );

    if (!confirmed) return;

    try {
        // Füge den Spielernamen zur Deny-List hinzu. Wir benutzen den Namen als ID des Dokuments.
        const playerDocRef = doc(denylistCollectionRef, playerName);
        await setDoc(playerDocRef, { 
            deletedBy: sessionStorage.getItem('currentManager') || 'Unbekannt',
            deletedAt: serverTimestamp() 
        });

        window.showModal(`'${playerName}' wird in Zukunft nicht mehr in der Liste angezeigt.`);

        // Lade die Liste neu, um den entfernten Spieler sofort auszublenden
        initSnapshotPlayerAdder();

    } catch (error) {
        console.error("Fehler beim Hinzufügen zur Deny-List:", error);
        window.showModal("Ein Fehler ist aufgetreten. Der Spieler konnte nicht gelöscht werden.");
    }
}

async function handleAddPlayerFromSnapshot() {
    if (!window.isManager) return;
    
    const playerSelector = document.getElementById('snapshot-player-selector');
    const selectedOption = playerSelector.options[playerSelector.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) return;

    const playerData = JSON.parse(selectedOption.dataset.playerInfo);

    const docSnap = await getDoc(rosterDocRef);
    const roster = docSnap.exists() ? docSnap.data().roster || [] : [];

    // Prüfen, ob der Spieler bereits im aktuellen Roster ist
    if (roster.some(p => p.name === playerData.name)) {
        window.showModal(`Spieler '${playerData.name}' ist bereits in der aktuellen Aufstellung.`);
        return;
    }

    // Einen neuen Spieler erstellen, aber mit einer NEUEN, einzigartigen ID
    const newPlayer = {
        id: crypto.randomUUID(),
        name: playerData.name,
        class: playerData.class,
        roles: playerData.roles || ['DPS'] // Fallback, falls Rollen fehlen
    };

    roster.push(newPlayer);
    await setDoc(rosterDocRef, { roster: roster }, { merge: true });

    const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
    window.logHistory('Roster', `Spieler aus Snapshot hinzugefügt`, newPlayer.name, currentManager);
    window.showModal(`Spieler '${newPlayer.name}' wurde zum Roster hinzugefügt.`);

    // Auswahl zurücksetzen
    playerSelector.value = '';
    document.getElementById('add-from-snapshot-btn').disabled = true;
}

window.initLootPage = initLootPage;
window.handleLootImport = handleLootImport;
window.initSnapshotPlayerAdder = initSnapshotPlayerAdder;
window.handleDeletePlayerFromSnapshotList = handleDeletePlayerFromSnapshotList;
window.handleAddPlayerFromSnapshot = handleAddPlayerFromSnapshot;

// =============================================================================
// LOOT-DETAIL-ANZEIGE
// =============================================================================

function displayLootForDate(dateId) {
    if (window.selectedLootDateUnsubscribe) {
        window.selectedLootDateUnsubscribe();
    }
    const viewTitle = document.getElementById('loot-view-title');
    const displayContainer = document.getElementById('loot-details-display');
    
    // Setzt den Titel und fügt den "Log löschen"-Button für Manager hinzu
    if (viewTitle) {
        const dateString = new Date(dateId + 'T12:00:00Z').toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' });
        viewTitle.innerHTML = `Loot-Details für den ${dateString}`;
        if (window.isManager) {
            viewTitle.innerHTML += `
                <button id="delete-log-btn" data-date-id="${dateId}" class="ml-4 bg-red-800 hover:bg-red-700 text-white font-bold text-xs py-1 px-3 rounded-md">
                    Diesen Log löschen
                </button>
            `;
        }
    }

    displayContainer.innerHTML = '<p class="text-gray-400">Lade Loot-Daten...</p>';

    const lootDocRef = doc(db, LOOT_COLLECTION, dateId);
    window.selectedLootDateUnsubscribe = onSnapshot(lootDocRef, (docSnap) => {
        if (!docSnap.exists()) {
            displayContainer.innerHTML = '<p class="text-red-400">Keine Loot-Daten für dieses Datum gefunden.</p>';
            return;
        }

        const lootData = docSnap.data().lootData;
        lootData.sort((a, b) => a.timestamp - b.timestamp);
        
        let html = '';
        lootData.forEach(item => {
            const awardedTo = item.awardedTo.split('-')[0];
            const isDisenchanted = awardedTo === '|de|';
            
            let awardedToHtml;
            if (isDisenchanted) {
                awardedToHtml = `<strong class="text-gray-400 italic">Entzaubert</strong>`;
            } else {
                const winnerRoll = item.Rolls.find(r => r.player === awardedTo);
                const winnerClass = winnerRoll ? winnerRoll.class.toUpperCase() : 'UNKNOWN';
                const winnerColor = window.classColors[winnerClass] || '#FFFFFF';
                awardedToHtml = `<strong style="color: ${winnerColor};">${awardedTo}</strong>`;

                if (item.winningRollType === 'Bonus Roll') {
                    awardedToHtml += ` <span class="text-xs uppercase bg-blue-600/50 text-white px-1.5 py-0.5 rounded-full border border-blue-400">Bonus Roll</span>`;
                }
            }

            const rollsHtml = item.Rolls
                .sort((a, b) => b.amount - a.amount)
                .map(roll => {
                    const rollType = roll.classification;
                    let maxRoll = 100;
                    const upperCaseRollType = rollType.toUpperCase();
                    if (upperCaseRollType === 'OS') maxRoll = 50;
                    else if (['T-MOG', 'TRANSMOG', 'STYLE'].includes(upperCaseRollType)) maxRoll = 25;
                    
                    const playerColor = window.classColors[roll.class.toUpperCase()] || '#FFFFFF';
                    const isWinner = roll.player === awardedTo;
                    const fontWeight = isWinner ? 'font-bold text-lg' : 'font-normal';
                    const rollColor = isWinner ? 'text-yellow-400' : 'text-gray-300';
                    const srIndicator = (isWinner && item.SR) ? ' <span class="text-xs text-cyan-400 font-bold">(SR)</span>' : '';

                    return `<span class="whitespace-nowrap ${fontWeight}"><span style="color:${playerColor}">${roll.player}</span>: <span class="${rollColor}">${roll.amount}</span> <span class="text-xs text-gray-500">(${rollType}/${maxRoll})</span>${srIndicator}</span>`;
                }).join('&nbsp; ');

            const itemName = item.itemLink.replace(/[\[\]]/g, ''); 
            const wowheadUrl = `https://www.wowhead.com/mop-classic/item=${item.itemID}`;
            const itemLinkHtml = `<a href="${wowheadUrl}" target="_blank" rel="noopener noreferrer" class="hover:underline">${itemName}</a>`;

            const adminActions = window.isManager ? `
                <div class="absolute top-2 right-2 flex gap-2">
                    <button class="edit-winner-btn text-xs py-1 px-2 rounded bg-slate-600 hover:bg-blue-600" data-date-id="${dateId}" data-checksum="${item.checksum}" data-current-winner="${awardedTo}">Name ändern</button>
                    <button class="delete-item-btn text-xs py-1 px-2 rounded bg-slate-600 hover:bg-red-700" data-date-id="${dateId}" data-checksum="${item.checksum}">Item löschen</button>
                </div>
            ` : '';

            html += `
                <div class="bg-slate-750 p-4 rounded-lg mb-4 relative">
                    ${adminActions}
                    <div class="flex justify-between items-start">
                         <h4 class="text-lg font-bold" style="color: var(--color-gold);">${itemLinkHtml}</h4>
                         <span class="text-sm text-gray-400">${new Date(item.timestamp * 1000).toLocaleTimeString('de-DE')}</span>
                    </div>
                    <p class="mt-1">Vergeben an: ${awardedToHtml}</p>
                    ${!isDisenchanted && item.Rolls.length > 0 ? `
                    <div class="mt-2 text-sm">
                        <p class="font-semibold">Würfe:</p>
                        <div class="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                            ${rollsHtml}
                        </div>
                    </div>` : ''}
                </div>
            `;
        });

        displayContainer.innerHTML = html || '<p>Keine Items für dieses Datum gefunden.</p>';
    });
}

async function handleDeleteLootLog(dateId) {
    if (!window.isManager) return;
    const confirmed = await window.showModal(`Soll der gesamte Loot-Log vom ${dateId} wirklich gelöscht werden?`, true);
    if (confirmed) {
        try {
            await deleteDoc(doc(db, LOOT_COLLECTION, dateId));
            window.showModal("Loot-Log wurde erfolgreich gelöscht.");
            // Ansicht wird automatisch durch den Listener aktualisiert.
        } catch (error) {
            window.showModal("Fehler beim Löschen des Logs: " + error.message);
        }
    }
}
async function handleDeleteLootItem(dateId, itemChecksum) {
    if (!window.isManager) return;
    const confirmed = await window.showModal("Soll dieser eine Loot-Eintrag wirklich gelöscht werden?", true);
    if (confirmed) {
        try {
            const lootDocRef = doc(db, LOOT_COLLECTION, dateId);
            const docSnap = await getDoc(lootDocRef);
            if (docSnap.exists()) {
                const lootData = docSnap.data().lootData;
                const updatedLootData = lootData.filter(item => item.checksum !== itemChecksum);
                await updateDoc(lootDocRef, { lootData: updatedLootData });
                window.showModal("Loot-Eintrag wurde entfernt.");
            }
        } catch (error) {
            window.showModal("Fehler beim Entfernen des Eintrags: " + error.message);
        }
    }
}
async function handleEditLootWinner(dateId, itemChecksum, currentWinner) {
    if (!window.isManager) return;
    const newWinner = await window.showPrompt("Bitte den neuen Namen des Gewinners eingeben:", currentWinner);
    if (newWinner && newWinner.trim() !== '') {
        try {
            const lootDocRef = doc(db, LOOT_COLLECTION, dateId);
            const docSnap = await getDoc(lootDocRef);
            if (docSnap.exists()) {
                const lootData = docSnap.data().lootData;
                const itemIndex = lootData.findIndex(item => item.checksum === itemChecksum);
                if (itemIndex > -1) {
                    // Füge den Realm-Namen hinzu, falls er fehlt, um konsistent zu bleiben
                    const finalWinnerName = newWinner.includes('-') ? newWinner : `${newWinner}-Everlook`;
                    lootData[itemIndex].awardedTo = finalWinnerName;
                    await updateDoc(lootDocRef, { lootData: lootData });
                    window.showModal("Gewinner wurde geändert.");
                }
            }
        } catch (error) {
            window.showModal("Fehler beim Ändern des Namens: " + error.message);
        }
    }
}

window.displayLootForDate = displayLootForDate;
window.handleDeleteLootLog = handleDeleteLootLog;
window.handleDeleteLootItem = handleDeleteLootItem;
window.handleEditLootWinner = handleEditLootWinner;

// =============================================================================
// initBossPage (zentrales Setup der Boss-Seite, sehr groß)
// =============================================================================

function initBossPage(pageId, sectionId = null) {
    // --- Logik für Sprungmarken und einklappbare Sektionen ---
    const quickNavLinks = document.querySelectorAll('.quick-nav-bar a');
    const sections = document.querySelectorAll('.collapsible-section');

    // Macht alle Sektionen initial einklappbar und setzt sie als aktiv (offen).
    sections.forEach((section) => {
        const header = section.querySelector('.collapsible-header');
        const content = section.querySelector('.collapsible-content');
        if (header && content) {
            header.classList.add('active'); // Alle Sektionen sind standardmäßig offen
            header.addEventListener('click', () => {
                header.classList.toggle('active');
                content.classList.toggle('collapsed');
            });
        }
    });

    // Fügt die "Smooth-Scroll"-Funktionalität zu den Sprungmarken hinzu.
    quickNavLinks.forEach(link => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            const targetId = link.getAttribute('href').substring(1);
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                const parentSection = targetElement.closest('.collapsible-section') || targetElement;
                const header = parentSection.querySelector('.collapsible-header');
                const content = parentSection.querySelector('.collapsible-content');
                if (header && content && content.classList.contains('collapsed')) {
                    header.classList.add('active');
                    content.classList.remove('collapsed');
                }
                window.scrollTo({
                    top: targetElement.offsetTop - 120,
                    behavior: 'smooth'
                });
            }
        });
    });

    // --- Logik für 10/25-Spieler Umschalter ---
    const sizeToggle = document.getElementById('size-toggle');
    if (sizeToggle) {
        const savedSize = sessionStorage.getItem('raidSize') || '25';
        document.querySelectorAll('.size-toggle-btn').forEach(button => {
            button.classList.toggle('active-size-btn', button.dataset.size === savedSize);
        });
        document.querySelectorAll('.tactic-content').forEach(content => {
            let displayStyle = 'none';
            if (content.dataset.size === savedSize) {
                switch (content.tagName.toUpperCase()) {
                    case 'SPAN': displayStyle = 'inline'; break;
                    case 'LI': displayStyle = 'grid'; break;
                    case 'BUTTON': displayStyle = 'inline-block'; break;
                    default: displayStyle = 'block';
                }
            }
            content.style.display = displayStyle;
        });
        sizeToggle.addEventListener('click', function(event) {
            if (event.target.matches('.size-toggle-btn')) {
                const selectedSize = event.target.dataset.size;
                sessionStorage.setItem('raidSize', selectedSize);
                document.querySelectorAll('.size-toggle-btn').forEach(button => button.classList.remove('active-size-btn'));
                event.target.classList.add('active-size-btn');
                document.querySelectorAll('.tactic-content').forEach(content => {
                    let displayStyle = 'none';
                    if (content.dataset.size === selectedSize) {
                       switch (content.tagName.toUpperCase()) {
                           case 'SPAN': displayStyle = 'inline'; break;
                           case 'LI': displayStyle = 'grid'; break;
                           case 'BUTTON': displayStyle = 'inline-block'; break;
                           default: displayStyle = 'block';
                       }
                    }
                    content.style.display = displayStyle;
                });
            }
        });
    }
    
    // --- Logik für Positions-Bilder Umschalter ---
    const positioningToggle = document.getElementById('positioning-toggle');
    if (positioningToggle) {
        positioningToggle.addEventListener('click', (event) => {
            if (event.target.matches('.positioning-btn')) {
                const selectedPhase = event.target.dataset.phase;
                document.querySelectorAll('.positioning-btn').forEach(btn => btn.classList.remove('active-position-btn'));
                event.target.classList.add('active-position-btn');
                document.querySelectorAll('.positioning-image, .positioning-text').forEach(element => {
                    element.style.display = element.dataset.phase === selectedPhase ? 'block' : 'none';
                });
            }
        });
        const defaultPhaseButton = positioningToggle.querySelector('.positioning-btn');
        if (defaultPhaseButton) {
            defaultPhaseButton.click();
        }
        document.querySelectorAll('.lightbox-trigger').forEach(img => {
            img.addEventListener('click', (event) => {
                event.stopPropagation();
                window.openLightbox(img.src);
            });
        });
    }
         if (sectionId) {
         setTimeout(() => {
             const targetElement = document.getElementById(sectionId);
             if (targetElement) {
                 const parentSection = targetElement.closest('.collapsible-section');
                 if (parentSection) {
                     const header = parentSection.querySelector('.collapsible-header');
                     const content = parentSection.querySelector('.collapsible-content');
                     if (header && content && content.classList.contains('collapsed')) {
                         header.classList.add('active');
                         content.classList.remove('collapsed');
                     }
                 }
                 
                 window.scrollTo({
                     top: targetElement.offsetTop - 120, // 120px Abstand von oben
                     behavior: 'smooth'
                 });
             }
         }, 100); // Eine kleine Verzögerung, damit alles geladen ist
    }
document.querySelectorAll('.video-wrapper').forEach(wrapper => {
    const video = wrapper.querySelector('video');
    const controlsOverlay = wrapper.querySelector('.video-controls');
    const playPauseIcon = controlsOverlay.querySelector('.play-pause-btn i');

    const togglePlay = () => {
        if (video.paused) {
            video.play();
            playPauseIcon.className = 'fas fa-pause'; // Ändert Icon zu Pause
            wrapper.classList.add('is-playing');
        } else {
            video.pause();
            playPauseIcon.className = 'fas fa-play'; // Ändert Icon zu Play
            wrapper.classList.remove('is-playing');
        }
    };
    
    // Klick auf das Overlay startet/stoppt das Video
    controlsOverlay.addEventListener('click', togglePlay);
});


    // --- Logik zum Laden der Einteilungen (Datenbank) ---
    const assignmentsDocRef = doc(db, DATA_COLLECTION, "boss-" + pageId);
    async function handleAssignmentChange(event) {
        if (window._suspendAssignListeners) return;
        if (!window.isManager) return;
        const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
        const select = event.target;
        const assignmentId = select.dataset.assignmentId;
        const valueToSave = select.value;
        let dataToSave;
        if (assignmentId.toLowerCase().includes('cooldown')) {
            dataToSave = { cooldown: valueToSave, editor: currentManager, timestamp: serverTimestamp() };
        } else {
            dataToSave = { player: valueToSave, editor: currentManager, timestamp: serverTimestamp() };
        }
        await setDoc(assignmentsDocRef, { [assignmentId]: dataToSave }, { merge: true });
        
        // Farbe direkt aktualisieren
        const selectedOption = select.options[select.selectedIndex];
        select.style.color = selectedOption?.dataset?.color || '#FFFFFF';
        select.style.fontStyle = (selectedOption?.dataset?.bench === '1') ? 'italic' : 'normal';

        const playerForLog = valueToSave || "Niemand";
        const bossName = pageId.charAt(0).toUpperCase() + pageId.slice(1);
        const assignmentName = assignmentId.replace(pageId + '-', '').replace(/([A-Z])/g, ' $1').trim();
        window.logHistory(bossName, `Einteilung: ${assignmentName}`, playerForLog, currentManager);
    }

async function handleTextInputChange(event) {
    if (!window.isManager) return;
    const input = event.target;
    const assignmentId = input.dataset.assignmentId;
    const textToSave = input.value;
    const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
    
    const dataToSave = { text: textToSave, editor: currentManager, timestamp: serverTimestamp() };
    await setDoc(assignmentsDocRef, { [assignmentId]: dataToSave }, { merge: true });
    
    const bossName = pageId.charAt(0).toUpperCase() + pageId.slice(1);
    const assignmentName = `Header: ${assignmentId.replace(pageId + '-', '')}`;
    window.logHistory(bossName, assignmentName, textToSave || "Leer", currentManager);
}

// Debounced Wrapper
function handleTextInputChangeDebounced(event) {
    const id = event.target.dataset.assignmentId;
    clearTimeout(window._textSaveTimers[id]);
    window._textSaveTimers[id] = setTimeout(() => handleTextInputChange(event), 300);
}
    // Globale Sperre, um Change-Handler während Bulk-Updates zu pausieren
window._suspendAssignListeners = false;
window.syncCompToJiKunTeams = async function() {
    if (!window.isManager) return window.showModal("Nur Manager können synchronisieren.");
    
    const confirmed = await window.showModal(
        "Die aktuellen Gruppen 1-5 werden als Ji-Kun Teams 1-5 überschrieben. Fortfahren?", true
    );
    if (!confirmed) return;
    
    const { setDoc, doc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const db = window.firebaseTools.db;
    const editor = sessionStorage.getItem('currentManager') || 'Unbekannt';
    const ts = serverTimestamp();
    
    const updates = {};
    
    for (let team = 1; team <= 5; team++) {
        const groupList = document.getElementById(`group-list-${team}`);
        if (!groupList) continue;
        
        const cards = Array.from(groupList.querySelectorAll('.player-card'));
        const realPlayers = cards
            .map(c => JSON.parse(c.dataset.playerJson))
            .filter(p => !p.isPlaceholder);
        
        for (let p = 1; p <= 5; p++) {
            const assignmentId = `jikun-team-${team}-p${p}`;
            const playerName = (p <= realPlayers.length) ? realPlayers[p - 1].name : "";
            updates[assignmentId] = { player: playerName, editor: editor, timestamp: ts };
        }
    }
    
    const jikunDocRef = doc(db, "raid-tool-data", "boss-ji-kun");
    await setDoc(jikunDocRef, updates, { merge: true });
    
    window.showModal(`Ji-Kun Teams wurden mit den Gruppen 1-5 synchronisiert (${Object.keys(updates).length / 5} Teams).`);
};

// JI-KUN → COMP: Teams in Gruppen schreiben
window.syncJiKunTeamsToComp = async function() {
    if (!window.isManager) return window.showModal("Nur Manager können synchronisieren.");
    
    const confirmed = await window.showModal(
        "Die Ji-Kun Teams 1-5 werden als Gruppen 1-5 ins Roster geschrieben. Spieler die nicht in Teams sind, landen auf der Bank. Fortfahren?", true
    );
    if (!confirmed) return;
    
    const { getDoc, setDoc, doc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const db = window.firebaseTools.db;
    
    // 1. Ji-Kun Team-Daten laden
    const jikunSnap = await getDoc(doc(db, "raid-tool-data", "boss-ji-kun"));
    if (!jikunSnap.exists()) return window.showModal("Keine Ji-Kun Daten gefunden.");
    const jikunData = jikunSnap.data();
    
    // 2. Aktuelles Roster laden
    const rosterSnap = await getDoc(doc(db, "raid-tool-data", "currentRoster"));
    const currentRoster = rosterSnap.exists() ? rosterSnap.data().roster || [] : [];
    
    if (currentRoster.length === 0) return window.showModal("Roster ist leer.");
    
    // 3. Team-Namen extrahieren
    const teamPlayers = {}; // { "Spielername": teamIndex }
    for (let team = 1; team <= 5; team++) {
        for (let p = 1; p <= 5; p++) {
            const name = jikunData[`jikun-team-${team}-p${p}`]?.player;
            if (name && name.trim() !== '') {
                teamPlayers[name] = team;
            }
        }
    }
    
    // 4. Roster neu sortieren: Team-Spieler erst (nach Gruppe), dann Rest (Bank)
    const grouped = []; // Spieler in Teams
    const bench = [];   // Spieler ohne Team
    
    // Pro Gruppe sammeln (Reihenfolge beibehalten)
    for (let team = 1; team <= 5; team++) {
        let teamMembers = [];
        for (let p = 1; p <= 5; p++) {
            const name = jikunData[`jikun-team-${team}-p${p}`]?.player;
            if (!name) continue;
            const rosterPlayer = currentRoster.find(r => r.name === name);
            if (rosterPlayer) {
                teamMembers.push(rosterPlayer);
            }
        }
        // Auffüllen bis 5 mit Platzhaltern
        while (teamMembers.length < 5) {
            teamMembers.push({
                id: `placeholder-${team}-${teamMembers.length}-${Date.now()}`,
                name: "Leerer Platz",
                class: "UNKNOWN",
                roles: [],
                isPlaceholder: true
            });
        }
        grouped.push(...teamMembers);
    }
    
    // Spieler die in keinem Team sind → Bank
    const assignedNames = new Set(Object.keys(teamPlayers));
    currentRoster.forEach(player => {
        if (!player.isPlaceholder && !assignedNames.has(player.name)) {
            bench.push(player);
        }
    });
    
    const newRoster = [...grouped, ...bench];
    
    // 5. Speichern
    await setDoc(doc(db, "raid-tool-data", "currentRoster"), { roster: newRoster }, { merge: true });
    
    window.showModal(`Roster wurde nach Ji-Kun Teams sortiert. ${Object.keys(teamPlayers).length} Spieler in Teams, ${bench.length} auf der Bank.`);
};
// Einmalig viele Zuweisungen speichern und UI aktualisieren
async function applyAssignmentsBulk(updatesObj) {
  try {
    window._suspendAssignListeners = true;

    const editor = sessionStorage.getItem('currentManager') || 'Unbekannt';
    const ts = serverTimestamp();

    // Firestore-Payload zusammensetzen
    const payload = {};
    Object.entries(updatesObj).forEach(([assignmentId, value]) => {
      const isCooldown = assignmentId.toLowerCase().includes('cooldown');
      payload[assignmentId] = isCooldown
        ? { cooldown: value || "", editor, timestamp: ts }
        : { player: value || "", editor, timestamp: ts };

      // DOM-Select ohne Event-Feuerwerk setzen
      const sel = document.querySelector(`select[data-assignment-id="${assignmentId}"]`);
      if (sel) {
        sel.value = value || "";
        const opt = sel.options[sel.selectedIndex];
        sel.style.color = (opt && opt.dataset && opt.dataset.color) ? opt.dataset.color : '#FFFFFF';
      }
    });

    // Ein (!) Write statt viele
    await setDoc(assignmentsDocRef, payload, { merge: true });

  } finally {
    window._suspendAssignListeners = false;
    // Pools/Farben einmal aktualisieren
    updateAssignmentPools?.();
  }
}
window.applyAssignmentsBulk = applyAssignmentsBulk;

    (async () => {
        if (!window.rosterData) {
             const rosterSnap = await getDoc(rosterDocRef);
             window.rosterData = rosterSnap.exists() ? rosterSnap.data().roster || [] : [];
        }

        function wireAssignmentSelect(select) {
  if (!select || select.dataset._wired === "1") return;

  // Buff-/Soulstone-Selects auf der Comp-Seite NICHT verdrahten —
  // die werden von initBuffAssignments/initSoulstoneAssignments verwaltet
  // und haben ihre eigenen Change-Handler. Sonst würde populateDropdownOptions
  // weiter unten ihre `<option selected>` überschreiben.
  if (select.classList.contains('buff-player-select') ||
      select.classList.contains('soulstone-target-select') ||
      select.classList.contains('buff-class-select')) {
    return;
  }

  select.dataset._wired = "1";

  // 1) Change-Handler für DB-Save
if (select.getAttribute('data-manual-options') === "true") {
        select.addEventListener('change', window.handleAssignmentChange); // Trotzdem Speichern erlauben
        return; 
    }

  // 2) Optionen befüllen (wie bisherige Logik)
  const assignmentIdLower = (select.dataset.assignmentId || '').toLowerCase();
  if (assignmentIdLower.includes('cooldown')) {
    // Cooldown-Dropdowns: hier unverändert (aus deinem bestehenden Code)
    select.innerHTML = '<option value="" data-color="#FFFFFF">-- Cooldown wählen --</option>';
    allCooldowns.forEach(cd => {
      const option = document.createElement('option');
      if (cd.name.startsWith('---')) {
        option.textContent = cd.name;
        option.disabled = true;
        option.style.fontWeight = 'bold';
        option.style.color = 'var(--color-gold)';
        option.style.backgroundColor = 'var(--color-dark-green-bg)';
      } else {
        const color = window.classColors[cd.class] || window.classColors[cd.class?.toUpperCase()] || '#FFFFFF';
        option.value = cd.name;
        option.textContent = cd.name;
        option.dataset.color = color;
        option.style.color = color;
        if (cd.tooltip) {
            option.title = cd.tooltip; // Zeigt den Text beim Hovern über die Liste
        }
      }
      select.appendChild(option);
    });
  } else {
    // Spieler-Dropdowns (Rollenfilter wie gehabt)
    let playersForDropdown = [];
    if (assignmentIdLower.includes('tank')) {
      playersForDropdown = rosterData.filter(p => p.roles.includes('TANK'));
    } else if (assignmentIdLower.includes('healer')) {
      playersForDropdown = rosterData.filter(p => p.roles.includes('HEALER'));
    } else if (assignmentIdLower.includes('dps') || assignmentIdLower.includes('dd')) {
      playersForDropdown = rosterData.filter(p => p.roles.includes('DPS'));
    } else {
      playersForDropdown = rosterData;
    }
    window.populateDropdownOptions(select, playersForDropdown, window.currentBossIdForPatches);
  }
const tooltipEl = document.getElementById('global-custom-tooltip');

            // 1. Maus rein: Text suchen und Tooltip zeigen
            select.addEventListener('mouseenter', () => {
                const currentVal = select.value;
                if (!currentVal || !window.allCooldowns) return;
                
                const cdObj = window.allCooldowns.find(c => c.name === currentVal);
                if (cdObj && cdObj.tooltip) {
                    tooltipEl.innerHTML = `<strong class="text-gold block mb-1">${cdObj.name}</strong>${cdObj.tooltip}`;
                    tooltipEl.classList.remove('hidden');
                }
            });

            // 2. Maus bewegen: Tooltip folgt der Maus
            select.addEventListener('mousemove', (e) => {
                if (!tooltipEl.classList.contains('hidden')) {
                    // Etwas Abstand zur Maus (15px)
                    tooltipEl.style.top = (e.clientY + 15) + 'px';
                    tooltipEl.style.left = (e.clientX + 15) + 'px';
                }
            });

            // 3. Maus raus: Tooltip verstecken
            select.addEventListener('mouseleave', () => {
                tooltipEl.classList.add('hidden');
            });
  // 3) Pool-Indikator (🟡) wird vom bestehenden updateAssignmentPools() gesetzt
  //    Farbe initialisieren:
  const selOpt = select.options[select.selectedIndex];
  select.style.color = selOpt ? (selOpt.dataset.color || '#FFFFFF') : '#FFFFFF';
  select.style.fontStyle = (selOpt?.dataset?.bench === '1') ? 'italic' : 'normal';
}

// --- A) Vorhandene Selects jetzt mit der neuen Funktion verdrahten
document.querySelectorAll('.assignment-select').forEach(wireAssignmentSelect);

const wireTextInput = (input) => {
    if (input.dataset._textWired) return;
    input.dataset._textWired = '1';
    
    input.addEventListener('input', handleTextInputChangeDebounced);  // Debounced beim Tippen
    input.addEventListener('change', (e) => {
        clearTimeout(window._textSaveTimers[e.target.dataset.assignmentId]);
        handleTextInputChange(e);  // Sofort bei Fokusverlust
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(window._textSaveTimers[e.target.dataset.assignmentId]);
            handleTextInputChange({ target: input });
            input.blur();
        }
    });
};

// --- B) Observer: wenn deine Boss-Seite später dynamisch Selects hinzufügt,
//           werden diese automatisch nachverdrahtet und speichern dann einzeln.
// MutationObserver, um dynamisch hinzugefügte Elemente zu "verdrahten"
const assignmentObserver = new MutationObserver(mutations => {
    mutations.forEach(m => {
        m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return; // nur Elemente

            // 1. Neue Dropdowns (.assignment-select) finden und verdrahten
            if (node.matches?.('.assignment-select')) {
                wireAssignmentSelect(node);
            }
            node.querySelectorAll?.('.assignment-select').forEach(wireAssignmentSelect);

            // 2. Helfer-Funktion, um Text-Inputs zu verdrahten
            const wireTextInput = (input) => {
                // Verhindert, dass Listener mehrfach hinzugefügt werden
                if (input.dataset._textWired) return;
                input.dataset._textWired = '1';

                // Speichert beim Verlassen des Feldes
                input.addEventListener('change', handleTextInputChange);
                
                // Speichert bei Drücken der Enter-Taste
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault(); // Verhindert Standard-Aktion
                        input.blur();         // Löst das 'change'-Event und somit das Speichern aus
                    }
                });
            };

            // 3. Neue Text-Inputs (.assignment-text-input) finden und verdrahten
            if (node.matches?.('.assignment-text-input')) {
                wireTextInput(node);
            }
            node.querySelectorAll?.('.assignment-text-input').forEach(wireTextInput);
        });
    });
});
assignmentObserver.observe(document.body, { childList: true, subtree: true });


        updateAssignmentPools();
        window.toggleSelectEditability();
        
    })();

    // Innere Funktionen aufs window exposen, damit andere Module sie nutzen können.
    // (Diese müssen INNERHALB von initBossPage stehen, weil sie hier deklariert werden.)
    window.handleAssignmentChange = handleAssignmentChange;
    window.handleTextInputChange = handleTextInputChange;
    window.handleTextInputChangeDebounced = handleTextInputChangeDebounced;
    window.applyAssignmentsBulk = applyAssignmentsBulk;
}

window.initBossPage = initBossPage;

// =============================================================================
// COOLDOWN-EDITOR (CRUD für CD-Stammdaten)
// =============================================================================

// ============== COOLDOWN-EDITOR FUNKTIONEN ==============

function initCooldownEditor() {
    const form = document.getElementById('cooldown-form');
    const classSelect = document.getElementById('cooldown-class-select');
    const cancelBtn = document.getElementById('cooldown-cancel-btn');

    // Klassen-Dropdown füllen
    classSelect.innerHTML = window.wowClasses.map(c => `<option value="${c}">${c.charAt(0) + c.slice(1).toLowerCase()}</option>`).join('');

    // Event Listener für das Formular
    form.addEventListener('submit', handleCooldownFormSubmit);
    cancelBtn.addEventListener('click', () => {
        form.reset();
        document.getElementById('cooldown-id-input').value = '';
        document.getElementById('cooldown-form-title').textContent = 'Neuen Cooldown hinzufügen';
        document.getElementById('cooldown-save-btn').textContent = 'Speichern';
        cancelBtn.style.display = 'none';
    });

    // Initiale Liste laden
    displayCooldowns();
}

async function displayCooldowns() {
    const tableBody = document.getElementById('cooldowns-table-body');
    if (!tableBody) return;
 
    const cooldownsCollectionRef = collection(db, "cooldowns");
    const q = query(cooldownsCollectionRef, orderBy("order", "asc"), orderBy("name", "asc"));
    const snapshot = await getDocs(q);
 
    tableBody.innerHTML = '';
    snapshot.forEach(doc => {
        const cd = doc.data();
        const row = tableBody.insertRow();
        const cdSec = (cd.cooldownSec !== null && cd.cooldownSec !== undefined) ? cd.cooldownSec + 's' : '—';
        const durSec = (cd.durationSec !== null && cd.durationSec !== undefined) ? cd.durationSec + 's' : '—';
        row.innerHTML = `
            <td class="px-2 py-2">${cd.name}</td>
            <td class="px-2 py-2" style="color: ${window.classColors[cd.class] || '#FFFFFF'};">${cd.class}</td>
            <td class="px-2 py-2 text-gray-400 font-mono text-xs">${cd.spellId || ''}</td>
            <td class="px-2 py-2 text-center text-xs text-gray-400">${cdSec} / ${durSec}</td>
            <td class="px-2 py-2 text-right">
                <button class="text-sm text-blue-400 hover:underline edit-cd-btn" data-id="${doc.id}">Edit</button>
                <button class="text-sm text-red-500 hover:underline delete-cd-btn ml-2" data-id="${doc.id}">✕</button>
            </td>
        `;
    });
 
    tableBody.querySelectorAll('.edit-cd-btn').forEach(btn => {
        btn.addEventListener('click', (e) => populateCooldownFormForEdit(e.target.dataset.id));
    });
    tableBody.querySelectorAll('.delete-cd-btn').forEach(btn => {
        btn.addEventListener('click', (e) => handleDeleteCooldown(e.target.dataset.id, e.target.closest('tr').cells[0].textContent));
    });
}

async function handleCooldownFormSubmit(event) {
    event.preventDefault();
    if (!window.isManager) return;
 
    const cooldownId = document.getElementById('cooldown-id-input').value;
    
    // Helper: leeres Feld → undefined (nicht im Dokument speichern)
    function numOrUndef(inputId) {
        const v = document.getElementById(inputId).value.trim();
        if (v === '') return null;  // Firestore speichert null, planner fällt auf Fallback zurück
        const n = parseInt(v);
        return isNaN(n) ? null : n;
    }
    
    const cooldownData = {
        name:        document.getElementById('cooldown-name-input').value,
        class:       document.getElementById('cooldown-class-select').value,
        type:        document.getElementById('cooldown-type-select').value,
        order:       parseInt(document.getElementById('cooldown-order-input').value) || 100,
        spellId:     document.getElementById('cooldown-spellid-input').value || "",
        tooltip:     document.getElementById('cooldown-tooltip-input').value || "",
        // NEU: Cooldown & Wirkdauer (null wenn leer → Planner nutzt Default)
        cooldownSec: numOrUndef('cooldown-cdsec-input'),
        durationSec: numOrUndef('cooldown-durationsec-input')
    };
 
    try {
        if (cooldownId) {
            const docRef = doc(db, "cooldowns", cooldownId);
            await updateDoc(docRef, cooldownData);
            window.showModal("Cooldown erfolgreich aktualisiert!");
        } else {
            await addDoc(collection(db, "cooldowns"), cooldownData);
            window.showModal("Neuer Cooldown erfolgreich hinzugefügt!");
        }
        
        document.getElementById('cooldown-form').reset();
        document.getElementById('cooldown-id-input').value = '';
        document.getElementById('cooldown-form-title').textContent = 'Neuen Cooldown hinzufügen';
        document.getElementById('cooldown-save-btn').textContent = 'Speichern';
        document.getElementById('cooldown-cancel-btn').style.display = 'none';
        
        await displayCooldowns();
        await fetchAllCooldowns();
        
    } catch (error) {
        console.error("Fehler beim Speichern des Cooldowns:", error);
        window.showModal("Ein Fehler ist aufgetreten.");
    }
}

async function populateCooldownFormForEdit(cooldownId) {
    const docRef = doc(db, "cooldowns", cooldownId);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return;
 
    const cd = docSnap.data();
    document.getElementById('cooldown-id-input').value = cooldownId;
    document.getElementById('cooldown-name-input').value = cd.name || '';
    document.getElementById('cooldown-class-select').value = cd.class || '';
    document.getElementById('cooldown-type-select').value = cd.type || 'Raid';
    document.getElementById('cooldown-order-input').value = cd.order || 100;
    document.getElementById('cooldown-spellid-input').value = cd.spellId || '';
    document.getElementById('cooldown-tooltip-input').value = cd.tooltip || '';
    // NEU
    document.getElementById('cooldown-cdsec-input').value = (cd.cooldownSec !== null && cd.cooldownSec !== undefined) ? cd.cooldownSec : '';
    document.getElementById('cooldown-durationsec-input').value = (cd.durationSec !== null && cd.durationSec !== undefined) ? cd.durationSec : '';
 
    document.getElementById('cooldown-form-title').textContent = 'Cooldown bearbeiten';
    document.getElementById('cooldown-save-btn').textContent = 'Aktualisieren';
    document.getElementById('cooldown-cancel-btn').style.display = 'inline-block';
    
    // Scroll zum Formular
    document.getElementById('cooldown-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleDeleteCooldown(cooldownId, cooldownName) {
    const confirmed = await window.showModal(`Soll der Cooldown "${cooldownName}" wirklich gelöscht werden?`, true);
    if (confirmed) {
        await deleteDoc(doc(db, "cooldowns", cooldownId));
        await displayCooldowns();
        await fetchAllCooldowns();
    }
}
window.makePlannerSortable = function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const header = container.querySelector('.planner-header');
    // Wichtig: Wir müssen wissen, wo die Zeilen drin liegen (im neuen rows-container)
    const rowsContainer = container.querySelector('[id$="-rows-container"]') || container;

    if (!header) return;

    let sortDirection = 1; // 1 = aufsteigend, -1 = absteigend

    // Durch alle Header-Spalten iterieren
    Array.from(header.children).forEach((th, colIndex) => {
        // Ignorieren: 
        // 0 = Griff
        // Letzte 2 = Toggle Button & Actions
        if (colIndex === 0 || colIndex >= header.children.length - 2) {
            th.style.cursor = 'default';
            return;
        }

        // Klickbar machen
        th.style.cursor = 'pointer';
        th.title = "Sortieren";
        th.classList.add('hover:text-white', 'transition-colors');

        th.onclick = () => {
            sortDirection *= -1; // Richtung wechseln
            const rows = Array.from(rowsContainer.querySelectorAll('.planner-row'));
            
            rows.sort((a, b) => {
                const getVal = (row) => {
                    const el = row.children[colIndex];
                    if (!el) return "";
                    return el.value || el.textContent || ""; 
                };

                let valA = getVal(a).toLowerCase();
                let valB = getVal(b).toLowerCase();

                // --- SPEZIAL-FÄLLE ---

                // Spalte 3: % / # (Zahlen)
                if (colIndex === 3) { 
                    return (parseFloat(valA || 0) - parseFloat(valB || 0)) * sortDirection;
                }
                
                // Spalte 4: Zeit (Min:Sek oder Sek)
                if (colIndex === 4) {
                    const toSec = (t) => {
                        if (!t) return 0;
                        if (t.includes(':')) {
                           const parts = t.split(':');
                           return parseInt(parts[0])*60 + parseInt(parts[1]);
                        }
                        return parseFloat(t) || 0;
                    };
                    return (toSec(valA) - toSec(valB)) * sortDirection;
                }

                // Standard Text-Vergleich
                return valA.localeCompare(valB) * sortDirection;
            });

            // Zeilen neu einsortieren
            rows.forEach(row => rowsContainer.appendChild(row));
        };
    });
};


window.initCooldownEditor = initCooldownEditor;
window.displayCooldowns = displayCooldowns;
window.handleCooldownFormSubmit = handleCooldownFormSubmit;
window.populateCooldownFormForEdit = populateCooldownFormForEdit;
window.handleDeleteCooldown = handleDeleteCooldown;