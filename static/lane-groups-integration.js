/**
 * Lane-Groups Integration für Master-View (comp.html).
 *
 * Diese Datei hängt LaneGroups-Container in den Master-View ein, sodass alle
 * Boss-Einteilungen voll editierbar in der Comp-Übersicht erscheinen. Änderungen
 * schreiben direkt in dieselben Firestore-Pfade wie auf der Boss-Seite -
 * Boss-Seite und Master-View sind also synchron.
 *
 * Zusätzlich: read-only Anzeige der boss-spezifischen Sonder-Einteilungen (Sha-
 * Platten, Norushen-Orbs, Siegecrafter-Lines, Kill-Reihenfolgen) am Ende jedes
 * Boss-Panels - als lesbare Blöcke, der WeakAura-String hängt aufklappbar daran.
 *
 * Hinweis: Der globale WeakAura-Export wird NICHT von dieser Datei gehandhabt
 * - das macht planner-bosses.js nativ (Modul-Ebene buildShaPlatesExport,
 * buildNorushenOrbExport, buildSiegecrafterKillorderExport, etc.).
 *
 * Voraussetzungen:
 *  - lane-groups.js muss VOR dieser Datei geladen sein.
 *  - slot-system.js muss geladen + initialisiert sein.
 *  - Diese Datei muss NACH planner-bosses.js geladen werden.
 *
 * Einbau (in index.html):
 *   <script src="static/lane-groups-integration.js"></script>
 */

