/**
 * LaneGroups — wiederverwendbare Einteilungs-Blöcke mit Auto-Fill.
 */

window.LaneGroups = (function () {

    const MARKERS = [
        { id: '',         label: 'Kein Marker', file: '',             color: '#94a3b8', emoji: '·'  },
        { id: 'star',     label: 'Star',         file: 'star.png',     color: '#fde047', emoji: '⭐' },
        { id: 'circle',   label: 'Circle',       file: 'circle.png',   color: '#fb923c', emoji: '🟠' },
        { id: 'diamond',  label: 'Diamond',      file: 'diamond.png',  color: '#f9a8d4', emoji: '💜' },
        { id: 'triangle', label: 'Triangle',     file: 'triangle.png', color: '#4ade80', emoji: '🔺' },
        { id: 'moon',     label: 'Moon',         file: 'moon.png',     color: '#93c5fd', emoji: '🌙' },
        { id: 'square',   label: 'Square',       file: 'square.png',   color: '#60a5fa', emoji: '🟦' },
        { id: 'cross',    label: 'Cross',        file: 'cross.png',    color: '#f87171', emoji: '❌' },
        { id: 'skull',    label: 'Skull',        file: 'skull.png',    color: '#e5e7eb', emoji: '💀' }
    ];
    function getMarker(id) {
        return MARKERS.find(m => m.id === (id || '')) || MARKERS[0];
    }

    const SPEC_DEFINITIONS = {
        DEATHKNIGHT: [{ value: 'Blood', label: 'Blood (Tank)', role: 'tank' }, { value: 'Frost1', label: 'Frost', role: 'dps', archetype: 'melee' }, { value: 'Unholy', label: 'Unholy', role: 'dps', archetype: 'melee' }],
        DRUID: [{ value: 'Balance', label: 'Balance', role: 'dps', archetype: 'caster' }, { value: 'Feral', label: 'Feral', role: 'dps', archetype: 'melee' }, { value: 'Guardian', label: 'Guardian (Tank)', role: 'tank' }, { value: 'Restoration', label: 'Restoration (Heal)', role: 'healer' }],
        HUNTER: [{ value: 'Beastmastery', label: 'Beastmastery', role: 'dps', archetype: 'ranged_physical' }, { value: 'Marksmanship', label: 'Marksmanship', role: 'dps', archetype: 'ranged_physical' }, { value: 'Survival', label: 'Survival', role: 'dps', archetype: 'ranged_physical' }],
        MAGE: [{ value: 'Arcane', label: 'Arcane', role: 'dps', archetype: 'caster' }, { value: 'Fire', label: 'Fire', role: 'dps', archetype: 'caster' }, { value: 'Frost', label: 'Frost', role: 'dps', archetype: 'caster' }],
        MONK: [{ value: 'Brewmaster', label: 'Brewmaster (Tank)', role: 'tank' }, { value: 'Mistweaver', label: 'Mistweaver (Heal)', role: 'healer' }, { value: 'Windwalker', label: 'Windwalker', role: 'dps', archetype: 'melee' }],
        PALADIN: [{ value: 'Holy1', label: 'Holy (Heal)', role: 'healer' }, { value: 'Protection1', label: 'Protection (Tank)', role: 'tank' }, { value: 'Retribution', label: 'Retribution', role: 'dps', archetype: 'melee' }],
        PRIEST: [{ value: 'Discipline', label: 'Discipline (Heal)', role: 'healer' }, { value: 'Holy', label: 'Holy (Heal)', role: 'healer' }, { value: 'Shadow', label: 'Shadow', role: 'dps', archetype: 'caster' }],
        ROGUE: [{ value: 'Assassination', label: 'Assassination', role: 'dps', archetype: 'melee' }, { value: 'Combat', label: 'Combat', role: 'dps', archetype: 'melee' }, { value: 'Subtlety', label: 'Subtlety', role: 'dps', archetype: 'melee' }],
        SHAMAN: [{ value: 'Elemental', label: 'Elemental', role: 'dps', archetype: 'caster' }, { value: 'Enhancement', label: 'Enhancement', role: 'dps', archetype: 'melee' }, { value: 'Restoration1', label: 'Restoration (Heal)', role: 'healer' }],
        WARLOCK: [{ value: 'Affliction', label: 'Affliction', role: 'dps', archetype: 'caster' }, { value: 'Demonology', label: 'Demonology', role: 'dps', archetype: 'caster' }, { value: 'Destruction', label: 'Destruction', role: 'dps', archetype: 'caster' }],
        WARRIOR: [{ value: 'Arms', label: 'Arms', role: 'dps', archetype: 'melee' }, { value: 'Fury', label: 'Fury', role: 'dps', archetype: 'melee' }, { value: 'Protection', label: 'Protection (Tank)', role: 'tank' }]
    };

    const SPEC_ARCHETYPE_LOOKUP = (() => {
        const m = {};
        Object.keys(SPEC_DEFINITIONS).forEach(cls => {
            SPEC_DEFINITIONS[cls].forEach(s => { if (s.archetype) m[cls + '|' + s.value] = s.archetype; });
        });
        return m;
    })();

    const CLASS_ALIASES = {
        'death knight': 'DEATHKNIGHT', 'deathknight': 'DEATHKNIGHT', 'dk': 'DEATHKNIGHT', 'todesritter': 'DEATHKNIGHT',
        'druid': 'DRUID', 'druide': 'DRUID', 'hunter': 'HUNTER', 'jäger': 'HUNTER', 'jaeger': 'HUNTER',
        'mage': 'MAGE', 'magier': 'MAGE', 'monk': 'MONK', 'mönch': 'MONK', 'moench': 'MONK',
        'paladin': 'PALADIN', 'priest': 'PRIEST', 'priester': 'PRIEST', 'rogue': 'ROGUE', 'schurke': 'ROGUE',
        'shaman': 'SHAMAN', 'schamane': 'SHAMAN', 'warlock': 'WARLOCK', 'hexenmeister': 'WARLOCK', 'warrior': 'WARRIOR', 'krieger': 'WARRIOR'
    };
    const CLASS_DISPLAY = {
        'DEATHKNIGHT': 'Todesritter', 'DRUID': 'Druide', 'HUNTER': 'Jäger', 'MAGE': 'Magier', 'MONK': 'Mönch', 'PALADIN': 'Paladin',
        'PRIEST': 'Priester', 'ROGUE': 'Schurke', 'SHAMAN': 'Schamane', 'WARLOCK': 'Hexenmeister', 'WARRIOR': 'Krieger'
    };
    function normalizeClass(cls) {
        if (!cls) return '';
        return CLASS_ALIASES[String(cls).toLowerCase().trim()] || '';
    }

    const DEFAULT_PRIO_CATEGORIES = [
        { id: 'healer', label: 'Healer', class: '', spec: '', role: 'healer', archetype: '' },
        { id: 'tank',   label: 'Tank', class: '', spec: '', role: 'tank', archetype: '', maxTotal: 1 },
        { id: 'caster', label: 'Caster DPS', class: '', spec: '', role: 'dps', archetype: 'caster' },
        { id: 'ranged', label: 'R-Physical DPS', class: '', spec: '', role: 'dps', archetype: 'ranged_physical' },
        { id: 'melee',  label: 'Melee DPS', class: '', spec: '', role: 'dps', archetype: 'melee' }
    ];

    function getPlayerRoleNormalized(p) {
        if (Array.isArray(p.roles) && p.roles.length > 0) return String(p.roles[0]).toLowerCase();
        if (p.role) return String(p.role).toLowerCase();
        return '';
    }
    function getPlayerSpec(p)  { return (p.spec || p.specName || p.specialization || '').toString(); }
    function getPlayerClass(p) { return (p.class || p.className || '').toString(); }
    function getPlayerArchetype(p) {
        const cls  = normalizeClass(getPlayerClass(p));
        const spec = getPlayerSpec(p);
        if (!cls || !spec) return '';
        return SPEC_ARCHETYPE_LOOKUP[cls + '|' + spec] || '';
    }
    function playerMatchesCategory(p, cat) {
        const playerClass = normalizeClass(getPlayerClass(p));
        const playerSpec  = getPlayerSpec(p);
        const playerRole  = getPlayerRoleNormalized(p);
        const playerArch  = getPlayerArchetype(p);

        if (cat.class && cat.class !== playerClass) return false;
        if (cat.spec  && cat.spec  !== playerSpec)  return false;
        if (cat.role  && cat.role  !== playerRole)  return false;
        if (cat.archetype && cat.archetype !== playerArch) return false;
        return true;
    }
    function getPlayerCategory(p, prioCategories) {
        if (!p) return null;
        for (const cat of prioCategories) {
            if (playerMatchesCategory(p, cat)) return cat;
        }
        return null;
    }
    function findRosterPlayer(roster, name) {
        if (!Array.isArray(roster) || !name) return null;
        return roster.find(rp => (rp.name || rp) === name) || null;
    }
    function getActiveRoster() {
        return window.effectiveRoster || window.rosterData || [];
    }
    function isPlayerOnBench(name) {
        if (typeof window.isPlayerOnBench === 'function') return window.isPlayerOnBench(name);
        return false;
    }

    const _instances = new Map();

    function makeInstance(config) {
        const container = document.getElementById(config.containerId);
        if (!container) return null;
        const inst = {
            id: config.containerId,
            container,
            bossId: config.bossId,
            assignmentId: config.assignmentId,
            prioStorageKey: 'lane-groups-prio:' + config.bossId + ':' + config.assignmentId,
            firebaseTools: config.firebaseTools || window.firebaseTools || null,
            roster: config.roster || getActiveRoster(),
            assignmentsRef: config.assignments || null,
            blocks: [],
            prioCategories: [],
            editMode: false,
            saveTimer: null,
            openFilters: new Set(),
            defaultBlocks: config.defaultBlocks || []
        };
        _instances.set(config.containerId, inst);
        return inst;
    }

    function generateBlockId()  { return 'block-' + Math.random().toString(36).slice(2, 8); }
    function generateLaneId()   { return 'lane-'  + Math.random().toString(36).slice(2, 8); }

    function normalizeBlock(b) {
        const type = ['multi-lane', 'single-list', 'marked-list'].includes(b.type) ? b.type : 'multi-lane';
        const out = {
            id: b.id || generateBlockId(),
            title: b.title || 'Neuer Block',
            type: type,
            autoFill: b.autoFill !== false,
            waExport: !!b.waExport,
            isolatedBlock: b.isolatedBlock !== false, 
            sharedLanes: b.sharedLanes !== false      
        };
        
        let lanes = Array.isArray(b.lanes) ? b.lanes : [];
        if (type === 'multi-lane') {
            out.lanes = lanes.map(l => {
                const slots = Array.isArray(l.slots) ? l.slots.slice() : Array(3).fill('');
                return {
                    id: l.id || generateLaneId(),
                    title: l.title || '',
                    marker: typeof l.marker === 'string' ? l.marker : '',
                    slots: slots,
                    slotMarkers: Array.isArray(l.slotMarkers) ? l.slotMarkers.slice() : Array(slots.length).fill(''),
                    allowedCats: Array.isArray(l.allowedCats) ? l.allowedCats.slice() : null
                };
            });
            if (out.lanes.length === 0) {
                out.lanes.push({ id: generateLaneId(), title: '', marker: '', slots: Array(3).fill(''), slotMarkers: Array(3).fill(''), allowedCats: null });
            }
        } else {
            let slots = Array(3).fill('');
            let slotMarkers = Array(3).fill('');
            
            if (Array.isArray(b.slots)) {
                slots = b.slots.slice();
            } else if (lanes.length > 0 && Array.isArray(lanes[0].slots)) {
                slots = lanes[0].slots.slice();
            }
            if (Array.isArray(b.slotMarkers)) {
                slotMarkers = b.slotMarkers.slice();
            } else if (lanes.length > 0 && Array.isArray(lanes[0].slotMarkers)) {
                slotMarkers = lanes[0].slotMarkers.slice();
            }
            
            while(slotMarkers.length < slots.length) slotMarkers.push('');
            slotMarkers.length = slots.length;

            out.lanes = [{
                id: b._laneId || generateLaneId(),
                title: b.title || '',
                marker: '',
                slots: slots,
                slotMarkers: slotMarkers,
                allowedCats: Array.isArray(b.allowedCats) ? b.allowedCats.slice() : null
            }];
        }
        return out;
    }

    function loadState(inst, assignments) {
        const saved = assignments && assignments[inst.assignmentId];
        if (saved && Array.isArray(saved.blocks) && saved.blocks.length > 0) {
            inst.blocks = saved.blocks.map(normalizeBlock);
        } else {
            inst.blocks = (inst.defaultBlocks || []).map(normalizeBlock);
        }
        try {
            const raw = localStorage.getItem(inst.prioStorageKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.every(c => c && c.id && c.label)) {
                    inst.prioCategories = parsed;
                    return;
                }
            }
        } catch (e) {}
        inst.prioCategories = DEFAULT_PRIO_CATEGORIES.map(c => ({ ...c }));
    }

    function savePrio(inst) {
        try { localStorage.setItem(inst.prioStorageKey, JSON.stringify(inst.prioCategories)); } catch (e) {}
    }

    function scheduleSave(inst) {
        if (inst.saveTimer) clearTimeout(inst.saveTimer);
        inst.saveTimer = setTimeout(() => saveToFirestore(inst), 600);
    }
    async function saveToFirestore(inst) {
        if (!window.isManager) return;
        if (inst.assignmentsRef) {
            inst.assignmentsRef[inst.assignmentId] = {
                blocks: JSON.parse(JSON.stringify(inst.blocks)),
                editor: sessionStorage.getItem('currentManager') || 'Unbekannt',
                timestamp: new Date().toISOString()
            };
        }
        const fb = inst.firebaseTools;
        if (!fb || !fb.db || !fb.doc || !fb.setDoc) return;
        try {
            const currentManager = sessionStorage.getItem('currentManager') || 'Unbekannt';
            const docRef = fb.doc(fb.db, 'raid-tool-data', 'boss-' + inst.bossId);
            await fb.setDoc(docRef, {
                [inst.assignmentId]: {
                    blocks: inst.blocks,
                    editor: currentManager,
                    timestamp: new Date().toISOString()
                }
            }, { merge: true });
        } catch (e) {
            console.error('[LaneGroups] Speichern fehlgeschlagen:', e);
        }
    }

    function markerIconHtml(markerId) {
        const m = getMarker(markerId);
        if (!m.file) {
            return `<span class="lg-marker-emoji" title="${m.label}">${m.emoji}</span>`;
        }
        return `<img src="raidicons/${m.file}" alt="${m.label}" title="${m.label}" class="lg-marker-icon" onerror="this.outerHTML='<span class=&quot;lg-marker-emoji&quot;>${m.emoji}</span>'">`;
    }

    function findOtherSlotsWithPlayer(inst, name, exceptBlockIdx, exceptLaneIdx, exceptSlotIdx) {
        const hits = [];
        const sourceBlock = inst.blocks[exceptBlockIdx];
        
        inst.blocks.forEach((b, bi) => {
            if (bi !== exceptBlockIdx && (sourceBlock.isolatedBlock || b.isolatedBlock)) return;
            
            b.lanes.forEach((l, li) => {
                if (bi === exceptBlockIdx && li !== exceptLaneIdx && !b.sharedLanes) return;
                
                l.slots.forEach((v, si) => {
                    if (v === name && !(bi === exceptBlockIdx && li === exceptLaneIdx && si === exceptSlotIdx)) {
                        hits.push({ blockTitle: b.title, laneIdx: li, slotIdx: si });
                    }
                });
            });
        });
        return hits;
    }

    function isPlayerAllowedOnLane(inst, name, blockIdx, laneIdx) {
        const lane = inst.blocks[blockIdx]?.lanes[laneIdx];
        if (!lane) return true;
        if (lane.allowedCats == null) return true;
        if (!Array.isArray(lane.allowedCats)) return true;
        if (lane.allowedCats.length === 0) return false;
        const ply = findRosterPlayer(inst.roster, name);
        const cat = getPlayerCategory(ply, inst.prioCategories);
        if (!cat) return false;
        return lane.allowedCats.includes(cat.id);
    }

    function getPlayerOptionsHtml(inst, selectedName, blockIdx, laneIdx) {
        let html = '<option value="">—</option>';
        const lane = inst.blocks[blockIdx]?.lanes[laneIdx];
        const filterActive = !!(lane && lane.allowedCats !== null && Array.isArray(lane.allowedCats));
        const cc = window.classColors || {};
        
        html += '<optgroup label="Kader">';
        (inst.roster || []).forEach(p => {
            const name  = p.name || p;
            const color = (p.class && cc[p.class.toUpperCase()]) || '#FFFFFF';
            const isSelected = name === selectedName;
            if (filterActive && !isSelected && !isPlayerAllowedOnLane(inst, name, blockIdx, laneIdx)) return;
            const sel = isSelected ? ' selected' : '';
            const isBench = isPlayerOnBench(name) ? ' (Ersatz)' : '';
            html += `<option value="${escapeHtml(name)}" style="color:${color};" data-color="${color}"${sel}>${escapeHtml(name)}${isBench}</option>`;
        });
        html += '</optgroup>';

        html += '<optgroup label="Platzhalter (Klassen)">';
        Object.keys(CLASS_DISPLAY).forEach(clsKey => {
            const color = cc[clsKey] || '#FFFFFF';
            const isSelected = clsKey === selectedName;
            const sel = isSelected ? ' selected' : '';
            html += `<option value="${escapeHtml(clsKey)}" style="color:${color};" data-color="${color}"${sel}>${escapeHtml(CLASS_DISPLAY[clsKey])}</option>`;
        });
        html += '</optgroup>';

        return html;
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderTagsHtml(inst, blockIdx, laneIdx) {
        const lane = inst.blocks[blockIdx].lanes[laneIdx];
        if (inst.prioCategories.length === 0) return '';
        const allowed = lane.allowedCats;
        const allOn = (allowed === null || allowed === undefined);
        
        if (!inst.openFilters) inst.openFilters = new Set();
        const filterKey = `${blockIdx}-${laneIdx}`;
        const isOpen = inst.openFilters.has(filterKey);
        const hasActiveFilter = !allOn;

        let html = `<div class="lg-filter-wrapper" style="margin-top:6px; padding-top:6px; border-top:1px dashed #334155;">`;
        
        html += `<div class="lg-filter-toggle" data-filter-key="${filterKey}" style="font-size:0.65rem; color:${hasActiveFilter ? '#facc15' : '#64748b'}; text-transform:uppercase; font-weight:600; cursor:pointer; user-select:none; display:inline-block;">`;
        html += isOpen ? `▼ Filter${hasActiveFilter ? ' (Aktiv)' : ''}` : `▶ Filter${hasActiveFilter ? ' (Aktiv)' : ''}`;
        html += `</div>`;

        if (isOpen) {
            html += `<div class="lg-tags" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" style="display:flex; flex-wrap:wrap; gap:3px; margin-top:6px;">`;
            html += `<span class="lg-tag ${allOn ? 'tag-on' : 'tag-off'}" data-cat-id="__ALL__" title="Alle erlauben">${allOn ? '✓' : '○'} Alle</span>`;
            inst.prioCategories.forEach(cat => {
                const on = allOn || (Array.isArray(allowed) && allowed.includes(cat.id));
                html += `<span class="lg-tag ${on ? 'tag-on' : 'tag-off'}" data-cat-id="${cat.id}">${escapeHtml(cat.label)}</span>`;
            });
            html += `</div>`;
        }
        html += `</div>`;
        return html;
    }

    function renderLane(inst, blockIdx, laneIdx) {
        const block = inst.blocks[blockIdx];
        const lane  = block.lanes[laneIdx];
        const marker = getMarker(lane.marker);
        const edit = inst.editMode;

        let html = `<div class="lg-lane" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}">`;

        html += `<div class="lg-lane-header">`;
        if (block.type === 'multi-lane') {
            if (edit) {
                html += `<select class="lg-marker-select" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" title="Marker wählen">`;
                MARKERS.forEach(m => {
                    const sel = m.id === lane.marker ? ' selected' : '';
                    html += `<option value="${m.id}"${sel}>${m.emoji} ${m.label}</option>`;
                });
                html += `</select>`;
                html += `<input type="text" class="lg-lane-title-input" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" value="${escapeHtml(lane.title || '')}" placeholder="Name..." style="width: 100px; font-size: 0.75rem; margin-left: 4px; background: #0f172a; border: 1px solid #475569; color: #fff; padding: 2px 4px; border-radius: 3px;">`;
            } else {
                html += `<span class="lg-marker-display">${markerIconHtml(lane.marker)}</span>`;
                if (marker.label && marker.id) html += `<span class="lg-lane-label" style="color:${marker.color}">${escapeHtml(marker.label)}</span>`;
                if (lane.title) html += `<span style="margin-left: 6px; font-weight: bold; color: #e2e8f0; font-size: 0.85rem;">${escapeHtml(lane.title)}</span>`;
            }
        }
        html += `<span class="lg-slot-count">${lane.slots.length} Slot${lane.slots.length === 1 ? '' : 's'}</span>`;
        if (edit) {
            html += `<div class="lg-lane-btns">`;
            html += `<button type="button" class="lg-btn lg-slot-remove" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" title="Entfernen">−</button>`;
            html += `<button type="button" class="lg-btn lg-slot-add"    data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" title="Hinzufügen">+</button>`;
            if (block.type === 'multi-lane' && block.lanes.length > 1) {
                html += `<button type="button" class="lg-btn lg-lane-delete" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" title="Entfernen">🗑</button>`;
            }
            html += `</div>`;
        } else {
            html += `<button type="button" class="lg-btn lg-lane-clear" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" title="Leeren">🗑</button>`;
        }
        html += `</div>`;

        if (block.autoFill && inst.prioCategories.length > 0 && block.type === 'multi-lane') {
            html += renderTagsHtml(inst, blockIdx, laneIdx);
        }

        html += `<table class="lg-slot-table"><tbody>`;
        for (let s = 0; s < lane.slots.length; s++) {
            const val = lane.slots[s] || '';
            const dups = val ? findOtherSlotsWithPlayer(inst, val, blockIdx, laneIdx, s) : [];
            const dupClass = dups.length > 0 ? ' is-duplicate' : '';
            // Title kombinieren: voller Spielername (für lange Namen, die durch ellipsis abgeschnitten werden)
            // + Duplikat-Warnung wenn Spieler woanders auch eingeteilt ist
            let titleParts = [];
            if (val) titleParts.push(val);
            if (dups.length > 0) titleParts.push(`⚠ Auch in ${dups.length} weiteren Feldern`);
            const titleAttr = titleParts.length > 0 ? ` title="${escapeHtml(titleParts.join(' — '))}"` : '';
            html += `<tr>`;
            
            if (block.type === 'marked-list') {
                html += `<td class="lg-slot-num" style="width:36px; padding:0;">`;
                if (edit) {
                    html += `<select class="lg-slot-marker-select" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" data-slot-idx="${s}" style="background:#0f172a; border:1px solid #475569; color:#fff; border-radius:3px; padding:2px; font-size:14px; width:36px; height:22px; text-align:center;">`;
                    MARKERS.forEach(m => {
                        const sel = (lane.slotMarkers && lane.slotMarkers[s] === m.id) ? ' selected' : '';
                        html += `<option value="${m.id}"${sel}>${m.emoji}</option>`;
                    });
                    html += `</select>`;
                } else {
                    const mId = (lane.slotMarkers && lane.slotMarkers[s]) || '';
                    html += `<div style="display:flex; justify-content:center; align-items:center; height:22px;">${markerIconHtml(mId)}</div>`;
                }
                html += `</td>`;
            } else {
                html += `<td class="lg-slot-num">${s + 1}</td>`;
            }

            html += `<td><select class="lg-slot-select${dupClass}" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" data-slot-idx="${s}"${titleAttr}>${getPlayerOptionsHtml(inst, val, blockIdx, laneIdx)}</select></td>`;
            html += `<td class="lg-slot-del">`;
            if (val) html += `<button type="button" class="lg-btn lg-slot-clear" data-block-idx="${blockIdx}" data-lane-idx="${laneIdx}" data-slot-idx="${s}" title="Entfernen">✕</button>`;
            html += `</td>`;
            html += `</tr>`;
        }
        html += `</tbody></table>`;

        html += `</div>`;
        return html;
    }

    function renderBlock(inst, blockIdx) {
        const block = inst.blocks[blockIdx];
        const edit = inst.editMode;

        let html = `<div class="lg-block" data-block-idx="${blockIdx}">`;

        html += `<div class="lg-block-header">`;
        if (edit) {
            html += `<input type="text" class="lg-block-title-input" data-block-idx="${blockIdx}" value="${escapeHtml(block.title)}" placeholder="Titel...">`;
            html += `<select class="lg-block-type" data-block-idx="${blockIdx}" title="Block-Typ">`;
            html += `<option value="multi-lane"${block.type === 'multi-lane' ? ' selected' : ''}>Mehrere Spalten (mit Markern)</option>`;
            html += `<option value="single-list"${block.type === 'single-list' ? ' selected' : ''}>Eine Liste (ohne Marker)</option>`;
            html += `<option value="marked-list"${block.type === 'marked-list' ? ' selected' : ''}>Eine Liste (Marker pro Zeile)</option>`;
            html += `</select>`;
            html += `<label class="lg-autofill-toggle" title="Automatisches Füllen erlauben"><input type="checkbox" class="lg-block-autofill" data-block-idx="${blockIdx}"${block.autoFill ? ' checked' : ''}> Auto-Fill</label>`;
            html += `<label class="lg-autofill-toggle" title="Kopieren-Schaltfläche anzeigen"><input type="checkbox" class="lg-block-waexport" data-block-idx="${blockIdx}"${block.waExport ? ' checked' : ''}> WA Export</label>`;
            html += `<label class="lg-autofill-toggle" title="Eigenen Pool verwenden"><input type="checkbox" class="lg-block-isolated" data-block-idx="${blockIdx}"${block.isolatedBlock ? ' checked' : ''}> Eigener Pool</label>`;
            if (block.type === 'multi-lane') {
                html += `<label class="lg-autofill-toggle" title="Spalten teilen sich die Spieler"><input type="checkbox" class="lg-block-sharedlanes" data-block-idx="${blockIdx}"${block.sharedLanes ? ' checked' : ''}> Spalten teilen Pool</label>`;
            }
            html += `<div class="lg-block-btns">`;
            if (blockIdx > 0)                       html += `<button type="button" class="lg-btn lg-block-up"      data-block-idx="${blockIdx}" title="Nach oben">↑</button>`;
            if (blockIdx < inst.blocks.length - 1)  html += `<button type="button" class="lg-btn lg-block-down"    data-block-idx="${blockIdx}" title="Nach unten">↓</button>`;
            if (block.type === 'multi-lane')        html += `<button type="button" class="lg-btn lg-lane-add"      data-block-idx="${blockIdx}" title="Hinzufügen">+ Spalte</button>`;
            html += `<button type="button" class="lg-btn lg-block-delete" data-block-idx="${blockIdx}" title="Löschen">🗑 Block</button>`;
            html += `</div>`;
        } else {
            html += `<h4 class="lg-block-title">${escapeHtml(block.title)}</h4>`;
            if (block.waExport) {
                html += `<button type="button" class="lg-btn lg-block-export" data-block-idx="${blockIdx}" title="Namen kopieren" style="margin-left: auto;">📋 WA Export</button>`;
            }
        }
        html += `</div>`;

        if (block.type === 'multi-lane') {
            // Lane-Anzahl bestimmt die maximale Spaltenzahl pro Zeile.
            // 1–3 Lanes  → max 3 Spalten (alle in einer Zeile)
            // 4+ Lanes   → max 3 Spalten (umbruch nach 3), responsive
            const laneCount = Math.max(block.lanes.length, 1);
            const maxCols = Math.min(laneCount, 3);
            // Inline-Var für die maximale Spalten-Obergrenze, der Rest läuft per Media-Query in CSS.
            html += `<div class="lg-lanes-grid" style="--lg-max-cols:${maxCols};">`;
            block.lanes.forEach((_, li) => { html += renderLane(inst, blockIdx, li); });
            html += `</div>`;
        } else {
            html += `<div class="lg-single-list">`;
            html += renderLane(inst, blockIdx, 0);
            html += `</div>`;
        }

        if (block.autoFill) {
            html += `<div class="lg-block-autofill-row">`;
            html += `<button type="button" class="lg-btn lg-block-fill"    data-block-idx="${blockIdx}">⚡ Auto-Füllen</button>`;
            html += `<button type="button" class="lg-btn lg-block-clear"   data-block-idx="${blockIdx}">🗑 Block leeren</button>`;
            html += `</div>`;
        }

        html += `</div>`;
        return html;
    }

    function renderToolbar(inst) {
        const edit = inst.editMode;
        let html = `<div class="lg-toolbar">`;
        html += `<button type="button" class="lg-btn lg-toggle-edit ${edit ? 'is-active' : ''}">${edit ? '✓ Layout fertig' : '✎ Layout bearbeiten'}</button>`;
        if (edit) html += `<button type="button" class="lg-btn lg-block-add">+ Block</button>`;
        html += `<button type="button" class="lg-btn lg-open-prio-modal">⚙ Auto-Fill-Kategorien</button>`;
        html += `</div>`;
        return html;
    }

    function render(inst) {
        try {
            let html = renderToolbar(inst);
            html += `<div class="lg-blocks">`;
            inst.blocks.forEach((_, bi) => { html += renderBlock(inst, bi); });
            html += `</div>`;
            inst.container.innerHTML = html;

            inst.container.querySelectorAll('.lg-slot-select').forEach(sel => {
                const opt = sel.options[sel.selectedIndex];
                if (opt && opt.value) sel.style.color = opt.dataset.color || '#fff';
            });
            applyManagerProtection(inst);
        } catch (e) { console.error('[LaneGroups] Render-Fehler:', e); }
    }

    function applyManagerProtection(inst) {
        const isM = !!window.isManager;
        inst.container.querySelectorAll('button, input, select').forEach(el => {
            if (!isM && !el.classList.contains('lg-block-export')) {
                el.disabled = true;
                el.classList.add('lg-disabled');
            } else {
                el.disabled = false;
                el.classList.remove('lg-disabled');
            }
        });
    }

    function wireEvents(inst) {
        if (inst.container._lgWired) return;
        inst.container._lgWired = true;
        const c = inst.container;

        c.addEventListener('change', e => {
            const t = e.target;
            if (t.classList.contains('lg-slot-select')) {
                const bi = +t.dataset.blockIdx, li = +t.dataset.laneIdx, si = +t.dataset.slotIdx;
                inst.blocks[bi].lanes[li].slots[si] = t.value;
                refreshDuplicateMarkers(inst); applySlotColors(inst); scheduleSave(inst);
            } else if (t.classList.contains('lg-marker-select')) {
                const bi = +t.dataset.blockIdx, li = +t.dataset.laneIdx;
                inst.blocks[bi].lanes[li].marker = t.value;
                render(inst); scheduleSave(inst);
            } else if (t.classList.contains('lg-slot-marker-select')) {
                const bi = +t.dataset.blockIdx, li = +t.dataset.laneIdx, si = +t.dataset.slotIdx;
                inst.blocks[bi].lanes[li].slotMarkers[si] = t.value;
                render(inst); scheduleSave(inst);
            } else if (t.classList.contains('lg-block-type')) {
                const bi = +t.dataset.blockIdx;
                inst.blocks[bi].type = t.value;
                if ((t.value === 'single-list' || t.value === 'marked-list') && inst.blocks[bi].lanes.length > 1) {
                    inst.blocks[bi].lanes = [inst.blocks[bi].lanes[0]];
                }
                render(inst); scheduleSave(inst);
            } else if (t.classList.contains('lg-block-autofill')) {
                const bi = +t.dataset.blockIdx;
                inst.blocks[bi].autoFill = !!t.checked;
                render(inst); scheduleSave(inst);
            } else if (t.classList.contains('lg-block-waexport')) {
                const bi = +t.dataset.blockIdx;
                inst.blocks[bi].waExport = !!t.checked;
                render(inst); scheduleSave(inst);
            } else if (t.classList.contains('lg-block-isolated')) {
                const bi = +t.dataset.blockIdx;
                inst.blocks[bi].isolatedBlock = !!t.checked;
                refreshDuplicateMarkers(inst); scheduleSave(inst);
            } else if (t.classList.contains('lg-block-sharedlanes')) {
                const bi = +t.dataset.blockIdx;
                inst.blocks[bi].sharedLanes = !!t.checked;
                refreshDuplicateMarkers(inst); scheduleSave(inst);
            }
        });

        c.addEventListener('input', e => {
            const t = e.target;
            if (t.classList.contains('lg-block-title-input')) {
                const bi = +t.dataset.blockIdx;
                inst.blocks[bi].title = t.value; scheduleSave(inst);
            } else if (t.classList.contains('lg-lane-title-input')) {
                const bi = +t.dataset.blockIdx, li = +t.dataset.laneIdx;
                inst.blocks[bi].lanes[li].title = t.value; scheduleSave(inst);
            }
        });

        c.addEventListener('click', e => {
            const t = e.target;
            if (t.closest('.lg-toggle-edit'))    { inst.editMode = !inst.editMode; render(inst); return; }
            if (t.closest('.lg-block-add'))      { addBlock(inst); return; }
            if (t.closest('.lg-open-prio-modal')){ openPrioModal(inst); return; }

            const exportBtn = t.closest('.lg-block-export');
            if (exportBtn) {
                const bi = +exportBtn.dataset.blockIdx;
                const block = inst.blocks[bi];
                let out = [];
                block.lanes.forEach(l => {
                    l.slots.forEach(s => {
                        if (s.trim()) out.push(s.trim());
                    });
                });
                navigator.clipboard.writeText(out.join('\n')).then(() => {
                    const old = exportBtn.textContent;
                    exportBtn.textContent = '✓ Kopiert';
                    setTimeout(() => exportBtn.textContent = old, 1200);
                });
                return;
            }

            const filterToggle = t.closest('.lg-filter-toggle');
            if (filterToggle) {
                if (!inst.openFilters) inst.openFilters = new Set();
                const key = filterToggle.dataset.filterKey;
                if (inst.openFilters.has(key)) inst.openFilters.delete(key);
                else inst.openFilters.add(key);
                render(inst);
                return;
            }

            const tag = t.closest('.lg-tag');
            if (tag) {
                const tagsHost = tag.closest('.lg-tags');
                if (tagsHost) {
                    toggleLaneCat(inst, +tagsHost.dataset.blockIdx, +tagsHost.dataset.laneIdx, tag.dataset.catId); return;
                }
            }

            const upBtn = t.closest('.lg-block-up'), dnBtn = t.closest('.lg-block-down'), delBtn = t.closest('.lg-block-delete');
            const fillBtn = t.closest('.lg-block-fill'), clearBtn = t.closest('.lg-block-clear');
            if (upBtn)  { moveBlock(inst, +upBtn.dataset.blockIdx, -1); return; }
            if (dnBtn)  { moveBlock(inst, +dnBtn.dataset.blockIdx, +1); return; }
            if (delBtn) {
                if (confirm('Löschen?')) {
                    inst.blocks.splice(+delBtn.dataset.blockIdx, 1); render(inst); scheduleSave(inst);
                } return;
            }
            if (fillBtn)  { autoFillBlock(inst, +fillBtn.dataset.blockIdx); return; }
            if (clearBtn) {
                if (confirm('Alle Slots dieses Blocks leeren?')) {
                    const b = inst.blocks[+clearBtn.dataset.blockIdx];
                    b.lanes.forEach(l => { 
                        l.slots = Array(l.slots.length).fill(''); 
                        if (l.slotMarkers) l.slotMarkers = Array(l.slotMarkers.length).fill(''); 
                    });
                    render(inst); scheduleSave(inst);
                } return;
            }

            const laneAdd = t.closest('.lg-lane-add'), laneDel = t.closest('.lg-lane-delete'), laneClear = t.closest('.lg-lane-clear');
            const slotAdd = t.closest('.lg-slot-add'), slotRemove = t.closest('.lg-slot-remove'), slotClear = t.closest('.lg-slot-clear');
            if (laneAdd) {
                inst.blocks[+laneAdd.dataset.blockIdx].lanes.push({ id: generateLaneId(), title: '', marker: '', slots: Array(3).fill(''), slotMarkers: Array(3).fill(''), allowedCats: null });
                render(inst); scheduleSave(inst); return;
            }
            if (laneDel) {
                const bi = +laneDel.dataset.blockIdx, li = +laneDel.dataset.laneIdx;
                if (inst.blocks[bi].lanes.length > 1 && confirm('Spalte löschen?')) {
                    inst.blocks[bi].lanes.splice(li, 1); render(inst); scheduleSave(inst);
                } return;
            }
            if (laneClear) {
                if (confirm('Spalte leeren?')) {
                    const lane = inst.blocks[+laneClear.dataset.blockIdx].lanes[+laneClear.dataset.laneIdx];
                    lane.slots = Array(lane.slots.length).fill(''); 
                    if (lane.slotMarkers) lane.slotMarkers = Array(lane.slotMarkers.length).fill('');
                    render(inst); scheduleSave(inst);
                } return;
            }
            if (slotAdd) {
                const lane = inst.blocks[+slotAdd.dataset.blockIdx].lanes[+slotAdd.dataset.laneIdx];
                if (lane.slots.length < 30) { 
                    lane.slots.push(''); 
                    if (!lane.slotMarkers) lane.slotMarkers = [];
                    lane.slotMarkers.push(''); 
                    render(inst); scheduleSave(inst); 
                }
                return;
            }
            if (slotRemove) {
                const lane = inst.blocks[+slotRemove.dataset.blockIdx].lanes[+slotRemove.dataset.laneIdx];
                if (lane.slots.length > 1) { 
                    lane.slots.pop(); 
                    if (lane.slotMarkers) lane.slotMarkers.pop(); 
                    render(inst); scheduleSave(inst); 
                }
                return;
            }
            if (slotClear) {
                inst.blocks[+slotClear.dataset.blockIdx].lanes[+slotClear.dataset.laneIdx].slots[+slotClear.dataset.slotIdx] = '';
                render(inst); scheduleSave(inst); return;
            }
        });
    }

    function addBlock(inst) {
        inst.blocks.push(normalizeBlock({ title: 'Neuer Block', type: 'multi-lane', autoFill: true, waExport: false, isolatedBlock: true, sharedLanes: true, lanes: [{ title: '', marker: '', slots: ['', '', ''], slotMarkers: ['', '', ''] }] }));
        render(inst); scheduleSave(inst);
    }
    function moveBlock(inst, idx, delta) {
        const newIdx = idx + delta;
        if (newIdx < 0 || newIdx >= inst.blocks.length) return;
        const [b] = inst.blocks.splice(idx, 1);
        inst.blocks.splice(newIdx, 0, b);
        render(inst); scheduleSave(inst);
    }
    function toggleLaneCat(inst, bi, li, catId) {
        const lane = inst.blocks[bi].lanes[li];
        if (catId === '__ALL__') { lane.allowedCats = (lane.allowedCats === null) ? [] : null; } else {
            if (lane.allowedCats === null) lane.allowedCats = inst.prioCategories.filter(c => c.id !== catId).map(c => c.id);
            else {
                const idx = lane.allowedCats.indexOf(catId);
                if (idx >= 0) lane.allowedCats.splice(idx, 1); else lane.allowedCats.push(catId);
                if (lane.allowedCats.length === inst.prioCategories.length) lane.allowedCats = null;
            }
        }
        render(inst); scheduleSave(inst);
    }

    function refreshDuplicateMarkers(inst) {
        inst.container.querySelectorAll('.lg-slot-select').forEach(sel => {
            const bi = +sel.dataset.blockIdx, li = +sel.dataset.laneIdx, si = +sel.dataset.slotIdx;
            const val = inst.blocks[bi]?.lanes[li]?.slots[si] || '';
            const dups = val ? findOtherSlotsWithPlayer(inst, val, bi, li, si) : [];
            const parts = [];
            if (val) parts.push(val);
            if (dups.length > 0) parts.push('⚠ Auch in ' + dups.length + ' weiteren Feldern');
            if (parts.length > 0) sel.title = parts.join(' — ');
            else                  sel.removeAttribute('title');
            if (dups.length > 0)  sel.classList.add('is-duplicate');
            else                  sel.classList.remove('is-duplicate');
        });
    }
    function applySlotColors(inst) {
        inst.container.querySelectorAll('.lg-slot-select').forEach(sel => {
            const opt = sel.options[sel.selectedIndex];
            sel.style.color = (opt && opt.value) ? (opt.dataset.color || '#fff') : '';
        });
    }

    function buildSortedRoster(inst) {
        const sorted = [];
        inst.prioCategories.forEach(cat => {
            (inst.roster || []).forEach(p => {
                const name = p.name || p;
                if (isPlayerOnBench(name)) return;
                if (playerMatchesCategory(p, cat)) sorted.push({ name, category: cat, player: p });
            });
        });
        (inst.roster || []).forEach(p => {
            const name = p.name || p;
            if (isPlayerOnBench(name)) return;
            if (!sorted.some(s => s.name === name)) sorted.push({ name, category: null, player: p });
        });
        return sorted;
    }

    function autoFillBlock(inst, blockIdx) {
        if (!window.isManager) return;
        const block = inst.blocks[blockIdx];
        if (!block || !block.autoFill) return;
        if (!Array.isArray(inst.roster) || inst.roster.length === 0) return;

        const alreadyAssignedGlobal = new Set();
        const alreadyAssignedPerLane = block.lanes.map(() => new Set());
        const usedByLane = block.lanes.map(() => ({}));

        block.lanes.forEach((lane, li) => {
            lane.slots.forEach((name, si) => {
                if (!name) return;
                alreadyAssignedGlobal.add(name);
                alreadyAssignedPerLane[li].add(name);
                const ply = findRosterPlayer(inst.roster, name);
                const cat = ply ? getPlayerCategory(ply, inst.prioCategories) : null;
                if (cat) {
                    if (!usedByLane[li][cat.id]) usedByLane[li][cat.id] = [];
                    usedByLane[li][cat.id].push(si);
                }
            });
        });

        const fullPool = buildSortedRoster(inst);

        let filled = 0;
        const maxSlots = Math.max(...block.lanes.map(l => l.slots.length));
        for (let sIdx = 0; sIdx < maxSlots; sIdx++) {
            for (let li = 0; li < block.lanes.length; li++) {
                const lane = block.lanes[li];
                if (sIdx >= lane.slots.length || lane.slots[sIdx]) continue;

                let foundCand = null;
                for (let j = 0; j < fullPool.length; j++) {
                    const cand = fullPool[j];
                    const cat = cand.category;

                    if (block.sharedLanes && alreadyAssignedGlobal.has(cand.name)) continue;
                    if (!block.sharedLanes && alreadyAssignedPerLane[li].has(cand.name)) continue;

                    if (lane.allowedCats !== null && Array.isArray(lane.allowedCats)) {
                        if (lane.allowedCats.length === 0 || !cat || !lane.allowedCats.includes(cat.id)) continue;
                    }
                    if (cat) {
                        if (cat.limitRows && cat.limitCount !== undefined && cat.limitCount !== '' && sIdx < cat.limitRows) {
                            const usedInFirstN = (usedByLane[li][cat.id] || []).filter(idx => idx < cat.limitRows).length;
                            if (usedInFirstN >= cat.limitCount) continue;
                        }
                        if (cat.maxTotal !== undefined && cat.maxTotal !== '' && cat.maxTotal !== null) {
                            const usedTotal = (usedByLane[li][cat.id] || []).length;
                            if (usedTotal >= cat.maxTotal) continue;
                        }
                    }
                    foundCand = cand; break;
                }
                if (foundCand) {
                    lane.slots[sIdx] = foundCand.name;
                    alreadyAssignedGlobal.add(foundCand.name);
                    alreadyAssignedPerLane[li].add(foundCand.name);
                    if (foundCand.category) {
                        if (!usedByLane[li][foundCand.category.id]) usedByLane[li][foundCand.category.id] = [];
                        usedByLane[li][foundCand.category.id].push(sIdx);
                    }
                    filled++;
                }
            }
        }
        render(inst); scheduleSave(inst);
    }

    function openPrioModal(inst) {
        let overlay = document.getElementById('lg-prio-overlay');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'lg-prio-overlay';
        overlay.className = 'lg-modal-overlay';
        overlay.innerHTML = renderPrioModalHtml(inst);
        document.body.appendChild(overlay);

        overlay.querySelector('.lg-modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        overlay.addEventListener('click', e => {
            const upBtn = e.target.closest('.lg-prio-up'), dnBtn = e.target.closest('.lg-prio-down');
            const delBtn = e.target.closest('.lg-prio-del'), editBtn = e.target.closest('.lg-prio-edit');
            const addBtn = e.target.closest('.lg-prio-add'), resetBtn = e.target.closest('.lg-prio-reset');

            if (upBtn) { const i = +upBtn.dataset.idx; if (i > 0) { [inst.prioCategories[i-1], inst.prioCategories[i]] = [inst.prioCategories[i], inst.prioCategories[i-1]]; overlay.innerHTML = renderPrioModalHtml(inst); savePrio(inst); render(inst); } return; }
            if (dnBtn) { const i = +dnBtn.dataset.idx; if (i < inst.prioCategories.length - 1) { [inst.prioCategories[i], inst.prioCategories[i+1]] = [inst.prioCategories[i+1], inst.prioCategories[i]]; overlay.innerHTML = renderPrioModalHtml(inst); savePrio(inst); render(inst); } return; }
            if (delBtn) { const i = +delBtn.dataset.idx; if (confirm('Löschen?')) { inst.prioCategories.splice(i, 1); overlay.innerHTML = renderPrioModalHtml(inst); savePrio(inst); render(inst); } return; }
            if (editBtn) { editCategory(inst, +editBtn.dataset.idx, overlay); return; }
            if (addBtn)  { editCategory(inst, -1, overlay); return; }
            if (resetBtn) { if (confirm('Auf Defaults zurücksetzen?')) { inst.prioCategories = DEFAULT_PRIO_CATEGORIES.map(c => ({ ...c })); overlay.innerHTML = renderPrioModalHtml(inst); savePrio(inst); render(inst); } return; }
        });
    }

    function renderPrioModalHtml(inst) {
        let html = `<div class="lg-modal"><div class="lg-modal-header"><h3>Auto-Fill-Kategorien</h3><button class="lg-modal-close">✕</button></div><div class="lg-modal-body"><ul class="lg-prio-list">`;
        inst.prioCategories.forEach((c, i) => {
            html += `<li class="lg-prio-item"><span class="lg-prio-idx">${i + 1}.</span><span class="lg-prio-label"><strong>${escapeHtml(c.label)}</strong></span><div class="lg-prio-btns"><button class="lg-btn lg-prio-up" data-idx="${i}">↑</button><button class="lg-btn lg-prio-down" data-idx="${i}">↓</button><button class="lg-btn lg-prio-edit" data-idx="${i}">✎</button><button class="lg-btn lg-prio-del" data-idx="${i}">🗑</button></div></li>`;
        });
        html += `</ul><div class="lg-modal-actions"><button class="lg-btn lg-prio-add">+ Kategorie</button><button class="lg-btn lg-prio-reset">↺ Defaults</button></div></div></div>`;
        return html;
    }

    function editCategory(inst, idx, overlay) {
        const isNew = (idx < 0);
        const cat = isNew ? { id: '', label: '', class: '', spec: '', role: '', archetype: '' } : { ...inst.prioCategories[idx] };
        const editBox = document.createElement('div');
        editBox.className = 'lg-modal-edit';
        editBox.innerHTML = `<h4>${isNew ? 'Neue Kategorie' : 'Bearbeiten'}</h4>
            <div class="lg-form-row"><label>Name</label><input id="lg-cat-label" type="text" value="${escapeHtml(cat.label)}"></div>
            <div class="lg-form-row"><label>Klasse</label><select id="lg-cat-class"><option value="">— alle —</option>${Object.keys(SPEC_DEFINITIONS).map(c => `<option value="${c}"${c === cat.class ? ' selected' : ''}>${CLASS_DISPLAY[c]}</option>`).join('')}</select></div>
            <div class="lg-form-row"><label>Spec</label><select id="lg-cat-spec"><option value="">— alle —</option></select></div>
            <div class="lg-form-row"><label>Rolle</label><select id="lg-cat-role"><option value="">— beliebig —</option><option value="tank"${cat.role === 'tank' ? ' selected' : ''}>Tank</option><option value="healer"${cat.role === 'healer' ? ' selected' : ''}>Healer</option><option value="dps"${cat.role === 'dps' ? ' selected' : ''}>DPS</option></select></div>
            <div class="lg-form-row"><label>Archetyp</label><select id="lg-cat-arch"><option value="">— beliebig —</option><option value="melee"${cat.archetype === 'melee' ? ' selected' : ''}>Melee</option><option value="ranged_physical"${cat.archetype === 'ranged_physical' ? ' selected' : ''}>R-Physical DPS</option><option value="caster"${cat.archetype === 'caster' ? ' selected' : ''}>Caster</option></select></div>
            <hr>
            <div class="lg-form-row"><label>Max in ersten N Slots</label><input id="lg-cat-limit-rows" type="number" min="1" value="${cat.limitRows || ''}" style="width:60px"><input id="lg-cat-limit-count" type="number" min="0" value="${cat.limitCount !== undefined ? cat.limitCount : ''}" style="width:80px"></div>
            <div class="lg-form-row"><label>Max gesamt</label><input id="lg-cat-max-total" type="number" min="0" value="${cat.maxTotal !== undefined && cat.maxTotal !== null ? cat.maxTotal : ''}" style="width:100px"></div>
            <div class="lg-modal-actions"><button class="lg-btn lg-cat-save">Speichern</button><button class="lg-btn lg-cat-cancel">Abbrechen</button></div>`;
        overlay.querySelector('.lg-modal').appendChild(editBox);

        const specSel = editBox.querySelector('#lg-cat-spec');
        function refreshSpecOptions() {
            const cls = editBox.querySelector('#lg-cat-class').value;
            specSel.innerHTML = '<option value="">— alle —</option>';
            if (cls && SPEC_DEFINITIONS[cls]) SPEC_DEFINITIONS[cls].forEach(s => { specSel.innerHTML += `<option value="${s.value}"${s.value === cat.spec ? ' selected' : ''}>${s.label}</option>`; });
        }
        refreshSpecOptions();
        editBox.querySelector('#lg-cat-class').addEventListener('change', refreshSpecOptions);

        editBox.querySelector('.lg-cat-cancel').addEventListener('click', () => editBox.remove());
        editBox.querySelector('.lg-cat-save').addEventListener('click', () => {
            const label = editBox.querySelector('#lg-cat-label').value.trim();
            if (!label) return;
            const next = { id: isNew ? ('cat-' + Math.random().toString(36).slice(2, 8)) : cat.id, label, class: editBox.querySelector('#lg-cat-class').value, spec: editBox.querySelector('#lg-cat-spec').value, role: editBox.querySelector('#lg-cat-role').value, archetype: editBox.querySelector('#lg-cat-arch').value };
            const lr = editBox.querySelector('#lg-cat-limit-rows').value, lc = editBox.querySelector('#lg-cat-limit-count').value, mt = editBox.querySelector('#lg-cat-max-total').value;
            if (lr && lc !== '') { next.limitRows = +lr; next.limitCount = +lc; }
            if (mt !== '') { next.maxTotal = +mt; }
            if (isNew) inst.prioCategories.push(next); else inst.prioCategories[idx] = next;
            editBox.remove(); overlay.innerHTML = renderPrioModalHtml(inst); savePrio(inst); render(inst);
        });
    }

    let _cssInjected = false;
    function injectCss() {
        if (_cssInjected) return;
        _cssInjected = true;
        const css = `
            .lg-toolbar { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; padding:6px; background:rgba(15,23,42,0.4); border:1px solid #334155; border-radius:4px; }
            .lg-btn { background:#1e293b; color:#e2e8f0; border:1px solid #475569; border-radius:4px; padding:4px 8px; font-size:0.75rem; cursor:pointer; transition:filter 0.15s; }
            .lg-btn:hover:not(:disabled) { filter:brightness(1.2); }
            .lg-btn:disabled, .lg-btn.lg-disabled { opacity:0.5; cursor:not-allowed; }
            .lg-btn.is-active { background:#065f46; border-color:#10b981; color:#d1fae5; }
            .lg-toggle-edit { background:#1e3a8a; border-color:#3b82f6; color:#dbeafe; }
            .lg-block-export { background:#6b21a8; border-color:#9333ea; color:#f3e8ff; }
            .lg-blocks { display:flex; flex-direction:column; gap:14px; }
            .lg-block { background:rgba(15,23,42,0.4); border:1px solid #334155; border-radius:6px; padding:10px; }
            .lg-block-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #334155; }
            .lg-block-title { color:#fcd34d; font-size:1rem; font-weight:600; margin:0; }
            .lg-block-title-input { flex:1; min-width:140px; background:#0f172a; border:1px solid #475569; color:#fcd34d; border-radius:3px; padding:4px 6px; font-size:0.9rem; font-weight:600; }
            .lg-block-type { background:#0f172a; border:1px solid #475569; color:#e2e8f0; border-radius:3px; padding:4px 6px; font-size:0.75rem; }
            .lg-autofill-toggle { color:#94a3b8; font-size:0.75rem; display:flex; align-items:center; gap:4px; cursor:pointer; }
            .lg-block-btns { display:flex; gap:4px; margin-left:auto; }
            .lg-lanes-grid {
                display: grid;
                gap: 8px;
                /* Default (große Screens):
                   - max --lg-max-cols Spalten (per Inline-Style; bis zu 3)
                   - min 140px pro Spalte für lesbare Spielernamen */
                grid-template-columns: repeat(var(--lg-max-cols, 3), minmax(140px, 1fr));
            }
            /* Mittlere Screens (≤1100px Viewport): max 2 Spalten — Lanes umbrechen */
            @media (max-width: 1100px) {
                .lg-lanes-grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
            }
            /* Kleine Screens (≤640px): 1 Spalte */
            @media (max-width: 640px) {
                .lg-lanes-grid { grid-template-columns: 1fr; }
            }
            .lg-single-list { display:block; }
            .lg-lane { background:rgba(15,23,42,0.6); border:1px solid #475569; border-radius:6px; padding:8px; }
            .lg-lane-header { display:flex; align-items:center; gap:6px; margin-bottom:6px; padding-bottom:4px; border-bottom:1px solid #334155; flex-wrap:wrap; }
            .lg-marker-display { display:inline-flex; align-items:center; }
            .lg-marker-icon { width:20px; height:20px; border:1px solid #475569; border-radius:3px; background:#0f172a; }
            .lg-marker-emoji { font-size:18px; line-height:1; padding:0 2px; }
            .lg-lane-label { font-weight:600; font-size:0.8rem; }
            .lg-slot-count { font-size:0.65rem; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; margin-left:auto; }
            .lg-lane-btns { display:flex; gap:3px; }
            .lg-lane-btns .lg-btn, .lg-lane-clear { padding:2px 6px; font-size:0.7rem; }
            .lg-marker-select {
                background:#0f172a; border:1px solid #475569; color:#e2e8f0;
                border-radius:3px; padding:2px 4px; font-size:0.7rem;
                /* In schmalen Lanes nicht aus dem Container brechen */
                min-width:0; max-width:100%; flex:1 1 auto;
            }
            .lg-slot-table { width:100%; font-size:0.7rem; }
            .lg-slot-table td { padding:1px 3px; }
            .lg-slot-num { color:#64748b; font-family:monospace; text-align:center; width:20px; }
            .lg-slot-del { text-align:center; width:20px; }
            .lg-slot-select {
                background:#0f172a; border:1px solid #475569; color:#fff;
                border-radius:3px; padding:2px 4px; font-size:0.7rem;
                width:100%; min-width:0; max-width:100%; height:22px;
                box-sizing:border-box;
                /* Lange Namen abschneiden statt Lane sprengen */
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
            }
            .lg-slot-select.is-duplicate { border-color:#facc15; box-shadow:0 0 0 1px rgba(250,204,21,0.4) inset; }
            .lg-slot-clear { color:#f87171; }
            .lg-tags { display:flex; flex-wrap:wrap; gap:3px; margin-top:6px; padding-top:6px; }
            .lg-tag { display:inline-block; padding:1px 6px; font-size:0.65rem; border-radius:9999px; cursor:pointer; user-select:none; border:1px solid; line-height:1.4; transition:filter 0.15s; }
            .lg-tag.tag-on  { background:#065f46; color:#d1fae5; border-color:#10b981; }
            .lg-tag.tag-off { background:#1e293b; color:#64748b; border-color:#334155; text-decoration:line-through; text-decoration-color:#475569; }
            .lg-tag:hover { filter:brightness(1.2); }
            .lg-block-autofill-row { display:flex; gap:6px; margin-top:8px; padding-top:8px; border-top:1px solid #334155; }
            .lg-block-fill { background:#854d0e; border-color:#eab308; color:#fef9c3; }

            .lg-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:50; display:flex; align-items:center; justify-content:center; padding:16px; }
            .lg-modal { background:#1e293b; border:1px solid #475569; border-radius:8px; padding:0; max-width:600px; width:100%; max-height:90vh; overflow:auto; }
            .lg-modal-header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid #334155; }
            .lg-modal-header h3 { color:#fcd34d; margin:0; font-size:1.1rem; }
            .lg-modal-close { background:transparent; border:none; color:#94a3b8; font-size:1.2rem; cursor:pointer; }
            .lg-modal-close:hover { color:#fff; }
            .lg-modal-body { padding:12px 16px; }
            .lg-modal-help { color:#94a3b8; font-size:0.8rem; margin:0 0 12px 0; }
            .lg-prio-list { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:4px; }
            .lg-prio-item { display:flex; align-items:center; gap:8px; padding:6px 8px; background:#0f172a; border:1px solid #334155; border-radius:4px; }
            .lg-prio-idx { color:#64748b; font-family:monospace; min-width:20px; }
            .lg-prio-label { flex:1; color:#e2e8f0; font-size:0.85rem; }
            .lg-prio-meta { color:#94a3b8; font-size:0.7rem; }
            .lg-prio-btns { display:flex; gap:3px; }
            .lg-prio-btns .lg-btn { padding:2px 6px; font-size:0.75rem; }
            .lg-modal-actions { display:flex; gap:6px; margin-top:12px; padding-top:12px; border-top:1px solid #334155; }
            .lg-modal-edit { margin-top:12px; padding:12px; background:#0f172a; border:1px solid #475569; border-radius:6px; }
            .lg-modal-edit h4 { color:#fcd34d; margin:0 0 8px 0; font-size:0.95rem; }
            .lg-modal-edit hr { border:none; border-top:1px solid #334155; margin:8px 0; }
            .lg-form-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
            .lg-form-row label { color:#94a3b8; font-size:0.8rem; min-width:130px; }
            .lg-form-row input[type="text"], .lg-form-row select { flex:1; background:#1e293b; border:1px solid #475569; color:#fff; border-radius:3px; padding:4px 6px; font-size:0.85rem; }
            .lg-form-row input[type="number"] { background:#1e293b; border:1px solid #475569; color:#fff; border-radius:3px; padding:4px 6px; font-size:0.85rem; }
        `;
        const styleEl = document.createElement('style'); styleEl.id = 'lg-styles'; styleEl.textContent = css; document.head.appendChild(styleEl);
    }

    function init(config) {
        injectCss();
        const inst = makeInstance(config);
        if (!inst) return null;
        loadState(inst, config.assignments);
        render(inst); wireEvents(inst);
        setInterval(() => applyManagerProtection(inst), 1500);
        return inst;
    }

    return { init, _instances };

})();