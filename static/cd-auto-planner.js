// ══════════════════════════════════════════════════════════════════════════
// CD AUTO-PLANNER MODULE v3.0
// ──────────────────────────────────────────────────────────────────────────
// Einbinden per: <script src="static/cd-auto-planner.js"></script>
// Dann in der Boss-HTML nur noch:
//   CD_AUTO_PLANNER.init({ id, name, prefix, events, triggerMap });
//
// Liest cooldownSec UND durationSec aus der Firestore cooldowns-Collection.
// Falls nicht vorhanden, Fallback auf Kategorie-Definition.
//
// EXPORT-FORMAT:
//   Trigger:   z.B. JINROKH_LIGHTNING_STORM  (Event-Typ)
//   Condition: #1, #2, #3...                 (wievielter Cast)
//   Zeit:      Relative Verzögerung in Sek   (0 = genau beim Event,
//              -5 = 5s vorher, +10 = 10s nachher)
//   Spieler:   Spielername aus Roster
//   Cooldown:  Exakter DB-Name (z.B. "Aura der Hingabe")
// ══════════════════════════════════════════════════════════════════════════

window.CD_AUTO_PLANNER = (function() {
    'use strict';

    // ══════════════════════════════════════════════════════════════
    // DEFAULT CD-KATEGORIEN (spellId-basiert, wird gegen DB aufgelöst)
    //
    // cooldownSec = Fallback wenn DB kein cooldownSec hat
    // durationSec = Fallback wenn DB kein durationSec hat
    // Prioritaet = Reihenfolge im Array (Index 0 = hoechste)
    // ══════════════════════════════════════════════════════════════

    const DEFAULT_CATEGORIES = {
        magical_dr: {
            name: "Magische Schadensred.", shortName: "Magic DR", color: "#8b5cf6",
            spells: [
                { spellId: "31821",  cooldownSec: 180, durationSec: 6  },                           // Aura der Hingabe (Paladin - jede Spec)
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredRole: "heal" },     // Machtwort: Barriere (Disc-Priest)
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredRole: "heal" },     // Geistverbindungstotem (Resto-Schamane)
            ]
        },
        physical_dr: {
            name: "Physische Schadensred.", shortName: "Phys DR", color: "#d97706",
            spells: [
                { spellId: "31821",  cooldownSec: 180, durationSec: 6  },
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredRole: "heal" },
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredRole: "heal" },
            ]
        },
        major_heal: {
            name: "Grosse Heilung", shortName: "Major Heal", color: "#10b981",
            requiredRole: "heal",  // Gesamte Kategorie nur für Heal-Spieler
            spells: [
                { spellId: "108280", cooldownSec: 180, durationSec: 10 },  // Heilende Gezeiten (Resto-Schamane)
                { spellId: "740",    cooldownSec: 480, durationSec: 8  },  // Gelassenheit (Resto-Druide)
                { spellId: "64843",  cooldownSec: 180, durationSec: 8  },  // Gotteshymne (Heilig-Priester)
                { spellId: "115310", cooldownSec: 180, durationSec: 0  },  // Beleben (Mistweaver-Mönch)
                { spellId: "15286",  cooldownSec: 180, durationSec: 15 },  // Vampirische Umarmung (Schatten-Priester)
            ]
        },
        minor_heal: {
            name: "Kleine Heilung", shortName: "Minor Heal", color: "#34d399",
            requiredRole: "heal",
            spells: [
                { spellId: "108280", cooldownSec: 180, durationSec: 10 },
                { spellId: "108281", cooldownSec: 120, durationSec: 10 },  // Führung der Ahnen (Ele/Enh/Resto)
                { spellId: "120517", cooldownSec: 25,  durationSec: 1  },  // Strahlenkranz (Priester)
            ]
        },
        additional_surv: {
            name: "Zusaetzliches Ueberleben", shortName: "Add. Surv", color: "#f59e0b",
            spells: [
                { spellId: "97462",  cooldownSec: 180, durationSec: 10 },                            // Schlachtruf (Warrior - jede Spec)
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },                            // Demo Banner (Warrior)
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredRole: "heal" },      // SLT (Resto)
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredRole: "heal" },      // PW:Barrier (Disc)
                { spellId: "76577",  cooldownSec: 180, durationSec: 5  },                            // Rauchbombe (Rogue)
                { spellId: "51052",  cooldownSec: 120, durationSec: 10 },                            // AMZ (DK)
            ]
        },
        any_dr: {
            name: "Beliebige Schadensred.", shortName: "Any DR", color: "#a78bfa",
            spells: [
                { spellId: "31821",  cooldownSec: 180, durationSec: 6  },
                { spellId: "97462",  cooldownSec: 180, durationSec: 10 },
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredRole: "heal" },
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredRole: "heal" },
                { spellId: "76577",  cooldownSec: 180, durationSec: 5  },
                { spellId: "51052",  cooldownSec: 120, durationSec: 10 },
                { spellId: "122278", cooldownSec: 120, durationSec: 6,  requiredRole: "tank" },      // Schaden abwenden (BM-Mönch)
            ]
        },
        movement: {
            name: "Bewegungsgeschw.", shortName: "Speed", color: "#22d3ee",
            spells: [
                { spellId: "77764",  cooldownSec: 120, durationSec: 8  },  // Anstrachelndes Gebrüll (Druide - jede Spec)
            ]
        },
        bloodlust: {
            name: "Kampfrausch", shortName: "Lust", color: "#ef4444",
            spells: [
                { spellId: "80353",  cooldownSec: 300, durationSec: 40 },
                { spellId: "2825",   cooldownSec: 300, durationSec: 40 },
                { spellId: "90355",  cooldownSec: 300, durationSec: 40 },
            ]
        },
        aoe_stun: {
            name: "AoE Stun", shortName: "AoE Stun", color: "#f97316",
            spells: [
                { spellId: "119381", cooldownSec: 45,  durationSec: 5  },
                { spellId: "30283",  cooldownSec: 30,  durationSec: 3  },
                { spellId: "118905", cooldownSec: 45,  durationSec: 5  },
                { spellId: "46968",  cooldownSec: 40,  durationSec: 4  },
            ]
        },
        hop: {
            name: "Hand des Schutzes", shortName: "HoP", color: "#f9a8d4",
            spells: [
                { spellId: "1022", cooldownSec: 300, durationSec: 10 },
            ]
        },
        hos: {
            name: "Hand der Aufopferung", shortName: "HoSac", color: "#fb7185",
            spells: [
                { spellId: "6940", cooldownSec: 120, durationSec: 12 },
            ]
        }
    };

    // ── State ──
    var config = null;
    var categories = {};
    var assignments = [];
    var manualOverrides = {};
    var rosterRef = [];
    var firebaseRef = null;
    var cooldownsDB = [];

    // ── Helpers ──
    function fmt(sec) {
        var m = Math.floor(Math.abs(sec) / 60);
        var s = Math.floor(Math.abs(sec) % 60);
        return (sec < 0 ? '-' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    function getClassColor(cls) {
        return (window.classColors && window.classColors[(cls || '').toUpperCase()]) || '#FFFFFF';
    }

    function getPlayersOfClass(cls, requiredRole) {
        return rosterRef.filter(function(p) {
            if ((p.class || '').toUpperCase() !== (cls || '').toUpperCase()) return false;
            if (!requiredRole) return true;  // Kein Role-Filter
            // Role aus Roster (roles ist Array, erste Rolle zählt)
            var roles = p.roles || [];
            var firstRole = (Array.isArray(roles) ? (roles[0] || '') : roles).toString().toLowerCase();
            if (requiredRole === 'heal') return firstRole.indexOf('heal') !== -1;
            if (requiredRole === 'tank') return firstRole.indexOf('tank') !== -1;
            if (requiredRole === 'dps')  {
                // DPS = alles was nicht Tank/Heal/Bench ist
                return firstRole.indexOf('heal') === -1 &&
                       firstRole.indexOf('tank') === -1 &&
                       firstRole.indexOf('bench') === -1 &&
                       firstRole.indexOf('absence') === -1;
            }
            return true;
        }).map(function(p) { return p.name; });
    }

    // ── SpellID → DB-Eintrag ──
    function resolveSpell(spellId) {
        var sid = String(spellId);
        for (var i = 0; i < cooldownsDB.length; i++) {
            var cd = cooldownsDB[i];
            if (String(cd.spellId) === sid && cd.name &&
                cd.name.indexOf('---') !== 0 && cd.name.indexOf('-- ') !== 0) {
                return cd;
            }
        }
        return null;
    }

    // ── Kategorie-Spells mit DB anreichern ──
    function resolveCategory(catKey) {
        var cat = categories[catKey];
        if (!cat) return [];
        var result = [];
        cat.spells.forEach(function(entry) {
            var db = resolveSpell(entry.spellId);
            if (!db) return;
            result.push({
                dbName:      db.name,
                dbClass:     db.class,
                spellId:     entry.spellId,
                cooldownSec: parseInt(db.cooldownSec) || entry.cooldownSec || 180,
                durationSec: parseInt(db.durationSec) || entry.durationSec || 0,
                // Role-Filter: Spell-spezifisch hat Vorrang, sonst Kategorie-weit
                requiredRole: entry.requiredRole || cat.requiredRole || null,
                found:       true
            });
        });
        return result;
    }

    // ── Timeline generieren ──
    function generateTimeline() {
        var timeline = [];
        config.events.forEach(function(event, eventIdx) {
            var casts = event.maxCasts || 1;
            for (var c = 0; c < casts; c++) {
                var absTime = event.firstCast + (c * (event.cooldown || 0));
                if (event.cooldown === 0 && c > 0) break;
                timeline.push({
                    eventIdx:      eventIdx,
                    castNum:       c + 1,
                    absTime:       absTime,
                    delay:         event.delay || 0,
                    eventName:     event.name,
                    eventDuration: event.eventDuration || 0,
                    icon:          event.icon || '',
                    requiredCDs:   event.requiredCDs,
                    slots:         {}
                });
            }
        });
        timeline.sort(function(a, b) { return a.absTime - b.absTime; });
        return timeline;
    }

    function getUniqueCategoryKeys() {
        var keys = [];
        config.events.forEach(function(e) {
            (e.requiredCDs || []).forEach(function(k) {
                if (keys.indexOf(k) === -1) keys.push(k);
            });
        });
        return keys;
    }

    // ══════════════════════════════════════════════════════════════
    // AUTO-ASSIGN
    // ══════════════════════════════════════════════════════════════

    function autoAssign(timeline) {
        var usedUntil = {};

        function isAvailable(player, dbName, cdSec, atTime) {
            var key = player + '::' + dbName;
            return !usedUntil[key] || atTime >= usedUntil[key];
        }
        function markUsed(player, dbName, cdSec, atTime) {
            usedUntil[player + '::' + dbName] = atTime + cdSec;
        }

        var allCatKeys = getUniqueCategoryKeys();

        timeline.forEach(function(row) {
            allCatKeys.forEach(function(catKey) {
                var isRequired = row.requiredCDs.indexOf(catKey) !== -1;
                var oKey = row.eventIdx + '-' + row.castNum + '-' + catKey;
                var hasOverride = !!manualOverrides[oKey];

                if (!isRequired && !hasOverride) return;

                if (hasOverride) {
                    var ov = manualOverrides[oKey];
                    if (ov.skip) {
                        row.slots[catKey] = { player: null, dbName: null, auto: false, skipped: true };
                        return;
                    }
                    row.slots[catKey] = JSON.parse(JSON.stringify(ov));
                    row.slots[catKey].auto = false;
                    if (ov.player && ov.dbName) {
                        markUsed(ov.player, ov.dbName, ov.cooldownSec || 180, row.absTime);
                    }
                    return;
                }

                if (!isRequired) return;

                var spells = resolveCategory(catKey);
                var assigned = false;
                for (var si = 0; si < spells.length && !assigned; si++) {
                    var spell = spells[si];
                    var players = getPlayersOfClass(spell.dbClass, spell.requiredRole);
                    for (var pi = 0; pi < players.length && !assigned; pi++) {
                        if (isAvailable(players[pi], spell.dbName, spell.cooldownSec, row.absTime)) {
                            row.slots[catKey] = {
                                player: players[pi], dbName: spell.dbName,
                                dbClass: spell.dbClass, spellId: spell.spellId,
                                cooldownSec: spell.cooldownSec,
                                durationSec: spell.durationSec,
                                auto: true
                            };
                            markUsed(players[pi], spell.dbName, spell.cooldownSec, row.absTime);
                            assigned = true;
                        }
                    }
                }
                if (!assigned) {
                    row.slots[catKey] = { player: null, dbName: null, auto: true, unavailable: true };
                }
            });
        });

        return timeline;
    }

    // ══════════════════════════════════════════════════════════════
    // UI RENDERING
    // ══════════════════════════════════════════════════════════════

    function renderTimeline(timeline) {
        var thead = document.getElementById('auto-planner-thead');
        var tbody = document.getElementById('auto-planner-tbody');
        if (!thead || !tbody) return;
        var catKeys = getUniqueCategoryKeys();

        // Thead
        var thCols = catKeys.map(function(k) {
            var cat = categories[k];
            var c = cat ? cat.color : '#888';
            var n = cat ? cat.shortName : k;
            return '<th class="py-2 px-2 min-w-[170px]" style="border-bottom:2px solid ' + c + ';"><span style="color:' + c + ';">' + n + '</span></th>';
        }).join('');

        thead.innerHTML = '<tr class="text-left text-gray-400 uppercase tracking-wider border-b border-slate-700 text-[10px]">'
            + '<th class="py-2 px-1 w-8"></th>'
            + '<th class="py-2 px-2 w-16">ETA</th>'
            + '<th class="py-2 px-2 min-w-[130px]">Event</th>'
            + '<th class="py-2 px-1 w-8 text-center">#</th>'
            + '<th class="py-2 px-1 w-14 text-center" title="Verzögerung zum Trigger (für Export)">Delay</th>'
            + thCols + '</tr>';

        // Tbody
        var lastEvt = '';
        var rows = timeline.map(function(row, rowIdx) {
            var isNew = row.eventName !== lastEvt;
            lastEvt = row.eventName;

            var cells = catKeys.map(function(catKey) {
                var slot = row.slots[catKey];
                var isReq = row.requiredCDs.indexOf(catKey) !== -1;
                var options = buildDropdownOptions(catKey);

                // Skipped
                if (slot && slot.skipped) {
                    return '<td class="py-1 px-1 bg-slate-900/40 border border-red-900/20">'
                        + '<select class="auto-plan-select w-full bg-transparent text-[11px] border-none outline-none cursor-pointer" data-row="' + rowIdx + '" data-cat="' + catKey + '" style="color:#ef4444;">'
                        + '<option value="">-- leer --</option>'
                        + '<option value="__SKIP__" selected style="color:#ef4444;">✖ Kein CD nötig</option>'
                        + options + '</select></td>';
                }

                // Nicht required, kein Override
                if (!isReq && (!slot || !slot.player)) {
                    return '<td class="py-1 px-1 bg-slate-900/30 border border-slate-800/40">'
                        + '<select class="auto-plan-select w-full bg-transparent text-[11px] border-none outline-none cursor-pointer" data-row="' + rowIdx + '" data-cat="' + catKey + '" style="color:#4b5563;">'
                        + '<option value="" selected>—</option>' + options + '</select></td>';
                }

                // Unavailable
                if (!slot || slot.unavailable) {
                    return '<td class="py-1 px-1 bg-red-900/15 border border-red-900/25">'
                        + '<select class="auto-plan-select w-full bg-transparent text-[11px] border-none outline-none cursor-pointer" data-row="' + rowIdx + '" data-cat="' + catKey + '" style="color:#f87171;">'
                        + '<option value="" selected>⚠ kein CD</option>'
                        + '<option value="__SKIP__" style="color:#ef4444;">✖ Kein CD nötig</option>'
                        + options + '</select></td>';
                }

                // Zugewiesen
                var color = getClassColor(slot.dbClass);
                var bg = slot.auto ? 'bg-slate-800/50' : 'bg-yellow-900/20';
                var brd = slot.auto ? 'border-slate-700/60' : 'border-yellow-500/40';
                var title = 'Dauer: ' + (slot.durationSec || '?') + 's | CD: ' + (slot.cooldownSec || '?') + 's';

                return '<td class="py-1 px-1 ' + bg + ' border ' + brd + '" title="' + title + '">'
                    + '<select class="auto-plan-select w-full bg-transparent text-[11px] border-none outline-none cursor-pointer" data-row="' + rowIdx + '" data-cat="' + catKey + '" style="color:' + color + ';">'
                    + '<option value="">-- leer --</option>'
                    + '<option value="__SKIP__" style="color:#ef4444;">✖ Kein CD nötig</option>'
                    + options + '</select></td>';
            }).join('');

            var durLabel = row.eventDuration ? ' <span class="text-gray-600 text-[9px]">(' + row.eventDuration + 's)</span>' : '';

            return '<tr class="hover:bg-slate-800/30 transition-colors ' + (isNew ? 'border-t border-slate-600' : 'border-t border-slate-800/40') + '">'
                + '<td class="py-1 px-1 text-center text-sm">' + row.icon + '</td>'
                + '<td class="py-1 px-2 font-mono text-gray-300" title="Absolute Kampfzeit">' + fmt(row.absTime) + '</td>'
                + '<td class="py-1 px-2 ' + (isNew ? 'text-gray-200 font-medium' : 'text-gray-500') + '">' + (isNew ? row.eventName : '↳') + durLabel + '</td>'
                + '<td class="py-1 px-1 text-center text-gray-500">' + row.castNum + '</td>'
                + '<td class="py-1 px-1 text-center"><input type="number" class="auto-plan-delay w-14 bg-transparent text-[11px] text-center text-gray-400 border border-slate-700 rounded" data-row="' + rowIdx + '" value="' + (row.delay || 0) + '" title="Verzögerung (neg=vorher)"></td>'
                + cells + '</tr>';
        }).join('');

        tbody.innerHTML = rows;

        // Set dropdown values
        timeline.forEach(function(row, rowIdx) {
            catKeys.forEach(function(catKey) {
                var slot = row.slots[catKey];
                if (!slot || !slot.player || !slot.dbName) return;
                var sel = tbody.querySelector('select[data-row="' + rowIdx + '"][data-cat="' + catKey + '"]');
                if (!sel) return;
                var val = slot.player + '::' + slot.dbName;
                if (!Array.from(sel.options).some(function(o) { return o.value === val; })) {
                    var opt = new Option(slot.player + ' → ' + slot.dbName, val);
                    opt.style.color = getClassColor(slot.dbClass);
                    sel.appendChild(opt);
                }
                sel.value = val;
                sel.style.color = getClassColor(slot.dbClass);
            });
        });

        // Listeners: Dropdown
        tbody.querySelectorAll('.auto-plan-select').forEach(function(sel) {
            sel.addEventListener('change', function(e) {
                var ri = parseInt(e.target.dataset.row);
                var ck = e.target.dataset.cat;
                var row = assignments[ri];
                if (!row) return;
                var oKey = row.eventIdx + '-' + row.castNum + '-' + ck;

                if (!e.target.value) {
                    delete manualOverrides[oKey];
                } else if (e.target.value === '__SKIP__') {
                    manualOverrides[oKey] = { player: '__SKIP__', dbName: '__SKIP__', skip: true };
                } else {
                    var parts = e.target.value.split('::');
                    var player = parts[0], dbName = parts[1];
                    var dbEntry = cooldownsDB.find(function(cd) { return cd.name === dbName; });
                    var catSpell = resolveCategory(ck).find(function(s) { return s.dbName === dbName; });
                    manualOverrides[oKey] = {
                        player: player, dbName: dbName,
                        dbClass: dbEntry ? dbEntry.class : 'UNKNOWN',
                        spellId: dbEntry ? dbEntry.spellId : '',
                        cooldownSec: (catSpell && catSpell.cooldownSec) || parseInt(dbEntry && dbEntry.cooldownSec) || 180,
                        durationSec: (catSpell && catSpell.durationSec) || parseInt(dbEntry && dbEntry.durationSec) || 0
                    };
                }
                runAutoAssign();
            });
        });

        // Listeners: Delay
        tbody.querySelectorAll('.auto-plan-delay').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                var ri = parseInt(e.target.dataset.row);
                if (assignments[ri]) assignments[ri].delay = parseInt(e.target.value) || 0;
            });
        });

        var missing = timeline.filter(function(r) {
            return Object.values(r.slots).some(function(s) { return s.unavailable; });
        }).length;
        updateStatus(timeline.length + ' Events, ' + missing + ' ohne CD');
    }

    // ── Dropdown: Empfohlen + Alle CDs ──
    function buildDropdownOptions(catKey) {
        var recommended = resolveCategory(catKey);
        var html = '';

        if (recommended.length > 0) {
            html += '<option disabled style="font-weight:bold; color:#fbbf24; background:#1a202c;">═══ EMPFOHLEN ═══</option>';
            var byClassR = {};
            recommended.forEach(function(s) {
                if (!byClassR[s.dbClass]) byClassR[s.dbClass] = [];
                if (!byClassR[s.dbClass].some(function(x) { return x.dbName === s.dbName; })) byClassR[s.dbClass].push(s);
            });
            Object.entries(byClassR).forEach(function(entry) {
                var cls = entry[0], spells = entry[1];
                var color = getClassColor(cls);
                // Role pro Spell kann unterschiedlich sein → pro Spell filtern
                var anyRendered = false;
                spells.forEach(function(s) {
                    var players = getPlayersOfClass(cls, s.requiredRole);
                    if (!players.length) return;
                    if (!anyRendered) {
                        html += '<option disabled style="font-weight:bold; color:' + color + '; background:#1a202c;">── ' + cls + ' ──</option>';
                        anyRendered = true;
                    }
                    var dur = s.durationSec ? ' [' + s.durationSec + 's]' : '';
                    var roleMark = s.requiredRole ? ' (' + s.requiredRole + ')' : '';
                    players.forEach(function(p) {
                        html += '<option value="' + p + '::' + s.dbName + '" style="color:' + color + ';">★ ' + p + ' → ' + s.dbName + dur + roleMark + '</option>';
                    });
                });
            });
        }

        var recIds = {};
        recommended.forEach(function(s) { recIds[String(s.spellId)] = true; });
        var allCDs = cooldownsDB.filter(function(cd) {
            return cd.name && cd.spellId && cd.name.indexOf('---') !== 0 && cd.name.indexOf('-- ') !== 0 && cd.type !== 'Personal' && !recIds[String(cd.spellId)];
        });
        var byClassA = {};
        allCDs.forEach(function(cd) {
            var cls = (cd.class || 'UNKNOWN').toUpperCase();
            if (!byClassA[cls]) byClassA[cls] = [];
            if (!byClassA[cls].some(function(x) { return x.name === cd.name; })) byClassA[cls].push(cd);
        });

        if (Object.keys(byClassA).length > 0) {
            html += '<option disabled style="font-weight:bold; color:#64748b; background:#1a202c;">═══ ALLE CDs ═══</option>';
            Object.entries(byClassA).forEach(function(entry) {
                var cls = entry[0], cds = entry[1];
                var players = getPlayersOfClass(cls);
                if (!players.length) return;
                var color = getClassColor(cls);
                html += '<option disabled style="font-weight:bold; color:' + color + '; background:#1a202c; opacity:0.7;">── ' + cls + ' ──</option>';
                players.forEach(function(p) {
                    cds.forEach(function(cd) {
                        html += '<option value="' + p + '::' + cd.name + '" style="color:' + color + '; opacity:0.8;">' + p + ' → ' + cd.name + '</option>';
                    });
                });
            });
        }
        return html;
    }

    function runAutoAssign() {
        var timeline = generateTimeline();
        assignments = autoAssign(timeline);
        renderTimeline(assignments);
    }

    function updateStatus(msg) {
        var el = document.getElementById('auto-planner-status');
        if (el) el.textContent = config.name + ' — ' + msg;
    }

    // ══════════════════════════════════════════════════════════════
    // EXPORT → CD-PLANER
    // Trigger = Event-Typ | Condition = # | Zeit = Delay | CD = DB-Name
    // ══════════════════════════════════════════════════════════════

    function exportToPlanner() {
        if (!assignments.length) return window.showModal && window.showModal("Erst Auto-Assign ausführen!");
        var container = document.querySelector('[id$="-planner-container"]');
        if (!container) return window.showModal && window.showModal("CD-Planer nicht gefunden.");

        var prefix = container.id.replace('-planner-container', '');
        var rowNum = 1, exported = 0, skipped = 0;
        var catKeys = getUniqueCategoryKeys();

        assignments.forEach(function(row) {
            catKeys.forEach(function(catKey) {
                var slot = row.slots[catKey];
                if (!slot || slot.skipped || !slot.player || !slot.dbName || slot.player === '__SKIP__') return;
                if (rowNum > 100) return;

                var triggerVal = (config.triggerMap && config.triggerMap[row.eventName]) || '';
                setPlannerSelect(prefix + '-planner-row' + rowNum + '-trigger', triggerVal);
                setPlannerInput(prefix + '-planner-row' + rowNum + '-condition', String(row.castNum));
                setPlannerInput(prefix + '-planner-row' + rowNum + '-time', String(row.delay || 0));
                setPlannerSelect(prefix + '-planner-row' + rowNum + '-player', slot.player);

                var ok = setPlannerSelect(prefix + '-planner-row' + rowNum + '-cooldown', slot.dbName);
                if (ok) exported++; else {
                    skipped++;
                    console.warn('[Auto-Planner] CD nicht gefunden: "' + slot.dbName + '" (' + slot.spellId + ')');
                }
                rowNum++;
            });
        });

        container.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.updatePlannerSummary) setTimeout(window.updatePlannerSummary, 200);
        var msg = exported + ' Zeilen exportiert!';
        if (skipped > 0) msg += '\n⚠ ' + skipped + ' CDs nicht im Dropdown.';
        if (window.showModal) window.showModal(msg);
    }

    function setPlannerSelect(id, value) {
        var el = document.querySelector('[data-assignment-id="' + id + '"]');
        if (!el) return false;
        var exists = Array.from(el.options).some(function(o) { return o.value === value; });
        el.value = value;
        var opt = el.options[el.selectedIndex];
        if (opt) el.style.color = (opt.dataset && opt.dataset.color) || '#FFFFFF';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return exists;
    }

    function setPlannerInput(id, value) {
        var el = document.querySelector('[data-assignment-id="' + id + '"]');
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ══════════════════════════════════════════════════════════════
    // FIRESTORE
    // ══════════════════════════════════════════════════════════════

    async function savePlan() {
        if (!firebaseRef || !assignments.length) return;
        try {
            await firebaseRef.setDoc(
                firebaseRef.doc(firebaseRef.db, "auto-planner", config.id),
                {
                    bossId: config.id, bossName: config.name,
                    timestamp: new Date().toISOString(),
                    editor: sessionStorage.getItem('currentManager') || 'Unbekannt',
                    manualOverrides: manualOverrides,
                    assignments: assignments.map(function(r) {
                        var slots = {};
                        Object.entries(r.slots).forEach(function(e) {
                            if (e[1].player && e[1].player !== '__SKIP__') {
                                slots[e[0]] = { player: e[1].player, dbName: e[1].dbName, auto: e[1].auto };
                            }
                        });
                        return { eventName: r.eventName, castNum: r.castNum, absTime: r.absTime, delay: r.delay || 0, slots: slots };
                    })
                }, { merge: false }
            );
            if (window.showModal) window.showModal("Auto-Plan gespeichert!");
        } catch (e) { if (window.showModal) window.showModal("Fehler: " + e.message); }
    }

    async function loadPlan() {
        if (!firebaseRef) return false;
        try {
            var snap = await firebaseRef.getDoc(firebaseRef.doc(firebaseRef.db, "auto-planner", config.id));
            if (snap.exists()) { manualOverrides = snap.data().manualOverrides || {}; return true; }
        } catch (e) { console.error("[Auto-Planner]", e); }
        return false;
    }

    async function saveCategories() {
        if (!firebaseRef) return;
        try {
            await firebaseRef.setDoc(firebaseRef.doc(firebaseRef.db, "auto-planner", "_cd-categories"), { categories: categories }, { merge: false });
            if (window.showModal) window.showModal("Kategorien gespeichert!");
        } catch (e) { console.error("[Auto-Planner]", e); }
    }

    async function loadCategories() {
        if (!firebaseRef) return;
        try {
            var snap = await firebaseRef.getDoc(firebaseRef.doc(firebaseRef.db, "auto-planner", "_cd-categories"));
            if (snap.exists() && snap.data().categories) { categories = snap.data().categories; return; }
        } catch (e) { console.error("[Auto-Planner]", e); }
        categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    }

    function renderCategoriesAdmin() {
        var el = document.getElementById('cd-categories-container');
        if (!el) return;

        var addCatBtn = '<div class="mb-3"><button id="btn-add-category" class="bg-emerald-700 hover:bg-emerald-800 text-white text-xs py-1.5 px-3 rounded border border-emerald-500">+ Neue Kategorie</button></div>';

        var catsHtml = Object.entries(categories).map(function(entry) {
            var key = entry[0], cat = entry[1];
            var resolved = resolveCategory(key);
            var rows = cat.spells.map(function(sp, idx) {
                var r = resolved.find(function(x) { return String(x.spellId) === String(sp.spellId); });
                var found = !!r;
                var name = r ? r.dbName : 'SpellID ' + sp.spellId;
                var cls = r ? r.dbClass : '?';
                var color = found ? getClassColor(cls) : '#ef4444';
                var cdS = r ? r.cooldownSec : sp.cooldownSec;
                var durS = r ? r.durationSec : (sp.durationSec || 0);
                var role = sp.requiredRole || '';
                var roleOptions = ['', 'heal', 'tank', 'dps'].map(function(r) {
                    return '<option value="' + r + '"' + (role === r ? ' selected' : '') + '>' + (r || 'alle') + '</option>';
                }).join('');

                return '<div class="spell-row flex items-center gap-2 text-[11px] bg-slate-800/50 p-1.5 rounded" draggable="true" data-cat="' + key + '" data-idx="' + idx + '">'
                    + '<span class="drag-handle cursor-move text-gray-600 px-1" title="Ziehen zum Sortieren">⋮⋮</span>'
                    + '<span class="text-gray-500 w-4 text-right">' + (idx + 1) + '.</span>'
                    + '<span style="color:' + color + ';" class="font-medium flex-1">' + (found ? '' : '❌ ') + name + '</span>'
                    + '<span class="text-gray-500 w-20">' + cls + '</span>'
                    + '<select class="spell-role-select bg-slate-900 text-gray-400 text-[10px] px-1 py-0.5 rounded border border-slate-600" data-cat="' + key + '" data-idx="' + idx + '" title="Nur für diese Rolle">' + roleOptions + '</select>'
                    + '<span class="text-gray-600 font-mono" title="Wirkdauer">' + durS + 's</span>'
                    + '<span class="text-gray-600 font-mono" title="Cooldown">' + cdS + 's CD</span>'
                    + '<span class="text-gray-700 font-mono text-[9px] w-12">' + sp.spellId + '</span>'
                    + '<button class="remove-spell-btn text-red-400 hover:text-red-300 px-1" data-cat="' + key + '" data-idx="' + idx + '" title="Spell entfernen">✕</button>'
                    + '</div>';
            }).join('');

            var catRoleOptions = ['', 'heal', 'tank', 'dps'].map(function(r) {
                return '<option value="' + r + '"' + ((cat.requiredRole || '') === r ? ' selected' : '') + '>' + (r || 'alle') + '</option>';
            }).join('');

            return '<div class="bg-slate-750 p-3 rounded border border-slate-600 mb-2" data-cat-key="' + key + '">'
                + '<div class="flex items-center gap-2 mb-2">'
                +   '<input type="color" class="cat-color-input w-6 h-6 bg-transparent border-0 cursor-pointer" data-cat="' + key + '" value="' + cat.color + '" title="Farbe">'
                +   '<input type="text" class="cat-name-input text-sm font-bold bg-slate-900 text-white px-2 py-1 rounded border border-slate-600 flex-1" data-cat="' + key + '" value="' + cat.name + '" placeholder="Anzeigename">'
                +   '<input type="text" class="cat-short-input text-xs bg-slate-900 text-gray-300 px-2 py-1 rounded border border-slate-600 w-24" data-cat="' + key + '" value="' + (cat.shortName || '') + '" placeholder="Kurzname">'
                +   '<select class="cat-role-select bg-slate-900 text-gray-400 text-[10px] px-1 py-1 rounded border border-slate-600" data-cat="' + key + '" title="Rolle für gesamte Kategorie">' + catRoleOptions + '</select>'
                +   '<span class="text-[10px] text-gray-500 font-mono">' + key + '</span>'
                +   '<button class="delete-cat-btn text-red-400 hover:text-red-300 text-lg px-1" data-cat="' + key + '" title="Kategorie löschen">🗑</button>'
                + '</div>'
                + '<div class="spells-container space-y-1" data-cat-spells="' + key + '">' + rows + '</div>'
                + '<button class="add-spell-btn mt-2 bg-slate-700 hover:bg-slate-600 text-gray-300 text-[11px] py-1 px-2 rounded border border-slate-600" data-cat="' + key + '">+ Spell aus DB hinzufügen</button>'
                + '</div>';
        }).join('');

        el.innerHTML = addCatBtn + catsHtml;

        // Event Listeners
        attachEditorListeners();
    }

    function attachEditorListeners() {
        // Add category
        var addBtn = document.getElementById('btn-add-category');
        if (addBtn) {
            addBtn.addEventListener('click', function() {
                var key = prompt('Eindeutiger Key für neue Kategorie (z.B. "dispel_magic"):');
                if (!key) return;
                if (categories[key]) { alert('Key existiert bereits!'); return; }
                var name = prompt('Anzeigename:', key);
                if (!name) return;
                categories[key] = {
                    name: name, shortName: name.substring(0, 10), color: '#8b5cf6',
                    spells: []
                };
                renderCategoriesAdmin();
            });
        }

        // Delete category
        document.querySelectorAll('.delete-cat-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                var cat = e.target.dataset.cat;
                if (!confirm('Kategorie "' + categories[cat].name + '" wirklich löschen?')) return;
                delete categories[cat];
                renderCategoriesAdmin();
            });
        });

        // Name/Shortname/Color änderungen
        document.querySelectorAll('.cat-name-input').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                categories[e.target.dataset.cat].name = e.target.value;
            });
        });
        document.querySelectorAll('.cat-short-input').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                categories[e.target.dataset.cat].shortName = e.target.value;
            });
        });
        document.querySelectorAll('.cat-color-input').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                categories[e.target.dataset.cat].color = e.target.value;
            });
        });

        // Kategorie-Role
        document.querySelectorAll('.cat-role-select').forEach(function(sel) {
            sel.addEventListener('change', function(e) {
                var v = e.target.value;
                if (v) categories[e.target.dataset.cat].requiredRole = v;
                else delete categories[e.target.dataset.cat].requiredRole;
            });
        });

        // Spell-Role
        document.querySelectorAll('.spell-role-select').forEach(function(sel) {
            sel.addEventListener('change', function(e) {
                var cat = e.target.dataset.cat;
                var idx = parseInt(e.target.dataset.idx);
                var v = e.target.value;
                if (v) categories[cat].spells[idx].requiredRole = v;
                else delete categories[cat].spells[idx].requiredRole;
            });
        });

        // Spell entfernen
        document.querySelectorAll('.remove-spell-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                var cat = e.target.dataset.cat;
                var idx = parseInt(e.target.dataset.idx);
                categories[cat].spells.splice(idx, 1);
                renderCategoriesAdmin();
            });
        });

        // Spell hinzufügen
        document.querySelectorAll('.add-spell-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                var cat = e.target.dataset.cat;
                openSpellPicker(cat);
            });
        });

        // Drag & Drop für Spells
        attachDragDrop();
    }

    // ── Drag & Drop Sortierung ──
    function attachDragDrop() {
        var dragged = null;
        document.querySelectorAll('.spell-row').forEach(function(row) {
            row.addEventListener('dragstart', function(e) {
                dragged = e.currentTarget;
                e.currentTarget.style.opacity = '0.4';
                e.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragend', function(e) {
                e.currentTarget.style.opacity = '';
            });
            row.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            row.addEventListener('drop', function(e) {
                e.preventDefault();
                if (!dragged || dragged === e.currentTarget) return;
                var fromCat = dragged.dataset.cat;
                var toCat = e.currentTarget.dataset.cat;
                if (fromCat !== toCat) return;  // Nur innerhalb einer Kategorie
                var fromIdx = parseInt(dragged.dataset.idx);
                var toIdx = parseInt(e.currentTarget.dataset.idx);
                var arr = categories[fromCat].spells;
                var item = arr.splice(fromIdx, 1)[0];
                arr.splice(toIdx, 0, item);
                renderCategoriesAdmin();
            });
        });
    }

    // ── Spell-Picker: Dialog zur Spell-Auswahl aus DB ──
    function openSpellPicker(catKey) {
        // Overlay erstellen
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:700px;max-height:80vh;overflow-y:auto;width:90%;';

        var existingIds = new Set(categories[catKey].spells.map(function(s) { return String(s.spellId); }));
        var availableCDs = cooldownsDB.filter(function(cd) {
            return cd.name && cd.spellId && cd.name.indexOf('---') !== 0 && cd.name.indexOf('-- ') !== 0 && !existingIds.has(String(cd.spellId));
        });

        // Gruppiere nach Klasse
        var byClass = {};
        availableCDs.forEach(function(cd) {
            var cls = cd.class || 'UNKNOWN';
            if (!byClass[cls]) byClass[cls] = [];
            byClass[cls].push(cd);
        });

        var classSections = Object.entries(byClass).sort().map(function(entry) {
            var cls = entry[0], cds = entry[1];
            var color = getClassColor(cls);
            var rows = cds.map(function(cd) {
                return '<div class="picker-row flex items-center gap-2 text-[11px] hover:bg-slate-700/40 p-1 rounded cursor-pointer" data-spellid="' + cd.spellId + '">'
                    + '<span style="color:' + color + ';" class="flex-1">' + cd.name + '</span>'
                    + '<span class="text-gray-500 font-mono text-[9px]">' + cd.spellId + '</span>'
                    + '</div>';
            }).join('');
            return '<div class="mb-3">'
                + '<h6 class="font-bold text-xs mb-1" style="color:' + color + ';">' + cls + '</h6>'
                + rows + '</div>';
        }).join('');

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-3">Spell zu "' + categories[catKey].name + '" hinzufügen</h4>'
            + '<input type="text" id="picker-search" placeholder="Suchen..." class="w-full bg-slate-900 text-white px-3 py-2 rounded mb-3 border border-slate-600">'
            + '<div id="picker-list">' + classSections + '</div>'
            + '<div class="flex justify-end mt-3"><button id="picker-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button></div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Search
        var searchInp = modal.querySelector('#picker-search');
        searchInp.addEventListener('input', function(e) {
            var q = e.target.value.toLowerCase();
            modal.querySelectorAll('.picker-row').forEach(function(row) {
                var txt = row.textContent.toLowerCase();
                row.style.display = txt.indexOf(q) !== -1 ? '' : 'none';
            });
        });
        searchInp.focus();

        // Pick
        modal.querySelectorAll('.picker-row').forEach(function(row) {
            row.addEventListener('click', function(e) {
                var spellId = row.dataset.spellid;
                var cd = cooldownsDB.find(function(c) { return String(c.spellId) === spellId; });
                categories[catKey].spells.push({
                    spellId: spellId,
                    cooldownSec: parseInt(cd && cd.cooldownSec) || 180,
                    durationSec: parseInt(cd && cd.durationSec) || 0
                });
                document.body.removeChild(overlay);
                renderCategoriesAdmin();
            });
        });

        // Cancel
        modal.querySelector('#picker-cancel').addEventListener('click', function() {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════

    function clearPlan() {
        manualOverrides = {};
        assignments = [];
        var tbody = document.getElementById('auto-planner-tbody');
        if (tbody) tbody.innerHTML = '';
        updateStatus("Plan geleert.");
    }

    async function doInit(bossConfig) {
        config = bossConfig;
        rosterRef = window.rosterData || [];
        firebaseRef = window.firebaseTools;
        cooldownsDB = window.allCooldowns || [];

        if (!cooldownsDB.length) { updateStatus("⚠ Keine Cooldowns geladen."); return; }

        await loadCategories();
        var hasSavedPlan = await loadPlan();

        var total = 0, found = 0;
        Object.keys(categories).forEach(function(k) {
            categories[k].spells.forEach(function(s) { total++; if (resolveSpell(s.spellId)) found++; });
        });

        if (window.isManager) {
            var admin = document.getElementById('cd-categories-admin');
            if (admin) admin.style.display = '';
            renderCategoriesAdmin();
        }

        document.getElementById('btn-auto-assign').addEventListener('click', runAutoAssign);
        document.getElementById('btn-export-to-planner').addEventListener('click', exportToPlanner);
        document.getElementById('btn-save-auto-plan').addEventListener('click', savePlan);
        document.getElementById('btn-save-categories').addEventListener('click', saveCategories);
        document.getElementById('btn-clear-auto').addEventListener('click', function() {
            if (typeof window.showModal === 'function') {
                var r = window.showModal("Auto-Plan leeren?", true);
                if (r && typeof r.then === 'function') { r.then(function(ok) { if (ok) clearPlan(); }); }
                else clearPlan();
            } else { if (confirm("Auto-Plan leeren?")) clearPlan(); }
        });

        // Wenn ein gespeicherter Plan existiert, direkt anzeigen
        if (hasSavedPlan) {
            runAutoAssign();
        } else {
            updateStatus('Bereit. ' + found + '/' + total + ' Spells in DB. Roster: ' + rosterRef.length + ' Spieler.');
        }
    }

    return {
        init: function(bossConfig) {
            var w = setInterval(function() {
                if (window.rosterData && window.firebaseTools && window.allCooldowns && window.allCooldowns.length) {
                    clearInterval(w);
                    doInit(bossConfig);
                }
            }, 500);
            setTimeout(function() { clearInterval(w); }, 15000);
        }
    };
})();