(function () {
    'use strict';

    if (!window.LaneGroups) {
        console.warn('[LaneGroups-Integration] window.LaneGroups nicht gefunden - Datei wird nicht aktiv.');
        return;
    }

    // ════════════════════════════════════════════════════════════
    // PROVIDER-REGISTRY (für read-only WA-Anzeige im Master-View)
    // ════════════════════════════════════════════════════════════
    // Jeder Provider liest Firestore-Daten eines Bosses und liefert einen
    // fertigen WA-String. Wird im Master-View pro Boss-Panel als read-only
    // Textarea angezeigt. Format:
    //   { id, label, color, bossIds: [...], build(data, bossId) → string|null,
    //     renderView(data, bossId) → HTML-String|null (lesbare Read-only-Ansicht) }

    if (!window.BossWaProviders) window.BossWaProviders = [];

    // Sha-of-Pride Platten
    window.BossWaProviders.push({
        id: 'sha-plates',
        renderView: (data) => renderShaPlates(data),
        label: '🌈 Sha-of-Pride Platten',
        color: 'text-pink-300',
        bossIds: ['sha-of-pride'],
        build(data) {
            const block = data['sha-plates'];
            if (!block || !Array.isArray(block.platesData)) return null;
            const lines = [];
            block.platesData.forEach(plate => {
                if (!plate || !Array.isArray(plate.slots)) return;
                const players = plate.slots.map(s => resolveValueForExport(s)).filter(Boolean);
                if (players.length === 0) return;
                const prefix = plate.rt ? `{${plate.rt}}-` : '';
                lines.push(prefix + players.join(','));
            });
            return lines.length > 0 ? lines.join('\n') : null;
        }
    });

    // Norushen Orb-Reihenfolge
    window.BossWaProviders.push({
        id: 'norushen-orb-order',
        renderView: (data) => renderNorushenOrbs(data),
        label: '🔮 Norushen Orb-Reihenfolge',
        color: 'text-purple-300',
        bossIds: ['norushen'],
        build(data) {
            const block = data['norushen-orb-order'];
            if (!block || !Array.isArray(block.orderData)) return null;
            const entries = block.orderData
                .filter(r => r && r.player && r.delay !== '' && r.delay !== null && r.delay !== undefined)
                .map(r => `${resolveValueForExport(r.player) || r.player}-${r.delay}`);
            return entries.length > 0 ? entries.join(',') : null;
        }
    });

    // Siegecrafter Kill-Reihenfolge (Missile/Mine/Laser)
    window.BossWaProviders.push({
        id: 'blackfuse-killorder',
        renderView: (data) => renderKillOrder(data, 'blackfuse-killorder'),
        label: '⚙️ Siegecrafter Kill-Reihenfolge',
        color: 'text-orange-300',
        bossIds: ['siegecrafter'],
        build(data) {
            const block = data['blackfuse-killorder'];
            if (!block) return null;
            let arr = block.killOrder;
            if (!Array.isArray(arr)) {
                if (arr && typeof arr === 'object') arr = Object.values(arr);
                else return null;
            }
            const filtered = arr.filter(s => s && typeof s === 'string' && s.trim());
            return filtered.length > 0 ? filtered.join(',') : null;
        }
    });

    // Siegecrafter Conveyor-Lines (Team-Zuweisungen)
    window.BossWaProviders.push({
        id: 'blackfuse-lines',
        renderView: (data) => renderBlackfuseLines(data),
        label: '📏 Siegecrafter Conveyor-Lines',
        color: 'text-yellow-300',
        bossIds: ['siegecrafter'],
        build(data) {
            const block = data['blackfuse-lines'];
            if (!block || !Array.isArray(block.teamsData) || !Array.isArray(block.lineTeams)) return null;
            const parts = [];
            block.lineTeams.forEach((teamIdx, l) => {
                if (teamIdx !== '0' && teamIdx !== '1' && teamIdx !== 0 && teamIdx !== 1) return;
                const idx = parseInt(teamIdx);
                const teamRaw = block.teamsData[idx];
                // teamsData[i] kann {slots:[...]}, Array oder Object sein
                let team = [];
                if (Array.isArray(teamRaw)) {
                    team = teamRaw;
                } else if (teamRaw && Array.isArray(teamRaw.slots)) {
                    team = teamRaw.slots;
                } else if (teamRaw && typeof teamRaw === 'object') {
                    team = Object.values(teamRaw);
                }
                const players = team.map(s => resolveValueForExport(s)).filter(Boolean);
                if (players.length > 0) parts.push(`LINE${l + 1}-${players.join(',')}`);
            });
            return parts.length > 0 ? parts.join(',') : null;
        }
    });

    // Paragons Kill-Reihenfolge (Boss-Namen)
    window.BossWaProviders.push({
        id: 'paragons-killorder',
        renderView: (data) => renderKillOrder(data, 'paragons-killorder'),
        label: '🎯 Paragons Kill-Reihenfolge',
        color: 'text-red-300',
        bossIds: ['paragons'],
        build(data) {
            const block = data['paragons-killorder'];
            if (!block) return null;
            let arr = block.killOrder;
            if (!Array.isArray(arr)) {
                if (arr && typeof arr === 'object') arr = Object.values(arr);
                else return null;
            }
            const filtered = arr.filter(s => s && typeof s === 'string' && s.trim());
            return filtered.length > 0 ? filtered.join(',') : null;
        }
    });

    // ════════════════════════════════════════════════════════════
    // READ-ONLY DARSTELLUNG DER SONDER-EINTEILUNGEN
    // ════════════════════════════════════════════════════════════
    // Sha-Platten, Norushen-Orbs, Siegecrafter-Lines und die Kill-Reihenfolgen
    // haben eigene UIs, deren Boss-Seiten-Skripte im Master-View nicht laufen.
    // Damit die Einteilungs-Übersicht trotzdem vollständig ist, rendern wir die
    // gespeicherten Daten hier als kompakte, lesbare Blöcke.

    // Raid-Target-Marker (rt1..rt8) wie auf der Sha-Seite
    const RT_LABELS = {
        rt1: '★ Stern', rt2: '● Kreis', rt3: '◆ Diamant', rt4: '△ Dreieck',
        rt5: '☾ Mond', rt6: '◻ Quadrat', rt7: '✚ Kreuz', rt8: '☠ Totenkopf'
    };

    // Spielername als eingefärbter Chip. Spec-Slots werden vorher aufgelöst.
    function playerChip(value) {
        const name = resolveValueForExport(value) || value;
        if (!name) return '';
        const player = (window.rosterData || []).find(pl => pl.name === name);
        const color = (player && window.classColors && window.classColors[player.class]) || '#e2e8f0';
        return '<span class="inline-block px-1.5 py-0.5 rounded bg-slate-900/70 border border-slate-700 text-[10px] font-semibold"'
            + ' style="color:' + color + '">' + escapeHtml(name) + '</span>';
    }

    function chipRow(values) {
        const chips = (values || []).map(playerChip).filter(Boolean);
        if (chips.length === 0) return '<span class="text-[10px] text-gray-600 italic">leer</span>';
        return '<div class="flex flex-wrap gap-1">' + chips.join('') + '</div>';
    }

    function mvCard(title, innerHtml) {
        return '<div class="bg-slate-900/40 border border-slate-700 rounded p-2">'
            + '<div class="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">' + escapeHtml(title) + '</div>'
            + innerHtml + '</div>';
    }

    // Sha-of-Pride: 4 Platten mit Marker + Spielern
    function renderShaPlates(data) {
        const block = data['sha-plates'];
        if (!block || !Array.isArray(block.platesData)) return null;
        const anyFilled = block.platesData.some(pl =>
            pl && Array.isArray(pl.slots) && pl.slots.some(v => v && String(v).trim()));
        if (!anyFilled) return null;
        const cards = block.platesData.map((plate, i) => {
            const slots = (plate && Array.isArray(plate.slots)) ? plate.slots : [];
            const marker = plate && plate.rt ? (RT_LABELS[plate.rt] || plate.rt) : 'ohne Marker';
            return mvCard('Platte ' + (i + 1) + ' - ' + marker, chipRow(slots));
        });
        return cards.length ? '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">' + cards.join('') + '</div>' : null;
    }

    // Norushen: Reihenfolge der Lichtkugeln mit Delay
    function renderNorushenOrbs(data) {
        const block = data['norushen-orb-order'];
        if (!block || !Array.isArray(block.orderData)) return null;
        const rows = block.orderData
            .filter(r => r && (r.player || (r.delay !== '' && r.delay !== null && r.delay !== undefined)))
            .map((r, i) => {
                const delay = (r.delay === '' || r.delay === null || r.delay === undefined) ? '-' : r.delay + 's';
                const who = playerChip(r.player) || '<span class="text-gray-600 italic">frei</span>';
                return '<div class="flex items-center gap-2 text-[11px] py-0.5">'
                    + '<span class="w-5 text-right text-gray-500 font-mono">' + (i + 1) + '.</span>'
                    + '<span class="flex-1">' + who + '</span>'
                    + '<span class="text-gray-400 font-mono">' + delay + '</span>'
                    + '</div>';
            });
        return rows.length ? '<div class="bg-slate-900/40 border border-slate-700 rounded p-2">' + rows.join('') + '</div>' : null;
    }

    // Siegecrafter: Conveyor-Teams und ihre Line-Zuordnung
    function renderBlackfuseLines(data) {
        const block = data['blackfuse-lines'];
        if (!block || !Array.isArray(block.teamsData)) return null;

        const teamSlots = idx => {
            const raw = block.teamsData[idx];
            if (Array.isArray(raw)) return raw;
            if (raw && Array.isArray(raw.slots)) return raw.slots;
            if (raw && typeof raw === 'object') return Object.values(raw);
            return [];
        };

        const hasPlayers = block.teamsData.some((_, i) => teamSlots(i).some(v => v && String(v).trim()));
        const hasLines = Array.isArray(block.lineTeams)
            && block.lineTeams.some(t => t === '0' || t === '1' || t === 0 || t === 1);
        if (!hasPlayers && !hasLines) return null;

        const teams = block.teamsData.map((_, i) => mvCard('Team ' + (i + 1), chipRow(teamSlots(i))));

        let linesHtml = '';
        if (Array.isArray(block.lineTeams)) {
            const items = block.lineTeams.map((t, l) => {
                const label = (t === '0' || t === 0) ? 'Team 1' : (t === '1' || t === 1) ? 'Team 2' : '-';
                return '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-900/70 border border-slate-700">'
                    + 'Line ' + (l + 1) + ': <b class="text-yellow-200">' + label + '</b></span>';
            });
            linesHtml = mvCard('Line-Zuordnung', '<div class="flex flex-wrap gap-1">' + items.join('') + '</div>');
        }

        return '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">' + teams.join('') + '</div>'
            + (linesHtml ? '<div class="mt-2">' + linesHtml + '</div>' : '');
    }

    // Kill-Reihenfolgen (Siegecrafter-Waffen / Paragons) als nummerierte Chips
    function renderKillOrder(data, key) {
        const block = data[key];
        if (!block) return null;
        let arr = block.killOrder;
        if (!Array.isArray(arr)) {
            if (arr && typeof arr === 'object') arr = Object.values(arr);
            else return null;
        }
        const items = arr.filter(v => v && String(v).trim()).map((v, i) =>
            '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-900/70 border border-slate-700">'
            + '<span class="text-gray-500 font-mono mr-1">' + (i + 1) + '.</span>'
            + escapeHtml(String(v)) + '</span>');
        return items.length ? '<div class="flex flex-wrap gap-1">' + items.join('') + '</div>' : null;
    }

    // Resolution-Helper: Spec-Slot oder Klassen-Wildcard zu Spielername
    function resolveValueForExport(val) {
        if (!val) return '';
        const ss = window.SlotSystem;
        if (ss && ss.isSlotKey && ss.isSlotKey(val)) {
            const resolved = ss.resolvePlayerName(val, true);
            if (!resolved) return '';
            const rosterNames = new Set((window.rosterData || []).map(p => p.name));
            if (!rosterNames.has(resolved)) return '';
            return resolved;
        }
        return val;
    }

    function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ════════════════════════════════════════════════════════════
    // LANE-GROUPS DEFAULT-BLOCK-REGISTRY (nur noch Fallback)
    // ════════════════════════════════════════════════════════════
    // Primär liest der Master-View containerId, assignmentId und defaultBlocks
    // direkt aus den LaneGroups.init(...)-Aufrufen der Boss-Seite (siehe
    // extractLaneGroupConfigs in planner-bosses.js) - dadurch können Boss-Seite
    // und Übersicht gar nicht mehr auseinanderlaufen.
    //
    // Diese Registry greift nur, wenn das Boss-HTML nicht geladen bzw. nicht
    // ausgewertet werden konnte. Sie muss deshalb nicht mehr für jeden Boss
    // gepflegt werden.

    if (!window.LaneGroupsBossDefaults) window.LaneGroupsBossDefaults = {};

    // Immerseus: 8 Gruppen (sharedLanes für 4-Slot-Teams)
    window.LaneGroupsBossDefaults['immerseus'] = {
        assignmentId: 'immerseus-lanes',
        defaultBlocks: [{
            title: 'Gruppen-Einteilung',
            type: 'multi-lane',
            autoFill: true,
            isolatedBlock: true,
            sharedLanes: true,
            lanes: [
                { title: 'Gruppe 1', marker: 'skull',    slots: ['', '', '', ''] },
                { title: 'Gruppe 2', marker: 'cross',    slots: ['', '', '', ''] },
                { title: 'Gruppe 3', marker: 'square',   slots: ['', '', '', ''] },
                { title: 'Gruppe 4', marker: 'triangle', slots: ['', '', '', ''] },
                { title: 'Gruppe 5', marker: 'diamond',  slots: ['', '', '', ''] },
                { title: 'Gruppe 6', marker: 'circle',   slots: ['', '', '', ''] },
                { title: 'Gruppe 7', marker: 'star',     slots: ['', '', '', ''] },
                { title: 'Gruppe 8', marker: 'moon',     slots: ['', '', '', ''] }
            ]
        }]
    };

    // Iron Juggernaut
    window.LaneGroupsBossDefaults['iron-juggernaut'] = {
        assignmentId: 'iron-jug-lanes',
        defaultBlocks: [
            {
                title: 'Ranged Positioning',
                type: 'multi-lane',
                autoFill: true,
                lanes: [
                    { marker: 'star',   slots: ['', '', '', '', ''] },
                    { marker: 'circle', slots: ['', '', '', '', ''] },
                    { marker: 'square', slots: ['', '', '', '', ''] }
                ]
            },
            {
                title: 'Mine Soakers',
                type: 'single-list',
                autoFill: true,
                slots: ['', '', '']
            }
        ]
    };

    // General Nazgrim
    window.LaneGroupsBossDefaults['general-nazgrim'] = {
        assignmentId: 'nazgrim-lane-assignments',
        defaultBlocks: [
            {
                title: 'Schamanen-Interrupts',
                type: 'multi-lane',
                autoFill: true,
                lanes: [{ marker: 'skull', slots: ['', '', ''] }]
            },
            {
                title: 'Arkanweber-Interrupts',
                type: 'multi-lane',
                autoFill: true,
                lanes: [{ marker: 'diamond', slots: ['', '', ''] }]
            }
        ]
    };

    // Fallen Protectors
    window.LaneGroupsBossDefaults['fallen-protectors'] = {
        assignmentId: 'protectors-lane-assignments',
        defaultBlocks: [
            {
                title: 'Interrupts',
                type: 'multi-lane',
                autoFill: true,
                lanes: [
                    { marker: 'square',  slots: ['', '', '', ''] },
                    { marker: 'diamond', slots: ['', '', '', ''] }
                ]
            },
            {
                title: 'Anguish Soak Rotation',
                type: 'multi-lane',
                autoFill: true,
                lanes: [
                    { marker: 'star',   slots: ['', '', ''] },
                    { marker: 'circle', slots: ['', '', ''] },
                    { marker: 'cross',  slots: ['', '', ''] }
                ]
            },
            {
                title: 'Gloom Grips',
                type: 'multi-lane',
                autoFill: true,
                lanes: [{ marker: 'diamond', slots: ['', ''] }]
            },
            {
                title: 'Bane Dispels',
                type: 'single-list',
                autoFill: true,
                slots: ['', '', '', '', '']
            }
        ]
    };

    // ════════════════════════════════════════════════════════════
    // MASTER-VIEW INTEGRATION
    // ════════════════════════════════════════════════════════════
    //
    // Strategie:
    // - Die bestehende loadMasterViewData() rendert pro Boss ein Panel.
    //   Sie wird allerdings als lokale Funktion aus dem Modul-Closure
    //   aufgerufen, nicht über window.loadMasterViewData - daher
    //   funktioniert kein einfacher Wrap.
    //
    // - Lösung: MutationObserver auf #mv-accordion. Wenn neue Boss-Container
    //   reinkommen (egal ob durch Erst-Init oder Refresh-Button), reagieren
    //   wir reaktiv und initialisieren LaneGroups in den Containern.

    let _mvInitInFlight = false;
    let _mvObserverAttached = false;

    function attachMvObserver() {
        if (_mvObserverAttached) return;
        const accordion = document.getElementById('mv-accordion');
        if (!accordion) return;
        _mvObserverAttached = true;

        // Beobachte Änderungen am Accordion und triggere Init wenn neue
        // Boss-Panels reinkommen. Debounce, damit der Init nur EINMAL pro
        // Refresh läuft, auch wenn viele Mutationen gleichzeitig passieren.
        let debounceTimer = null;
        const observer = new MutationObserver(() => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (_mvInitInFlight) return;
                _mvInitInFlight = true;
                initLaneGroupsInMasterView()
                    .catch(e => console.error('[LaneGroups-Integration] MV-Init Fehler:', e))
                    .finally(() => { _mvInitInFlight = false; });
            }, 250);
        });
        observer.observe(accordion, { childList: true, subtree: false });
        console.log('[LaneGroups-Integration] MutationObserver an #mv-accordion angebracht');

        // Initialer Lauf falls schon Inhalte da sind
        if (accordion.children.length > 0) {
            _mvInitInFlight = true;
            initLaneGroupsInMasterView()
                .catch(e => console.error('[LaneGroups-Integration] MV-Init Fehler:', e))
                .finally(() => { _mvInitInFlight = false; });
        }
    }

    // Liefert die LaneGroups-Konfigurationen eines Bosses. Primärquelle sind die
    // aus dem Boss-HTML gelesenen init-Aufrufe (planner-bosses.js legt sie in
    // window.MasterViewLaneGroupConfigs ab) - damit stimmen Container-ID,
    // assignmentId und Default-Layout immer exakt mit der Boss-Seite überein.
    // Fehlt der Eintrag (z.B. weil das HTML nicht geladen werden konnte), greift
    // die statische Registry weiter unten als Fallback.
    function getLaneGroupConfigs(bossId, container) {
        const fromHtml = (window.MasterViewLaneGroupConfigs || {})[bossId];
        if (Array.isArray(fromHtml) && fromHtml.length > 0) {
            return fromHtml
                .filter(cfg => !!findById(container, cfg.containerId))
                .map(cfg => ({
                    containerId: cfg.containerId,
                    assignmentId: cfg.assignmentId,
                    defaultBlocks: cfg.defaultBlocks || []
                }));
        }

        // Fallback: alle "*-lane-groups"-Container im Panel + Registry-Defaults
        const bossDefaults = window.LaneGroupsBossDefaults[bossId] || null;
        return Array.from(container.querySelectorAll('[id$="-lane-groups"]')).map(el => ({
            containerId: el.id,
            assignmentId: bossDefaults ? bossDefaults.assignmentId : el.id.replace('-lane-groups', '-lane-assignments'),
            defaultBlocks: bossDefaults ? (bossDefaults.defaultBlocks || []) : []
        }));
    }

    // IDs im Panel direkt vergleichen statt via querySelector-Selektor - spart
    // das Escaping und funktioniert auch bei ungewöhnlichen Container-IDs.
    function findById(root, id) {
        return Array.from(root.querySelectorAll('[id]')).find(el => el.id === id) || null;
    }

    async function initLaneGroupsInMasterView() {
        const accordion = document.getElementById('mv-accordion');
        if (!accordion) {
            console.warn('[LaneGroups-Integration] #mv-accordion nicht gefunden');
            return;
        }

        const fbTools = window.firebaseTools || null;
        if (!fbTools || !fbTools.db) {
            console.warn('[LaneGroups-Integration] firebaseTools nicht verfügbar');
            return;
        }

        const containers = accordion.querySelectorAll('.mv-boss-content[data-mv-boss-id]');
        if (containers.length === 0) return;

        const bossList = Array.from(containers).map(c => ({
            container: c,
            bossId: c.dataset.mvBossId,
            docId: c.dataset.mvBossDocid
        }));

        const snaps = await Promise.all(bossList.map(b =>
            fbTools.getDoc(fbTools.doc(fbTools.db, 'raid-tool-data', b.docId))
                .catch(err => {
                    console.error('[LaneGroups-Integration] Firestore-Read Fehler für', b.docId, err);
                    return null;
                })
        ));

        bossList.forEach((b, idx) => {
            const snap = snaps[idx];
            if (!snap) return;
            const assignments = snap.exists() ? snap.data() : {};

            getLaneGroupConfigs(b.bossId, b.container).forEach(cfg => {
                const originalContainer = findById(b.container, cfg.containerId);
                if (!originalContainer) return;

                // Eindeutige MV-ID, damit Boss-Seite + MV nicht dieselbe DOM-ID nutzen
                const mvId = 'mv-lg-' + b.bossId + '-' + cfg.containerId;
                originalContainer.id = mvId;
                originalContainer.innerHTML = '';

                try {
                    const inst = window.LaneGroups.init({
                        containerId: mvId,
                        bossId: b.bossId,
                        assignmentId: cfg.assignmentId,
                        roster: window.effectiveRoster || window.rosterData || [],
                        firebaseTools: fbTools,
                        assignments: assignments,
                        defaultBlocks: cfg.defaultBlocks
                    });
                    if (!inst) {
                        console.warn('[LaneGroups-Integration]', b.bossId, '- LaneGroups.init lieferte null für', cfg.assignmentId);
                    }
                } catch (e) {
                    console.error('[LaneGroups-Integration] LaneGroups.init Fehler für', mvId, e);
                }
            });

            // Boss-spezifische Sonder-Einteilungen (Sha-Platten, Norushen-Orbs,
            // Siegecrafter-Lines …) als read-only Panels anhängen
            appendProviderOutputsToMvPanel(b, assignments);
        });
    }

    // Hängt für einen Boss-Container im Master-View die Sonder-Einteilungen an:
    // oben die lesbare Read-only-Ansicht (renderView), darunter aufklappbar der
    // WeakAura-String. Falls schon vorhanden (z.B. nach Refresh), werden sie
    // ersetzt statt dupliziert.
    function appendProviderOutputsToMvPanel(b, assignments) {
        const providers = (window.BossWaProviders || []).filter(p =>
            Array.isArray(p.bossIds) && p.bossIds.includes(b.bossId)
        );
        if (providers.length === 0) return;

        // Vorhandene Provider-Outputs vorher entfernen (bei Refresh)
        b.container.querySelectorAll('.mv-provider-output').forEach(el => el.remove());

        providers.forEach(provider => {
            let output = null;
            let view = null;
            try {
                output = provider.build(assignments, b.bossId);
            } catch (e) {
                console.error('[LaneGroups-Integration] Provider', provider.id, 'Fehler im MV:', e);
            }
            try {
                if (typeof provider.renderView === 'function') {
                    view = provider.renderView(assignments, b.bossId);
                }
            } catch (e) {
                console.error('[LaneGroups-Integration] Provider', provider.id, 'renderView-Fehler im MV:', e);
            }
            // Nichts eingeteilt: Block ganz weglassen
            if (!output && !view) return;

            const wrap = document.createElement('div');
            wrap.className = 'mv-provider-output mt-3 pt-3 border-t border-slate-700';
            const outputId = `mv-prov-${b.bossId}-${provider.id}-output`;
            const copyBtnId = `mv-prov-${b.bossId}-${provider.id}-copy`;
            const waId = `mv-prov-${b.bossId}-${provider.id}-wa`;

            // Lesbare Einteilung zuerst, der WeakAura-String darunter zum
            // Aufklappen - im Master-View interessiert meistens die Einteilung.
            const waHtml = output ? `
                <details id="${waId}" class="mt-2">
                    <summary class="cursor-pointer text-[10px] text-gray-400 hover:text-gray-200">WeakAura-String anzeigen</summary>
                    <div class="flex justify-end mt-1">
                        <button id="${copyBtnId}" class="bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold py-1 px-2 rounded transition-colors">Kopieren</button>
                    </div>
                    <textarea id="${outputId}" readonly rows="${Math.min(Math.max(output.split('\n').length, 2), 8)}"
                              class="w-full mt-1 bg-black ${provider.color || 'text-gray-300'} font-mono text-[10px] p-2 rounded border border-slate-700 resize-y cursor-text">${escapeHtml(output)}</textarea>
                </details>` : '';

            wrap.innerHTML = `
                <div class="text-xs font-bold ${provider.color || 'text-gray-300'} uppercase tracking-wider mb-2">
                    ${escapeHtml(provider.label)}
                </div>
                ${view || ''}
                ${waHtml}
                <p class="text-[9px] text-gray-500 italic mt-1">
                    Read-only. Zum Bearbeiten bitte auf die Boss-Seite wechseln.
                </p>
            `;
            b.container.appendChild(wrap);

            const cb = wrap.querySelector('#' + copyBtnId);
            if (cb) {
                cb.addEventListener('click', () => {
                    const inp = wrap.querySelector('#' + outputId);
                    if (!inp || !inp.value) return;
                    navigator.clipboard.writeText(inp.value).then(() => {
                        const origLabel = cb.textContent;
                        cb.textContent = '✓';
                        cb.classList.add('bg-green-600');
                        setTimeout(() => { cb.textContent = origLabel; cb.classList.remove('bg-green-600'); }, 1500);
                    });
                });
            }
        });
    }

    // ════════════════════════════════════════════════════════════
    // INITIALISIERUNG (mit Polling, weil planner-bosses.js die Funktionen
    // erst nach DOM-Ready definiert)
    // ════════════════════════════════════════════════════════════

    // INITIALISIERUNG: Warte bis #mv-accordion im DOM existiert, dann
    // attach den MutationObserver. Der User navigiert oft erst nach
    // initialem Page-Load zur Comp-Seite - daher pollen wir.
    // ════════════════════════════════════════════════════════════

    function tryAttach() {
        if (_mvObserverAttached) return;
        if (document.getElementById('mv-accordion')) attachMvObserver();
    }

    tryAttach();

    if (!_mvObserverAttached) {
        let attempts = 0;
        const interval = setInterval(() => {
            tryAttach();
            attempts++;
            // Bis zu 60 Sekunden pollen - User kann später hinnavigieren
            if (_mvObserverAttached || attempts > 600) {
                clearInterval(interval);
                if (!_mvObserverAttached) {
                    // console.warn('[LaneGroups-Integration] #mv-accordion nicht gefunden - MV-Integration inaktiv');
                }
            }
        }, 100);
    }
})();