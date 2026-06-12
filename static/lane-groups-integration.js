/**
 * Lane-Groups Integration für Master-View (comp.html).
 *
 * Diese Datei hängt LaneGroups-Container in den Master-View ein, sodass alle
 * Boss-Einteilungen voll editierbar in der Comp-Übersicht erscheinen. Änderungen
 * schreiben direkt in dieselben Firestore-Pfade wie auf der Boss-Seite —
 * Boss-Seite und Master-View sind also synchron.
 *
 * Zusätzlich: read-only Anzeige der boss-spezifischen WeakAura-Strings (Sha,
 * Norushen, Siegecrafter, Paragons …) am Ende jedes Boss-Panels.
 *
 * Hinweis: Der globale WeakAura-Export wird NICHT von dieser Datei gehandhabt
 * — das macht planner-bosses.js nativ (Modul-Ebene buildShaPlatesExport,
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
        console.warn('[LaneGroups-Integration] window.LaneGroups nicht gefunden — Datei wird nicht aktiv.');
        return;
    }

    // ════════════════════════════════════════════════════════════
    // PROVIDER-REGISTRY (für read-only WA-Anzeige im Master-View)
    // ════════════════════════════════════════════════════════════
    // Jeder Provider liest Firestore-Daten eines Bosses und liefert einen
    // fertigen WA-String. Wird im Master-View pro Boss-Panel als read-only
    // Textarea angezeigt. Format:
    //   { id, label, color, bossIds: [...], build(data, bossId) → string|null }

    if (!window.BossWaProviders) window.BossWaProviders = [];

    // Sha-of-Pride Platten
    window.BossWaProviders.push({
        id: 'sha-plates',
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
    // LANE-GROUPS DEFAULT-BLOCK-REGISTRY
    // ════════════════════════════════════════════════════════════
    // Falls für einen Boss noch KEINE LaneGroups-Daten in Firestore stehen
    // (z.B. weil der Manager auf der Boss-Seite noch nichts editiert hat),
    // braucht die Master-View trotzdem ein initiales Layout zum Anzeigen.
    //
    // Diese Defaults müssen mit den `defaultBlocks` aus den Boss-HTMLs
    // synchron sein. Wenn du sie auf der Boss-Seite änderst, ändere sie
    // bitte hier ebenfalls, sonst zeigt Master-View ein veraltetes Layout
    // bis der erste Save passiert.

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
    //   aufgerufen, nicht über window.loadMasterViewData — daher
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
        console.log('[LaneGroups-Integration] Boss-Container gefunden:', containers.length);
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

            const lgContainers = b.container.querySelectorAll('[id$="-lane-groups"]');
            if (lgContainers.length > 0) {
                console.log('[LaneGroups-Integration]', b.bossId, '— LaneGroups-Container:', lgContainers.length);
            }

            lgContainers.forEach(originalContainer => {
                const originalId = originalContainer.id;

                // Eindeutige MV-ID damit Boss-Seite + MV nicht denselben DOM-ID nutzen
                const mvId = `mv-lg-${b.bossId}-${originalId}`;
                originalContainer.id = mvId;
                originalContainer.innerHTML = '';

                // assignmentId aus Firestore extrahieren — Heuristik:
                // Wir suchen den Eintrag im data, der ein blocks-Array hat.
                let assignmentId = null;
                Object.keys(assignments).forEach(key => {
                    const v = assignments[key];
                    if (v && typeof v === 'object' && Array.isArray(v.blocks)) {
                        assignmentId = key;
                    }
                });

                // Wenn keine Daten in Firestore vorliegen: Defaults aus der
                // Registry verwenden (siehe window.LaneGroupsBossDefaults oben).
                // Die assignmentId muss exakt mit dem Boss-HTML-Aufruf matchen,
                // sonst landet das spätere Save unter falschem Pfad.
                const bossDefaults = window.LaneGroupsBossDefaults[b.bossId] || null;
                let defaultBlocks = [];
                if (!assignmentId) {
                    if (bossDefaults) {
                        assignmentId = bossDefaults.assignmentId;
                        defaultBlocks = bossDefaults.defaultBlocks || [];
                    } else {
                        // Letzter Fallback: aus Container-ID ableiten
                        const knownMappings = {
                            'iron-juggernaut-lane-groups': 'iron-jug-lanes'
                        };
                        assignmentId = knownMappings[originalId] || (originalId.replace('-lane-groups', '-lane-assignments'));
                    }
                } else if (bossDefaults && bossDefaults.assignmentId !== assignmentId) {
                    // Mismatch: Firestore hat Daten unter einem anderen Key als
                    // unser Default — sehr selten, aber loggen
                    console.warn('[LaneGroups-Integration]', b.bossId, '— Firestore-assignmentId:', assignmentId, 'aber Default-assignmentId:', bossDefaults.assignmentId);
                }

                console.log('[LaneGroups-Integration]', b.bossId, '— init aufgerufen:', {
                    mvId, assignmentId,
                    hasFirestoreData: !!assignments[assignmentId],
                    firestoreBlocks: assignments[assignmentId] && Array.isArray(assignments[assignmentId].blocks) ? assignments[assignmentId].blocks.length : 0,
                    defaultBlocksCount: defaultBlocks.length,
                    rosterSize: (window.effectiveRoster || window.rosterData || []).length
                });

                try {
                    const inst = window.LaneGroups.init({
                        containerId: mvId,
                        bossId: b.bossId,
                        assignmentId: assignmentId,
                        roster: window.effectiveRoster || window.rosterData || [],
                        firebaseTools: fbTools,
                        assignments: assignments,
                        defaultBlocks: defaultBlocks
                    });
                    if (!inst) {
                        console.warn('[LaneGroups-Integration]', b.bossId, '— LaneGroups.init lieferte null');
                    } else {
                        console.log('[LaneGroups-Integration]', b.bossId, '— Init OK, Blöcke:', inst.blocks.length);
                    }
                } catch (e) {
                    console.error('[LaneGroups-Integration] LaneGroups.init Fehler für', mvId, e);
                }
            });

            // Boss-spezifische WA-Provider als read-only Textarea anhängen
            appendProviderOutputsToMvPanel(b, assignments);
        });
    }

    // Hängt für einen Boss-Container im Master-View die Provider-WA-Outputs
    // als read-only Textareas an. Falls schon vorhanden (z.B. nach Refresh),
    // werden sie ersetzt statt dupliziert.
    function appendProviderOutputsToMvPanel(b, assignments) {
        const providers = (window.BossWaProviders || []).filter(p =>
            Array.isArray(p.bossIds) && p.bossIds.includes(b.bossId)
        );
        if (providers.length === 0) return;

        // Vorhandene Provider-Outputs vorher entfernen (bei Refresh)
        b.container.querySelectorAll('.mv-provider-output').forEach(el => el.remove());

        providers.forEach(provider => {
            let output;
            try {
                output = provider.build(assignments, b.bossId);
            } catch (e) {
                console.error('[LaneGroups-Integration] Provider', provider.id, 'Fehler im MV:', e);
                return;
            }
            if (!output) return;

            const rows = Math.min(Math.max(output.split('\n').length, 2), 8);
            const wrap = document.createElement('div');
            wrap.className = 'mv-provider-output mt-3 pt-3 border-t border-slate-700';
            const outputId = `mv-prov-${b.bossId}-${provider.id}-output`;
            const copyBtnId = `mv-prov-${b.bossId}-${provider.id}-copy`;
            wrap.innerHTML = `
                <div class="flex justify-between items-center mb-2">
                    <span class="text-xs font-bold ${provider.color || 'text-gray-300'} uppercase tracking-wider">
                        ${escapeHtml(provider.label)}
                    </span>
                    <button id="${copyBtnId}" class="bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold py-1 px-2 rounded transition-colors">Kopieren</button>
                </div>
                <textarea id="${outputId}" readonly rows="${rows}"
                          class="w-full bg-black ${provider.color || 'text-gray-300'} font-mono text-[10px] p-2 rounded border border-slate-700 resize-y cursor-text">${escapeHtml(output)}</textarea>
                <p class="text-[9px] text-gray-500 italic mt-1">
                    Read-only WeakAura-String. Zum Editieren bitte auf die Boss-Seite wechseln.
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
    // initialem Page-Load zur Comp-Seite — daher pollen wir.
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
            // Bis zu 60 Sekunden pollen — User kann später hinnavigieren
            if (_mvObserverAttached || attempts > 600) {
                clearInterval(interval);
                if (!_mvObserverAttached) {
                    // console.warn('[LaneGroups-Integration] #mv-accordion nicht gefunden — MV-Integration inaktiv');
                }
            }
        }, 100);
    }
})();