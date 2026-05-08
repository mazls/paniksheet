// ══════════════════════════════════════════════════════════════════════════
// SLOT-SYSTEM (Standalone für PÄNIK-Raid-Tool / index.html-Variante)
// ──────────────────────────────────────────────────────────────────────────
// Bietet:
//   • SPEC_DEFINITIONS — feste Slot-Liste (PROTPALA1, BLOODDK1, ...)
//   • GROUP_KEYS — ALL, Klassen-Namen, MELEEDPS/RANGEDDPS/TANKS/HEALERS
//   • Helper-Funktionen für Dropdown-Augmentation und Resolution
//
// Speicher-Pfad in Firestore: raid-tool-data/slotMapping
//   { mapping: { HPALA1: 'Fojjiuwu', BLOODDK1: 'Nerfmy', ... } }
//
// Nutzung im alten Tool:
//   window.SlotSystem.init()                 — beim Page-Load (lädt Mapping)
//   window.SlotSystem.augmentPlayerOptions() — kompletten Options-HTML mit
//                                               Roster + Slots + Groups
//   window.SlotSystem.resolvePlayerName(v)   — Slot zu Spielername auflösen
//   window.SlotSystem.renderMappingUI(el)    — Mapping-Sektion in Container
//   window.SlotSystem.isSlotKey(v)           — Prüft ob Wert ein Slot-Key ist
//   window.SlotSystem.isGroupKey(v)          — Prüft ob Wert ein Group-Key ist
// ══════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────
    // KONSTANTEN
    // ────────────────────────────────────────────────────────────

    // Spec-Definition: [prefix, className, specName, maxSlots]
    // Reihenfolge: Tanks > Healer > Melee > Ranged
    const SPEC_DEFINITIONS = [
        // ─── TANKS ───
        ['PROTPALA',   'PALADIN',     'Protection',     3],
        ['PROTWARR',   'WARRIOR',     'Protection',     3],
        ['BLOODDK',    'DEATHKNIGHT', 'Blood',          3],
        ['FERALTANK',  'DRUID',       'Guardian',       3],
        ['BREWMAST',   'MONK',        'Brewmaster',     3],

        // ─── HEALER ───
        ['HPALA',      'PALADIN',     'Holy',           4],
        ['RDRUID',     'DRUID',       'Restoration',    3],
        ['DISC',       'PRIEST',      'Discipline',     6],
        ['HOLYPRIEST', 'PRIEST',      'Holy',           3],
        ['RSHAM',      'SHAMAN',      'Restoration',    6],
        ['MISTWEAVE',  'MONK',        'Mistweaver',     6],

        // ─── MELEE-DPS ───
        ['RETPALA',    'PALADIN',     'Retribution',    3],
        ['ENH',        'SHAMAN',      'Enhancement',    3],
        ['DPSWARR',    'WARRIOR',     'Arms / Fury',    8],
        ['ROGUE',      'ROGUE',       'Rogue',          5],
        ['UHDK',       'DEATHKNIGHT', 'Unholy',         7],
        ['FROSTDK',    'DEATHKNIGHT', 'Frost',          3],
        ['FERAL',      'DRUID',       'Feral',          4],
        ['WINDWALK',   'MONK',        'Windwalker',     5],

        // ─── RANGED-DPS ───
        ['SPRIEST',    'PRIEST',      'Shadow',         3],
        ['MAGE',       'MAGE',        'Mage',           9],
        ['LOCK',       'WARLOCK',     'Warlock',        8],
        ['ELE',        'SHAMAN',      'Elemental',      6],
        ['BOOMIE',     'DRUID',       'Balance',        3],
        ['SURVIVAL',   'HUNTER',      'Survival',       9],
        ['BM',         'HUNTER',      'Beast Mastery',  3]
    ];

    // Klassen-Anzeigenamen
    const CLASS_DISPLAY = {
        DEATHKNIGHT: 'Death Knight',
        DRUID:       'Druid',
        HUNTER:      'Hunter',
        MAGE:        'Mage',
        MONK:        'Monk',
        PALADIN:     'Paladin',
        PRIEST:      'Priest',
        ROGUE:       'Rogue',
        SHAMAN:      'Shaman',
        WARLOCK:     'Warlock',
        WARRIOR:     'Warrior'
    };

    // Group-Keys: ALL + Klassen + Rollen-Aliase
    const GROUP_KEYS = [
        { key: 'ALL',         label: 'ALL (Alle Spieler)',     classKey: null },
        { key: 'DEATHKNIGHT', label: 'DEATHKNIGHT',            classKey: 'DEATHKNIGHT' },
        { key: 'DRUID',       label: 'DRUID',                  classKey: 'DRUID' },
        { key: 'HUNTER',      label: 'HUNTER',                 classKey: 'HUNTER' },
        { key: 'MAGE',        label: 'MAGE',                   classKey: 'MAGE' },
        { key: 'MONK',        label: 'MONK',                   classKey: 'MONK' },
        { key: 'PALADIN',     label: 'PALADIN',                classKey: 'PALADIN' },
        { key: 'PRIEST',      label: 'PRIEST',                 classKey: 'PRIEST' },
        { key: 'ROGUE',       label: 'ROGUE',                  classKey: 'ROGUE' },
        { key: 'SHAMAN',      label: 'SHAMAN',                 classKey: 'SHAMAN' },
        { key: 'WARLOCK',     label: 'WARLOCK',                classKey: 'WARLOCK' },
        { key: 'WARRIOR',     label: 'WARRIOR',                classKey: 'WARRIOR' },
        { key: 'MELEEDPS',    label: 'MELEEDPS (alle Melees)', classKey: null },
        { key: 'RANGEDDPS',   label: 'RANGEDDPS (alle Ranged)',classKey: null },
        { key: 'TANKS',       label: 'TANKS (alle Tanks)',     classKey: null },
        { key: 'HEALERS',     label: 'HEALERS (alle Heiler)',  classKey: null }
    ];

    const GROUP_KEY_VALUES = new Set(GROUP_KEYS.map(g => g.key));

    const DATA_COLLECTION = 'raid-tool-data';
    const SLOT_DOC_ID = 'slotMapping';

    // Default-Klassenfarben falls window.classColors nicht da ist
    const DEFAULT_CLASS_COLORS = {
        DEATHKNIGHT: '#C41E3A',
        DRUID:       '#FF7C0A',
        HUNTER:      '#AAD372',
        MAGE:        '#3FC7EB',
        MONK:        '#00FF98',
        PALADIN:     '#F48CBA',
        PRIEST:      '#FFFFFF',
        ROGUE:       '#FFF468',
        SHAMAN:      '#0070DD',
        WARLOCK:     '#8788EE',
        WARRIOR:     '#C69B6D'
    };

    // ────────────────────────────────────────────────────────────
    // STATE
    // ────────────────────────────────────────────────────────────

    let _slotMapping = {};   // { HPALA1: 'Fojjiuwu', ... }
    let _initialized = false;

    // ────────────────────────────────────────────────────────────
    // HELPERS
    // ────────────────────────────────────────────────────────────

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, s => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[s]));
    }

    function classColor(cls) {
        if (!cls) return '#FFFFFF';
        const upper = cls.toUpperCase();
        if (window.classColors && window.classColors[upper]) {
            return window.classColors[upper];
        }
        return DEFAULT_CLASS_COLORS[upper] || '#FFFFFF';
    }

    function findSpecByPrefix(prefix) {
        return SPEC_DEFINITIONS.find(([p]) => p === prefix) || null;
    }

    function parseSlotKey(slotKey) {
        if (!slotKey || typeof slotKey !== 'string') return null;
        const match = slotKey.match(/^([A-Z]+?)(\d+)$/);
        if (!match) return null;
        const prefix = match[1];
        const index = parseInt(match[2]);
        const def = findSpecByPrefix(prefix);
        if (!def) return null;
        const [, cls, spec, maxSlots] = def;
        if (index < 1 || index > maxSlots) return null;
        return { prefix, class: cls, spec, index, maxSlots };
    }

    function isSlotKey(value) {
        return parseSlotKey(value) !== null;
    }

    function isGroupKey(value) {
        return value ? GROUP_KEY_VALUES.has(value) : false;
    }

    function getSlotsByClass() {
        const byClass = {};
        SPEC_DEFINITIONS.forEach(([prefix, cls, spec, maxSlots]) => {
            if (!byClass[cls]) byClass[cls] = [];
            byClass[cls].push({ prefix, spec, maxSlots });
        });
        return byClass;
    }

    /**
     * Löst einen Wert (Spielername / Slot-Key / Group-Key) zum tatsächlichen
     * Spielernamen auf. Group-Keys und unbekannte Werte werden unverändert
     * zurückgegeben.
     */
    function resolvePlayerName(value, strict) {
        if (!value) return value;
        if (!isSlotKey(value)) return value;
        const mapped = _slotMapping[value];
        if (mapped) return mapped;
        return strict ? null : value;
    }

    // ────────────────────────────────────────────────────────────
    // FIRESTORE PERSISTENCE
    // ────────────────────────────────────────────────────────────

    async function loadFromFirestore() {
        try {
            const tools = window.firebaseTools;
            if (!tools || !tools.db || !tools.doc || !tools.getDoc) {
                console.warn('[SlotSystem] firebaseTools nicht verfügbar — Mapping bleibt leer.');
                return;
            }
            const ref = tools.doc(tools.db, DATA_COLLECTION, SLOT_DOC_ID);
            const snap = await tools.getDoc(ref);
            _slotMapping = (snap.exists() ? snap.data().mapping : null) || {};
            console.log('[SlotSystem] Mapping geladen:', Object.keys(_slotMapping).length, 'Slots');
        } catch (e) {
            console.error('[SlotSystem] Lade-Fehler:', e);
            _slotMapping = {};
        }
    }

    async function saveToFirestore() {
        try {
            const tools = window.firebaseTools;
            if (!tools || !tools.db || !tools.doc || !tools.setDoc) {
                console.warn('[SlotSystem] firebaseTools.setDoc nicht verfügbar.');
                return false;
            }
            const ref = tools.doc(tools.db, DATA_COLLECTION, SLOT_DOC_ID);
            await tools.setDoc(ref, { mapping: _slotMapping, updatedAt: new Date().toISOString() });
            return true;
        } catch (e) {
            console.error('[SlotSystem] Save-Fehler:', e);
            return false;
        }
    }

    // ────────────────────────────────────────────────────────────
    // OPTIONS-HTML-AUGMENTATION
    // ────────────────────────────────────────────────────────────

    /**
     * Liefert kompletten <option>-HTML-String mit drei Sektionen:
     *   1. Roster-Spieler (sortiert)
     *   2. Aktive Spec-Slots (mit ─── Trenner ───)
     *   3. Klassen / Rollen Group-Keys (mit ─── Trenner ───)
     *
     * Plus oben Phantom-Option für Werte die nicht (mehr) zuordenbar sind.
     *
     * @param {Array} rosterPlayers  [{ name, class, ... }, ...]  (window.rosterData)
     * @param {string} currentValue   Aktuell selektierter Wert (für 'selected' und Phantom)
     * @param {object} [opts]         { sortRoster: true, includeEmpty: true }
     */
    function augmentPlayerOptions(rosterPlayers, currentValue, opts) {
        opts = opts || {};
        const includeEmpty = opts.includeEmpty !== false;
        const sortRoster = opts.sortRoster !== false;

        const rosterArr = Array.isArray(rosterPlayers) ? rosterPlayers : [];
        const sorted = sortRoster
            ? [...rosterArr].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
            : rosterArr;

        const playerInRoster = currentValue ? rosterArr.some(p => p.name === currentValue) : true;
        const valueIsSlot = currentValue ? isSlotKey(currentValue) : false;
        const valueIsGroup = isGroupKey(currentValue);
        const slotIsActive = valueIsSlot && _slotMapping[currentValue];
        const valueKnown = playerInRoster
            || valueIsGroup
            || slotIsActive
            || (valueIsSlot && Object.prototype.hasOwnProperty.call(_slotMapping, currentValue));

        const phantomOption = (currentValue && !valueKnown)
            ? `<option value="${escapeHtml(currentValue)}" selected style="color:#ef4444; font-style:italic;">⚠ ${escapeHtml(currentValue)} (nicht im Kader)</option>`
            : '';

        const emptyOption = includeEmpty
            ? `<option value="">-- Spieler wählen --</option>`
            : '';

        // Aktive Slots
        const activeSlots = Object.keys(_slotMapping)
            .filter(k => isSlotKey(k))
            .sort();

        const slotColor = (slotKey) => {
            const mappedName = _slotMapping[slotKey];
            if (!mappedName) {
                const meta = parseSlotKey(slotKey);
                return classColor(meta && meta.class);
            }
            const player = rosterArr.find(p => p.name === mappedName);
            return classColor(player && player.class);
        };

        const groupKeyColor = (group) => {
            if (group.classKey) return classColor(group.classKey);
            return '#fcd34d';
        };

        const rosterHtml = sorted.map(p => {
            const color = classColor(p.class);
            const selected = p.name === currentValue ? 'selected' : '';
            return `<option value="${escapeHtml(p.name)}" style="color:${color}; background-color:#192a23;" ${selected}>${escapeHtml(p.name)}</option>`;
        }).join('');

        const slotsHtml = activeSlots.length > 0 ? `
            <option disabled style="font-weight:bold; color:#fcd34d; background-color:#192a23;">─── Spec-Slots ───</option>
            ${activeSlots.map(slotKey => {
                const color = slotColor(slotKey);
                const mappedName = _slotMapping[slotKey];
                const label = mappedName ? `${slotKey} (${mappedName})` : `${slotKey} (—)`;
                const selected = currentValue === slotKey ? 'selected' : '';
                return `<option value="${escapeHtml(slotKey)}" style="color:${color}; background-color:#192a23;" ${selected}>${escapeHtml(label)}</option>`;
            }).join('')}
        ` : '';

        const groupsHtml = `
            <option disabled style="font-weight:bold; color:#fcd34d; background-color:#192a23;">─── Klassen / Rollen ───</option>
            ${GROUP_KEYS.map(group => {
                const color = groupKeyColor(group);
                const selected = currentValue === group.key ? 'selected' : '';
                return `<option value="${escapeHtml(group.key)}" style="color:${color}; background-color:#192a23;" ${selected}>${escapeHtml(group.label)}</option>`;
            }).join('')}
        `;

        return emptyOption + phantomOption + rosterHtml + slotsHtml + groupsHtml;
    }

    // ────────────────────────────────────────────────────────────
    // MAPPING-UI (für comp.html)
    // ────────────────────────────────────────────────────────────

    function renderMappingUI(container) {
        if (!container) return;

        const slotsByClass = getSlotsByClass();
        const rosterPlayers = (window.rosterData || []).filter(p => p && p.name);
        const isManager = !!window.isManager;

        let html = `
            <p class="text-gray-400 text-sm mb-3">
                Klick auf "+ &lt;Spec&gt; N" um einen Slot anzulegen, dann den Spieler aus dem Dropdown auswählen.
                Slots, deren gemappter Spieler nicht (mehr) im Kader ist, werden in Exporten automatisch ausgelassen.
            </p>
        `;

        Object.entries(slotsByClass).forEach(([cls, specs]) => {
            const classColorHex = classColor(cls);

            const usedSlots = Object.keys(_slotMapping).filter(key => {
                const meta = parseSlotKey(key);
                return meta && meta.class === cls;
            });
            if (usedSlots.length === 0 && !isManager) return; // Im Readonly leere Klassen ausblenden

            html += `
                <div class="bg-slate-900/40 border border-slate-700 rounded p-3 mb-3" style="border-left: 3px solid ${classColorHex};">
                    <div class="font-semibold mb-2" style="color:${classColorHex};">${escapeHtml(CLASS_DISPLAY[cls] || cls)}</div>
                    <div class="space-y-1">
            `;

            specs.forEach(({ prefix, spec, maxSlots }) => {
                for (let i = 1; i <= maxSlots; i++) {
                    const key = prefix + i;
                    const exists = Object.prototype.hasOwnProperty.call(_slotMapping, key);
                    if (!exists) continue;
                    const assigned = _slotMapping[key] || '';
                    html += renderSlotRow(key, prefix, spec, i, assigned, rosterPlayers, isManager);
                }
            });

            // Add-Buttons pro Spec (nur Manager)
            if (isManager) {
                html += `<div class="flex flex-wrap gap-1 mt-2">`;
                specs.forEach(({ prefix, spec, maxSlots }) => {
                    let nextIdx = 1;
                    while (nextIdx <= maxSlots && Object.prototype.hasOwnProperty.call(_slotMapping, prefix + nextIdx)) {
                        nextIdx++;
                    }
                    if (nextIdx > maxSlots) return;
                    html += `
                        <button class="slot-add-btn text-xs bg-slate-700 hover:bg-slate-600 text-gray-200 px-2 py-1 rounded" data-add-slot="${prefix}${nextIdx}">
                            + ${escapeHtml(spec)} ${nextIdx}
                        </button>
                    `;
                });
                html += `</div>`;
            }

            html += `</div></div>`;
        });

        container.innerHTML = html;

        if (!isManager) return; // Read-only: keine Event-Handler

        container.querySelectorAll('[data-add-slot]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const key = btn.dataset.addSlot;
                _slotMapping[key] = '';
                await saveToFirestore();
                renderMappingUI(container);
            });
        });

        container.querySelectorAll('[data-slot-select]').forEach(sel => {
            sel.addEventListener('change', async () => {
                const key = sel.dataset.slotSelect;
                _slotMapping[key] = sel.value;
                await saveToFirestore();
                renderMappingUI(container);
            });
        });

        container.querySelectorAll('[data-remove-slot]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const key = btn.dataset.removeSlot;
                delete _slotMapping[key];
                await saveToFirestore();
                renderMappingUI(container);
            });
        });
    }

    function renderSlotRow(key, prefix, spec, index, assigned, rosterPlayers, isManager) {
        const ro = isManager ? '' : 'disabled';
        const playerOptions = rosterPlayers.map(p => {
            const color = classColor(p.class);
            const selected = p.name === assigned ? 'selected' : '';
            return `<option value="${escapeHtml(p.name)}" style="color:${color}; background-color:#192a23;" ${selected}>${escapeHtml(p.name)}</option>`;
        }).join('');

        return `
            <div class="flex items-center gap-2 py-1">
                <code class="bg-yellow-900/30 text-yellow-200 text-xs px-2 py-0.5 rounded" style="min-width:90px;">${escapeHtml(key)}</code>
                <span class="text-xs text-gray-400" style="min-width:90px;">${escapeHtml(spec)}</span>
                <select data-slot-select="${escapeHtml(key)}" class="flex-1 max-w-xs bg-slate-900 border border-slate-600 text-gray-200 text-sm rounded px-2 py-1" ${ro}>
                    <option value="">— kein Spieler —</option>
                    ${playerOptions}
                </select>
                ${isManager ? `<button class="text-red-400 hover:text-red-300 text-sm px-2" data-remove-slot="${escapeHtml(key)}" title="Slot entfernen">×</button>` : ''}
            </div>
        `;
    }

    // ────────────────────────────────────────────────────────────
    // PUBLIC API
    // ────────────────────────────────────────────────────────────

    window.SlotSystem = {
        async init() {
            if (_initialized) return;
            _initialized = true;
            await loadFromFirestore();
        },

        async reload() {
            await loadFromFirestore();
        },

        getMapping() {
            return { ..._slotMapping };
        },

        SPEC_DEFINITIONS,
        GROUP_KEYS,
        CLASS_DISPLAY,

        isSlotKey,
        isGroupKey,
        parseSlotKey,
        getSlotsByClass,
        resolvePlayerName,
        augmentPlayerOptions,
        renderMappingUI,

        // Hilfs-Helper, falls jemand mit window.classColors unsicher ist
        classColor,

        // Master-Roster-Mapping als Comma-String (z.B. für WeakAura-Export)
        buildSlotMappingString(validNames) {
            return Object.entries(_slotMapping)
                .filter(([, name]) => name && name.trim())
                .filter(([, name]) => !validNames || validNames.has(name))
                .map(([slot, name]) => `${slot}-${name}`)
                .join(',');
        }
    };
})();