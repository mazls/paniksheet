// ══════════════════════════════════════════════════════════════════════════
// CD BLOOD-RAGE SOAK ADD-ON  (für PÄNIK Raidsheet / cd-auto-planner.js)
// Boss: Malkorók (SoO) · Phase 2 "Blutrausch" · MoP Classic 5.4
// ──────────────────────────────────────────────────────────────────────────
// Einbinden NACH cd-auto-planner.js:
//   <script src="static/cd-auto-planner.js"></script>
//   <script src="static/cd-bloodrage-addon.js"></script>
//
// Zweck: Verteilt für die "Tanks-soaken-allein"-Taktik Tank-Personals +
// Tank-Externals dauer-bewusst über die ~22,5s, sodass die *physische*
// Schadensreduktion durchgehend über einem Schwellwert (Default 50%) bleibt.
//
// Designfakten (recherchiert, MoP Classic 5.4):
//  - Malkoróks P2-Cleave/Melee ist PHYSISCH -> magische-only-CDs zählen nicht.
//  - DR stackt MULTIPLIKATIV: 50% + 50% = 75% (nicht 100%).
//  - Schutzgeist ist KEIN DR (nur Heal-Amp + Todesschutz) -> safety, nicht in
//    die DR-Deckung gerechnet.
//
// Liefert drei Dinge:
//  1) CD_BLOODRAGE.plan(opts)            -> dauer-bewusster Coverage-Planer
//  2) CD_BLOODRAGE.expandTimelineRow(..) -> macht aus EINER Blood-Rage-Row
//                                           N native Planer-Rows (gestaffelt)
//  3) CD_BLOODRAGE.renderPreview(..)     -> Coverage-Verdikt-Panel (HTML)
// ══════════════════════════════════════════════════════════════════════════

window.CD_BLOODRAGE = (function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────────────
    // PHYSISCHE DR-DATENBANK (spellId -> Werte). dbName = exakter DB-Name aus
    // deiner cooldowns-Collection, damit Export/WeakAura sauber auflösen.
    // spec: erforderliche Spec des *Casters* (Raidhelper-Strings deiner
    //       SPEC_DEFINITIONS). null = jede Spec der Klasse.
    // kind: 'personal' (nur vom soakenden Tank) | 'external' (von anderen)
    // ──────────────────────────────────────────────────────────────────────
    var PHYS_DR_DB = {
        // ---- TANK PERSONALS ------------------------------------------------
        "871": { dbName: "Schildwall", cls: "WARRIOR", spec: "Protection", kind: "personal", drPhys: 0.40, dur: 12, cd: 180, charges: 1 },
        "48792": { dbName: "Eisige Gegenwehr", cls: "DEATHKNIGHT", spec: "Blood", kind: "personal", drPhys: 0.50, dur: 12, cd: 180, charges: 1, note: "inkl. Sanguine Fortitude (+30%)" },
        "61336": { dbName: "Überlebensinstinkte", cls: "DRUID", spec: "Guardian", kind: "personal", drPhys: 0.50, dur: 12, cd: 180, charges: 2 },
        "22812": { dbName: "Baumrinde", cls: "DRUID", spec: "Guardian", kind: "personal", drPhys: 0.20, dur: 12, cd: 60, charges: 1 },
        "115203": { dbName: "Stärkendes Gebräu", cls: "MONK", spec: "Brewmaster", kind: "personal", drPhys: 0.20, dur: 15, cd: 180, charges: 1, note: "geglypht: 0.25 / -10% maxHP" },
        "122278": { dbName: "Schaden dämpfen", cls: "MONK", spec: "Brewmaster", kind: "personal", drPhys: 0.50, dur: null, cd: 90, charges: 1, hitLimited: 3, note: "nächste 3 Treffer (je >=20% maxHP)" },
        "86659": { dbName: "Wächter der uralten Könige", cls: "PALADIN", spec: "Protection1", kind: "personal", drPhys: 0.50, dur: 12, cd: 180, charges: 1 },
        "31850": { dbName: "Unermüdlicher Verteidiger", cls: "PALADIN", spec: "Protection1", kind: "personal", drPhys: 0.20, dur: 10, cd: 180, charges: 1, note: "+Cheat-Death · NICHT in deiner DB -> ggf. Spell anlegen" },

        // ---- TANK EXTERNALS ------------------------------------------------
        "33206": { dbName: "Schmerzunterdrücken", cls: "PRIEST", spec: "Discipline", kind: "external", drPhys: 0.40, dur: 8, cd: 180, charges: 1, note: "Icy-Veins MoP-C nennt 6s" },
        "102342": { dbName: "Eisenborke", cls: "DRUID", spec: "Restoration", kind: "external", drPhys: 0.20, dur: 12, cd: 60, charges: 1 },
        "6940": { dbName: "Hand der Aufopferung", cls: "PALADIN", spec: null, kind: "external", drPhys: 0.30, dur: 12, cd: 120, charges: 1, note: "30% auf Paladin umgeleitet" },
        "122710": { dbName: "Wachsamkeit", cls: "WARRIOR", spec: null, kind: "external", drPhys: 0.30, dur: 12, cd: 120, charges: 1 },
        "114039": { dbName: "Hand der Reinheit", cls: "PALADIN", spec: null, kind: "external", drPhys: 0.10, dur: 6, cd: 30, charges: 1, note: "v.a. gegen DoTs" },

        // ---- SAFETY NET (KEIN DR) ------------------------------------------
        "47788": { dbName: "Schutzgeist", cls: "PRIEST", spec: "Holy", kind: "safety", drPhys: 0.00, dur: 10, cd: 180, charges: 1, note: "kein DR: +60% Heal & Todesschutz" },
        "116849": { dbName: "Lebenskokon", cls: "MONK", spec: "Mistweaver", kind: "safety", drPhys: 0.00, dur: 12, cd: 120, charges: 1, note: "kein DR: großer Absorb + erhöhte Heilung" }
    };

    // ──────────────────────────────────────────────────────────────────────
    // Roster-Helfer: liest dein effectiveRoster/rosterData im echten Format
    // { name, class, spec|specName|specialization, roles:[...] }
    // ──────────────────────────────────────────────────────────────────────
    function getRoster() {
        return (window.effectiveRoster || window.rosterData || []).slice();
    }
    function specOf(p) {
        return (p.spec || p.specName || p.specialization || "").toString();
    }
    // Rolle robust lesen: roles[] (Array), roles "a,b" (String) ODER role (Einzel-String)
    function firstRole(p) {
        var r = p.roles;
        if (r == null || r === "") r = p.role;            // Fallback: Einzel-Key
        if (Array.isArray(r)) r = r[0] || "";
        return (r || "").toString().toLowerCase();
    }
    // Bekannte Tank-Specs (Raidhelper-Werte, normalisiert) als Fallback,
    // falls das Rollenfeld fehlt/anders heißt.
    var TANK_SPECS = ["blood", "guardian", "brewmaster", "protection1", "protection"];
    function isTankSpec(p) {
        var s = specOf(p).toLowerCase().replace(/[^a-z0-9]/g, "");
        return TANK_SPECS.indexOf(s) !== -1;
    }
    function isTank(p) {
        var roleStr = (function () {
            var r = p.roles; if (r == null || r === "") r = p.role;
            if (Array.isArray(r)) return r.join(",").toLowerCase();
            return (r || "").toString().toLowerCase();
        })();
        if (roleStr.indexOf("tank") !== -1) return true;  // bevorzugt über Rolle
        return isTankSpec(p);                              // sonst über Tank-Spec
    }

    // Für die UI: Liste der Tank-Namen (gleiche robuste Erkennung wie der Planer)
    function getTanks(roster) {
        roster = roster || getRoster();
        return roster.filter(isTank).map(function (p) { return p.name; });
    }
    // Für die UI: verfügbare Safety-CDs als [{spellId, dbName, player}] (Caster != Tank)
    function getSafetyOptions(roster, tankName) {
        roster = roster || getRoster();
        var out = [];
        Object.keys(PHYS_DR_DB).forEach(function (spellId) {
            var def = PHYS_DR_DB[spellId];
            if (def.kind !== "safety") return;
            roster.forEach(function (m) {
                if (tankName && m.name === tankName) return;
                if ((m.class || "").toUpperCase() === def.cls && specMatch(specOf(m), def.spec)) {
                    out.push({ spellId: spellId, dbName: def.dbName, player: m.name });
                }
            });
        });
        return out;
    }
    // Tolerantes Spec-Matching (analog normalizeSpec im Hauptmodul)
    function specMatch(playerSpec, reqSpec) {
        if (!reqSpec) return true;
        if (!playerSpec) return true; // ohne Angabe nicht ausschließen
        var a = playerSpec.toLowerCase().replace(/[^a-z]/g, "");
        var b = reqSpec.toLowerCase().replace(/[^a-z]/g, "");
        return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
    }

    // ──────────────────────────────────────────────────────────────────────
    // KERN: dauer-bewusster, multiplikativer Coverage-Planer
    // ──────────────────────────────────────────────────────────────────────
    function plan(opts) {
        var o = Object.assign({
            roster: null,            // default: getRoster()
            expectedHitDmg: 1800000, // unmitigierter Schaden pro Hit
            windowSec: 22.5,
            swingSec: 1.5,
            threshold: 0.50,
            tankHp: 800000,          // HP des soakenden Tanks -> Lethal-Markierung
            overlapSec: 1.0,         // Lead-Time: Folge-CDs starten so viel früher (Reaktionszeit)
            tankTarget: null,        // Name; default = erster Tank
            db: PHYS_DR_DB
        }, opts || {});

        var roster = o.roster || getRoster();
        var tanks = roster.filter(isTank);
        var tank = o.tankTarget ? roster.filter(function (m) { return m.name === o.tankTarget; })[0] : tanks[0];
        if (!tank) return { error: "Kein Tank gefunden (Roster: " + roster.length + " Spieler). Prüfe, dass Tanks role/roles='Tank' ODER eine Tank-Spec (Protection1/Blood/Guardian/Brewmaster/Protection) haben." };

        // 1) Pool an CD-Instanzen bauen
        var pool = [];
        function addInstance(spellId, def, sourceName) {
            var charges = def.charges || 1;
            var effDur = def.dur != null ? def.dur : (def.hitLimited ? def.hitLimited * o.swingSec : 0);
            for (var c = 0; c < charges; c++) {
                pool.push({
                    spellId: spellId, dbName: def.dbName, cls: def.cls, kind: def.kind,
                    drPhys: def.drPhys, dur: effDur, source: sourceName, note: def.note, used: false
                });
            }
        }
        Object.keys(o.db).forEach(function (spellId) {
            var def = o.db[spellId];
            if (def.drPhys <= 0) return; // safety nicht einplanen
            if (def.kind === "personal") {
                if (tank.class && tank.class.toUpperCase() === def.cls && specMatch(specOf(tank), def.spec)) {
                    addInstance(spellId, def, tank.name);
                }
            } else if (def.kind === "external") {
                roster.forEach(function (m) {
                    if (m.name === tank.name) return; // Externals von ANDEREN
                    if ((m.class || "").toUpperCase() === def.cls && specMatch(specOf(m), def.spec)) {
                        addInstance(spellId, def, m.name);
                    }
                });
            }
        });

        // 2) Greedy-Deckung auf 0,25s-Raster (multiplikativ)
        //    activeIds[zelle] = { spellId: true } -> gleiche Aura zählt pro Zelle nur 1x
        var STEP = 0.25;
        var n = Math.ceil(o.windowSec / STEP);
        var mult = new Array(n);
        var activeIds = new Array(n);
        for (var i = 0; i < n; i++) { mult[i] = 1.0; activeIds[i] = {}; }
        function cellDR(idx) { return 1 - mult[idx]; }

        function place(inst, startSec) {
            var s = Math.max(0, Math.round(startSec / STEP));
            var e = Math.min(n, Math.round((startSec + inst.dur) / STEP));
            for (var k = s; k < e; k++) {
                if (activeIds[k][inst.spellId]) continue;   // dieselbe Aura stackt nicht
                mult[k] *= (1 - inst.drPhys);
                activeIds[k][inst.spellId] = true;
            }
            inst.used = true;
            inst.startSec = startSec;
            inst.endSec = Math.min(o.windowSec, startSec + inst.dur);
        }
        // Zellen, in denen dieser CD echten Zugewinn bringt (spellId dort noch nicht aktiv)
        function gainCells(inst, tSec) {
            var s = Math.max(0, Math.round(tSec / STEP));
            var e = Math.min(n, Math.round((tSec + inst.dur) / STEP));
            var c = 0;
            for (var k = s; k < e; k++) if (!activeIds[k][inst.spellId]) c++;
            return c;
        }
        function pickBest(tSec) {
            var gi = Math.min(n - 1, Math.floor(tSec / STEP));
            var best = null, bestScore = -1;
            pool.forEach(function (inst) {
                if (inst.used || inst.dur <= 0) return;
                if (activeIds[gi][inst.spellId]) return;     // an der Lücke schon aktiv -> kein Nutzen
                var g = gainCells(inst, tSec);               // nur Zellen mit echtem Zugewinn
                if (g <= 0) return;
                var score = inst.drPhys * g;
                if (inst.kind === "personal") score += 0.001; // Tie-Break: Personals zuerst
                if (score > bestScore) { bestScore = score; best = inst; }
            });
            return best;
        }
        for (var ci = 0; ci < n; ci++) {
            var guard = 0;
            while (cellDR(ci) < o.threshold - 1e-9 && guard++ < 40) {
                var cand = pickBest(ci * STEP);
                if (!cand) break;
                // Lead-Time: Folge-CD startet etwas früher (Reaktionszeit) -> kleine
                // Überlappung mit dem vorherigen CD, kein Drop beim Wechsel.
                var lead = Math.min(o.overlapSec || 0, Math.max(0, cand.dur - STEP));
                var startAt = Math.max(0, (ci * STEP) - lead);
                place(cand, startAt);
            }
        }

        // 3) Auswertung
        var rotation = pool.filter(function (p) { return p.used; }).map(function (p) {
            return {
                offsetSec: +p.startSec.toFixed(2),
                endSec: +p.endSec.toFixed(2),
                durSec: p.dur,
                spellId: p.spellId, dbName: p.dbName, cls: p.cls,
                player: p.source, target: tank.name,
                drPhys: p.drPhys, kind: p.kind, note: p.note
            };
        }).sort(function (a, b) { return a.offsetSec - b.offsetSec; });

        // 3b) OPTIONALER Safety-CD (kein DR; Todesschutz/Absorb). Wird nur
        //     eingeplant, wenn safetySpellId gesetzt ist und ein Caster (nicht
        //     der Tank) verfügbar ist. Beeinflusst Coverage/Restschaden NICHT.
        if (o.safetySpellId && o.db[o.safetySpellId] && o.db[o.safetySpellId].kind === "safety") {
            var sdef = o.db[o.safetySpellId];
            var scaster = null;
            roster.forEach(function (m) {
                if (scaster || m.name === tank.name) return;
                if ((m.class || "").toUpperCase() === sdef.cls && specMatch(specOf(m), sdef.spec)) scaster = m.name;
            });
            if (scaster) {
                var soff = (o.safetyOffsetSec != null) ? o.safetyOffsetSec : 0;
                if (soff < 0 || soff > o.windowSec) soff = 0;
                rotation.push({
                    offsetSec: +soff.toFixed(2),
                    endSec: +Math.min(o.windowSec, soff + sdef.dur).toFixed(2),
                    durSec: sdef.dur, spellId: o.safetySpellId, dbName: sdef.dbName, cls: sdef.cls,
                    player: scaster, target: tank.name, drPhys: 0, kind: "safety", note: sdef.note
                });
                rotation.sort(function (a, b) { return a.offsetSec - b.offsetSec; });
            }
        }

        var timeline = [], worst = 0, sumDR = 0, hits = 0, lethalHits = 0;
        var hp = o.tankHp > 0 ? o.tankHp : 0;
        for (var t = 0; t < o.windowSec + 1e-6; t += o.swingSec) {
            var idx = Math.min(n - 1, Math.floor(t / STEP));
            var dr = cellDR(idx);
            var residual = o.expectedHitDmg * mult[idx];
            var lethal = hp > 0 && residual >= hp;
            if (lethal) lethalHits++;
            timeline.push({ t: +t.toFixed(2), combinedDR: +dr.toFixed(3), residualHit: Math.round(residual), lethal: lethal });
            if (residual > worst) worst = residual;
            sumDR += dr; hits++;
        }
        var gapCells = 0;
        for (var gi = 0; gi < n; gi++) if (cellDR(gi) < o.threshold - 1e-9) gapCells++;

        return {
            tank: tank.name,
            baseHit: o.expectedHitDmg,
            threshold: o.threshold,
            windowSec: o.windowSec,
            tankHp: hp,
            rotation: rotation,
            timeline: timeline,
            worstResidualHit: Math.round(worst),
            hpBuffer: hp > 0 ? Math.round(hp - worst) : null,   // Puffer beim härtesten Hit (negativ = tödlich)
            lethalHits: lethalHits,
            avgCombinedDR: +(sumDR / hits).toFixed(3),
            coverageGapSec: +(gapCells * STEP).toFixed(2),
            hitsTotal: hits
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    // TIMELINE-EXPANSION: macht aus EINER Blood-Rage-Timeline-Row N native
    // Rows (eine pro Rotations-Eintrag), gestaffelt via row.delay = offset.
    // Schreibt in dein row.slots[catKey]-Format -> Render & Export funktionieren
    // unverändert. forceTriggerCondition pinnt alle auf denselben Cast.
    //
    // catKey: unter welcher Kategorie die Slots erscheinen (Default 'tank_soak_phys')
    // baseRow: die ursprüngliche Blood-Rage-Row aus deiner timeline
    // ──────────────────────────────────────────────────────────────────────
    function expandTimelineRow(baseRow, planResult, catKey) {
        catKey = catKey || "tank_soak_phys";
        var rows = [];
        planResult.rotation.forEach(function (e) {
            var slots = {};
            slots[catKey] = {
                player: e.player,
                dbName: e.dbName,
                dbClass: e.cls,
                spellId: e.spellId,
                cooldownSec: (PHYS_DR_DB[e.spellId] && PHYS_DR_DB[e.spellId].cd) || 180,
                durationSec: e.durSec,
                auto: true,
                _bloodrage: true
            };
            rows.push(Object.assign({}, baseRow, {
                // gestaffelter Offset wird als relativer Delay exportiert ("Zeit")
                delay: e.offsetSec,
                absTime: baseRow.absTime, // gleicher Event-Zeitpunkt
                requiredCDs: [catKey],
                slots: slots,
                // alle Rotations-Rows gehören zum selben Cast -> Condition pinnen
                _sourceEvent: Object.assign({}, baseRow._sourceEvent || {}, {
                    forceTriggerCondition: baseRow.castNum || 1
                }),
                _bloodrageExpanded: true
            }));
        });
        return rows;
    }

    // Bequem: ersetzt im assignments-Array jede Row, deren requiredCDs die
    // Soak-Kategorie enthält, durch die expandierten Rotations-Rows.
    // => Die "Taktik-Umschaltung" ist schlicht: ist tank_soak_phys am Event an?
    // Parameter (Schaden/Schwelle/Swing) werden PRO EVENT aus row.soak gelesen
    // (kommt via getEffectiveEvents/generateTimeline durch); planOpts ist nur
    // der Fallback, falls am Event nichts gesetzt ist.
    function applyToAssignments(assignments, opts) {
        opts = opts || {};
        var catKey = opts.catKey || "tank_soak_phys";
        var def = opts.planOpts || {};
        var out = [];
        assignments.forEach(function (row) {
            var needsSoak = (row.requiredCDs || []).indexOf(catKey) !== -1;
            if (needsSoak && !row._bloodrageExpanded) {
                var s = row.soak || {};
                var planResult = plan({
                    expectedHitDmg: s.expectedHitDmg != null ? s.expectedHitDmg : (def.expectedHitDmg != null ? def.expectedHitDmg : 1800000),
                    threshold: s.threshold != null ? s.threshold : (def.threshold != null ? def.threshold : 0.50),
                    tankHp: s.tankHp != null ? s.tankHp : (def.tankHp != null ? def.tankHp : 800000),
                    overlapSec: s.overlapSec != null ? s.overlapSec : (def.overlapSec != null ? def.overlapSec : 1.0),
                    swingSec: s.swingSec != null ? s.swingSec : (def.swingSec != null ? def.swingSec : 1.5),
                    tankTarget: s.tankTarget || def.tankTarget || null,
                    safetySpellId: s.safetySpellId || def.safetySpellId || null,
                    safetyOffsetSec: s.safetyOffsetSec != null ? s.safetyOffsetSec : (def.safetyOffsetSec != null ? def.safetyOffsetSec : 0),
                    windowSec: row.eventDuration || 22.5
                });
                if (planResult.error) { out.push(row); return; }
                row._lastPlan = planResult; // für Preview greifbar
                expandTimelineRow(row, planResult, catKey).forEach(function (r) { out.push(r); });
            } else {
                out.push(row);
            }
        });
        return out;
    }

    // ──────────────────────────────────────────────────────────────────────
    // PREVIEW-PANEL (inline-styled, passt zum slate/amber-Theme)
    // ──────────────────────────────────────────────────────────────────────
    function renderPreview(planResult, mountEl) {
        if (typeof mountEl === "string") mountEl = document.getElementById(mountEl);
        if (!mountEl) return;
        if (planResult.error) {
            mountEl.innerHTML = '<div style="background:#3a1f1d;border:1px solid #c5524c;color:#f0c4c1;padding:10px;border-radius:6px;font-size:13px">' + planResult.error + '</div>';
            return;
        }
        var fmt = function (x) { return Math.round(x).toLocaleString("de-DE"); };
        var win = planResult.windowSec;
        var BAR = { personal: "#c8aa6e", external: "#7fb0d4", safety: "#9d8fc0" };
        var gapColor = planResult.coverageGapSec > 0 ? "#c5524c" : "#5f9d63";

        var gap = planResult.coverageGapSec > 0
            ? '<div style="background:#3a1f1d;border:1px solid #c5524c;color:#f0c4c1;padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:10px">⚠ Deckungslücke: <b>' + planResult.coverageGapSec + 's</b> unter ' + Math.round(planResult.threshold * 100) + '% DR – Roster reicht für diese Schwelle nicht. Schwelle senken oder mehr Externals.</div>'
            : '';

        var hp = planResult.tankHp || 0;
        var bufColor = (planResult.hpBuffer == null) ? "#dfe3ea"
            : (planResult.hpBuffer < 0 ? "#c5524c" : (planResult.hpBuffer < hp * 0.15 ? "#d08a3e" : "#5f9d63"));

        var lethal = (planResult.lethalHits > 0)
            ? '<div style="background:#3a1f1d;border:1px solid #c5524c;color:#f0c4c1;padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:10px">💀 <b>' + planResult.lethalHits + '</b> von ' + planResult.hitsTotal + ' Hits ≥ Tank-HP (' + fmt(hp) + ') – ohne Zwischenheilung tödlich. Schwelle/Überlappung erhöhen, Safety-CD setzen oder mehr Externals.</div>'
            : '';

        var kpi = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
            kpiBox((planResult.avgCombinedDR * 100).toFixed(0) + "%", "Ø DR") +
            kpiBox(fmt(planResult.worstResidualHit), "Worst Hit") +
            (hp > 0 ? kpiBox(fmt(hp), "Tank-HP") : '') +
            (hp > 0 ? kpiBox('<span style="color:' + bufColor + '">' + (planResult.hpBuffer < 0 ? '−' : '') + fmt(Math.abs(planResult.hpBuffer)) + '</span>', "Puffer @Worst") : '') +
            kpiBox('<span style="color:' + gapColor + '">' + planResult.coverageGapSec + 's</span>', "Lücke") +
            kpiBox(planResult.rotation.length, "CDs") +
            '</div>';

        var lanes = planResult.rotation.map(function (e) {
            var left = (e.offsetSec / win * 100), w = ((e.endSec - e.offsetSec) / win * 100);
            return '<div style="position:relative;height:24px;margin:3px 0">' +
                '<div title="' + e.dbName + ' · ' + e.player + '" style="position:absolute;left:' + left + '%;width:' + w + '%;top:2px;height:20px;border-radius:4px;background:' + (BAR[e.kind] || "#888") + ';color:#15130f;font-size:11px;display:flex;align-items:center;padding:0 6px;white-space:nowrap;overflow:hidden">' +
                e.dbName + ' (' + (e.kind === "safety" ? "Safety" : Math.round(e.drPhys * 100) + '%') + ') · ' + e.player + '</div></div>';
        }).join("");
        var gantt = '<div style="background:#23262f;border:1px solid #33373f;border-radius:6px;padding:8px">' + lanes + '</div>';

        var curve;
        if (hp > 0) {
            // Restschaden pro Hit relativ zur Tank-HP -> volle Höhe = HP, rot = tödlich
            curve = '<div style="display:flex;gap:2px;align-items:flex-end;height:60px;margin-top:10px">' +
                planResult.timeline.map(function (h) {
                    var frac = Math.min(1, h.residualHit / hp);
                    var col = h.lethal ? "#c5524c" : (h.combinedDR >= planResult.threshold ? "#5f9d63" : "#d08a3e");
                    return '<div title="' + h.t + 's: Rest ' + fmt(h.residualHit) + ' / HP ' + fmt(hp) + ' (' + Math.round(h.combinedDR * 100) + '% DR)' + (h.lethal ? ' – TÖDLICH' : '') + '" style="flex:1;background:' + col + ';border-radius:2px 2px 0 0;height:' + Math.max(2, frac * 60) + 'px"></div>';
                }).join("") + '</div>' +
                '<div style="font-size:11px;color:#8b909b;margin-top:4px">Restschaden pro Hit relativ zu Tank-HP · volle Höhe = HP · rot = tödlich (ungeheilt)</div>';
        } else {
            curve = '<div style="display:flex;gap:2px;align-items:flex-end;height:60px;margin-top:10px">' +
                planResult.timeline.map(function (h) {
                    var col = h.combinedDR >= planResult.threshold ? "#5f9d63" : (h.combinedDR > 0 ? "#d08a3e" : "#c5524c");
                    return '<div title="' + h.t + 's: ' + Math.round(h.combinedDR * 100) + '% → ' + fmt(h.residualHit) + '" style="flex:1;background:' + col + ';border-radius:2px 2px 0 0;height:' + Math.max(2, h.combinedDR * 60) + 'px"></div>';
                }).join("") + '</div>' +
                '<div style="font-size:11px;color:#8b909b;margin-top:4px">DR-Kurve pro Hit · grün ≥ Schwelle, orange teilweise, rot ungedeckt</div>';
        }

        mountEl.innerHTML = lethal + gap + kpi +
            '<div style="font-size:12px;color:#8b909b;text-transform:uppercase;letter-spacing:.05em;margin:4px 0 6px">Rotation (Tank: ' + planResult.tank + ')</div>' +
            gantt + curve;

        function kpiBox(v, l) {
            return '<div style="background:#23262f;border:1px solid #33373f;border-radius:6px;padding:8px 12px;min-width:90px">' +
                '<div style="font-size:18px;font-weight:700;color:#dfe3ea">' + v + '</div>' +
                '<div style="font-size:10px;color:#8b909b;text-transform:uppercase;letter-spacing:.05em">' + l + '</div></div>';
        }
    }

    return {
        PHYS_DR_DB: PHYS_DR_DB,
        plan: plan,
        getTanks: getTanks,
        getSafetyOptions: getSafetyOptions,
        expandTimelineRow: expandTimelineRow,
        applyToAssignments: applyToAssignments,
        renderPreview: renderPreview
    };
})();

// Node-Export nur fürs Testen
if (typeof module !== "undefined" && module.exports) {
    module.exports = window.CD_BLOODRAGE || global.CD_BLOODRAGE;
}