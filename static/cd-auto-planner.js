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
    // SPEC-DEFINITIONEN
    // ──────────────────────────────────────────────────────────────
    // Mapping: Raidhelper-Spec-Name (intern) → Lesbares Label (UI)
    // Die "1"-Suffixe (Holy1, Protection1, Restoration1, Frost1)
    // kommen aus dem Raidhelper-Export und dienen zur Unterscheidung
    // von gleichnamigen Specs anderer Klassen (z.B. Priester "Holy"
    // vs. Paladin "Holy1"). Intern verwenden wir die Raidhelper-Namen
    // zum Matching, die UI zeigt schöne Labels.
    // ══════════════════════════════════════════════════════════════

    const SPEC_DEFINITIONS = {
        DEATHKNIGHT: [
            { value: 'Blood',        label: 'Blood (Tank)' },
            { value: 'Frost1',       label: 'Frost' },
            { value: 'Unholy',       label: 'Unholy' }
        ],
        DRUID: [
            { value: 'Balance',      label: 'Balance' },
            { value: 'Feral',        label: 'Feral' },
            { value: 'Guardian',     label: 'Guardian (Tank)' },
            { value: 'Restoration',  label: 'Restoration (Heal)' }
        ],
        HUNTER: [
            { value: 'Beastmastery', label: 'Beastmastery' },
            { value: 'Marksmanship', label: 'Marksmanship' },
            { value: 'Survival',     label: 'Survival' }
        ],
        MAGE: [
            { value: 'Arcane',       label: 'Arcane' },
            { value: 'Fire',         label: 'Fire' },
            { value: 'Frost',        label: 'Frost' }
        ],
        MONK: [
            { value: 'Brewmaster',   label: 'Brewmaster (Tank)' },
            { value: 'Mistweaver',   label: 'Mistweaver (Heal)' },
            { value: 'Windwalker',   label: 'Windwalker' }
        ],
        PALADIN: [
            { value: 'Holy1',        label: 'Holy (Heal)' },
            { value: 'Protection1',  label: 'Protection (Tank)' },
            { value: 'Retribution',  label: 'Retribution' }
        ],
        PRIEST: [
            { value: 'Discipline',   label: 'Discipline (Heal)' },
            { value: 'Holy',         label: 'Holy (Heal)' },
            { value: 'Shadow',       label: 'Shadow' }
        ],
        ROGUE: [
            { value: 'Assassination', label: 'Assassination' },
            { value: 'Combat',       label: 'Combat' },
            { value: 'Subtlety',     label: 'Subtlety' }
        ],
        SHAMAN: [
            { value: 'Elemental',    label: 'Elemental' },
            { value: 'Enhancement',  label: 'Enhancement' },
            { value: 'Restoration1', label: 'Restoration (Heal)' }
        ],
        WARLOCK: [
            { value: 'Affliction',   label: 'Affliction' },
            { value: 'Demonology',   label: 'Demonology' },
            { value: 'Destruction',  label: 'Destruction' }
        ],
        WARRIOR: [
            { value: 'Arms',         label: 'Arms' },
            { value: 'Fury',         label: 'Fury' },
            { value: 'Protection',   label: 'Protection (Tank)' }
        ]
    };

    // Hilfsfunktion: Raidhelper-Name → Label
    function getSpecLabel(specValue) {
        for (var cls in SPEC_DEFINITIONS) {
            var found = SPEC_DEFINITIONS[cls].find(function(s) { return s.value === specValue; });
            if (found) return found.label;
        }
        return specValue;  // Fallback wenn unbekannt
    }

    // ══════════════════════════════════════════════════════════════
    // DEFAULT CD-KATEGORIEN (spellId-basiert, wird gegen DB aufgelöst)
    //
    // cooldownSec = Fallback wenn DB kein cooldownSec hat
    // durationSec = Fallback wenn DB kein durationSec hat
    // Prioritaet = Reihenfolge im Array (Index 0 = hoechste)
    // ══════════════════════════════════════════════════════════════

    const DEFAULT_CATEGORIES = {

        // ══════════════════════════════════════════════════════════
        // MAGICAL DAMAGE REDUCTION
        // Sheet-Prio: Devo(Retri) → Devo(Holy) → PW:B(Disc) → Devo(Holy) → SLT(Resto)
        // ══════════════════════════════════════════════════════════
        magical_dr: {
            name: "Magische Schadensred.", shortName: "Magic DR", color: "#8b5cf6",
            spells: [
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Retribution"] },       // Devo (Retri)
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Protection1"] },       // Devo (Prot)
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },        // PW:Barrier (Disc)
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Holy1"] },             // Devo (Holy)
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Restoration1"] },      // SLT (Resto Shaman)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // PHYSICAL DAMAGE REDUCTION
        // Sheet-Prio: Devo(Retri) → PW:B(Disc) → SLT(Resto)
        // ══════════════════════════════════════════════════════════
        physical_dr: {
            name: "Physische Schadensred.", shortName: "Phys DR", color: "#d97706",
            spells: [
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Retribution"] },
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Protection1"] },
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Holy1"] },
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Restoration1"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // MAJOR HEALING
        // Sheet-Prio: HTT(Resto) → Tranq(Resto-Druid) → Divine Hymn(Holy) → Revival(MW) → Vampiric Embrace(Shadow)
        // ══════════════════════════════════════════════════════════
        major_heal: {
            name: "Grosse Heilung", shortName: "Major Heal", color: "#10b981",
            spells: [
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Restoration1"] },      // HTT
                { spellId: "740",    cooldownSec: 180, durationSec: 8,  requiredSpec: ["Restoration"] },        // Tranquility (Resto: 3min)
                { spellId: "64843",  cooldownSec: 180, durationSec: 8,  requiredSpec: ["Holy"] },              // Divine Hymn
                { spellId: "115310", cooldownSec: 180, durationSec: 0,  requiredSpec: ["Mistweaver"] },        // Revival
                { spellId: "15286",  cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },            // Vampiric Embrace
            ]
        },

        // ══════════════════════════════════════════════════════════
        // MINOR HEALING
        // Sheet-Prio: HTT(Elem) → HTT(Enh) → AG(Elem) → AG(Enh) → Halo(Holy) → Halo(Disc) → Halo(Shadow)
        // ══════════════════════════════════════════════════════════
        minor_heal: {
            name: "Kleine Heilung", shortName: "Minor Heal", color: "#34d399",
            spells: [
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Elemental"] },         // HTT (Elem)
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Enhancement"] },       // HTT (Enh)
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Elemental"] },         // AG (Elem)
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Enhancement"] },       // AG (Enh)
                { spellId: "120517", cooldownSec: 40,  durationSec: 1,  requiredSpec: ["Holy"] },              // Halo (Holy)
                { spellId: "120517", cooldownSec: 40,  durationSec: 1,  requiredSpec: ["Discipline"] },        // Halo (Disc)
                { spellId: "120517", cooldownSec: 40,  durationSec: 1,  requiredSpec: ["Shadow"] },            // Halo (Shadow)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // ANY HEALING (Kombination aus Major + Minor)
        // ══════════════════════════════════════════════════════════
        any_heal: {
            name: "Beliebige Heilung", shortName: "Any Heal", color: "#6ee7b7",
            spells: [
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Restoration1"] },      // HTT (Resto)
                { spellId: "740",    cooldownSec: 180, durationSec: 8,  requiredSpec: ["Restoration"] },        // Tranquility
                { spellId: "64843",  cooldownSec: 180, durationSec: 8,  requiredSpec: ["Holy"] },              // Divine Hymn
                { spellId: "115310", cooldownSec: 180, durationSec: 0,  requiredSpec: ["Mistweaver"] },        // Revival
                { spellId: "15286",  cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },            // Vampiric Embrace
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Elemental"] },         // HTT (Elem)
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Enhancement"] },       // HTT (Enh)
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Elemental"] },         // AG (Elem)
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Enhancement"] },       // AG (Enh)
                { spellId: "120517", cooldownSec: 40,  durationSec: 1,  requiredSpec: ["Holy"] },              // Halo
                { spellId: "120517", cooldownSec: 40,  durationSec: 1,  requiredSpec: ["Discipline"] },
                { spellId: "120517", cooldownSec: 40,  durationSec: 1,  requiredSpec: ["Shadow"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // ADDITIONAL SURVIVAL
        // Sheet-Prio: Rallying Cry(Warrior) → Demo Banner(Warrior) → SLT(Resto)
        // ══════════════════════════════════════════════════════════
        additional_surv: {
            name: "Zusaetzliches Ueberleben", shortName: "Add. Surv", color: "#f59e0b",
            spells: [
                { spellId: "97462",  cooldownSec: 180, durationSec: 10 },                                       // Rallying Cry (jede Warrior-Spec)
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },                                       // Demo Banner
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Restoration1"] },      // SLT
            ]
        },

        // ══════════════════════════════════════════════════════════
        // ANY DR / HEALTH INCREASE
        // Mega-Kategorie: Alle DRs + wichtige Heal-CDs kombiniert
        // ══════════════════════════════════════════════════════════
        any_dr: {
            name: "Beliebige Schadensred.", shortName: "Any DR", color: "#a78bfa",
            spells: [
                // Prio 1-4: Devotion Aura (alle Paladin-Specs) + PW:B + SLT
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Retribution"] },
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Protection1"] },
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Holy1"] },
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Restoration1"] },
                // Raid-Utility
                { spellId: "97462",  cooldownSec: 180, durationSec: 10 },                                       // Rallying Cry
                { spellId: "76577",  cooldownSec: 180, durationSec: 5  },                                       // Smoke Bomb
                // Heals als Notfall
                { spellId: "740",    cooldownSec: 180, durationSec: 8,  requiredSpec: ["Restoration"] },
                { spellId: "64843",  cooldownSec: 180, durationSec: 8,  requiredSpec: ["Holy"] },
                { spellId: "115310", cooldownSec: 180, durationSec: 0,  requiredSpec: ["Mistweaver"] },
                { spellId: "15286",  cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Restoration1"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Elemental"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Enhancement"] },
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },                                       // Demo Banner
                { spellId: "51052",  cooldownSec: 120, durationSec: 10 },                                       // AMZ (alle DKs)
                { spellId: "122278", cooldownSec: 90,  durationSec: 10 },                                       // Dampen Harm (alle Mönche)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // ANY DEFENSIVE COOLDOWN / HEAL
        // ══════════════════════════════════════════════════════════
        any_def: {
            name: "Beliebiger Defensiv-CD", shortName: "Any Def", color: "#c084fc",
            spells: [
                // Paladin Auras
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Retribution"] },
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Protection1"] },
                { spellId: "31821",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Holy1"] },
                // Major Raid-CDs
                { spellId: "62618",  cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },
                { spellId: "98008",  cooldownSec: 180, durationSec: 6,  requiredSpec: ["Restoration1"] },
                { spellId: "97462",  cooldownSec: 180, durationSec: 10 },
                { spellId: "76577",  cooldownSec: 180, durationSec: 5  },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Restoration1"] },
                { spellId: "740",    cooldownSec: 180, durationSec: 8,  requiredSpec: ["Restoration"] },
                { spellId: "64843",  cooldownSec: 180, durationSec: 8,  requiredSpec: ["Holy"] },
                { spellId: "115310", cooldownSec: 180, durationSec: 0,  requiredSpec: ["Mistweaver"] },
                { spellId: "15286",  cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Elemental"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Elemental"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Enhancement"] },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Enhancement"] },
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },
                { spellId: "51052",  cooldownSec: 120, durationSec: 10 },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // MOVEMENT SPEED
        // Sheet-Prio: Stampeding Roar (alle Druid-Specs)
        // ══════════════════════════════════════════════════════════
        movement: {
            name: "Bewegungsgeschw.", shortName: "Speed", color: "#22d3ee",
            spells: [
                { spellId: "77764",  cooldownSec: 120, durationSec: 8, requiredSpec: ["Guardian"] },
                { spellId: "77764",  cooldownSec: 120, durationSec: 8, requiredSpec: ["Feral"] },
                { spellId: "77764",  cooldownSec: 120, durationSec: 8, requiredSpec: ["Balance"] },
                { spellId: "77764",  cooldownSec: 120, durationSec: 8, requiredSpec: ["Restoration"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // BLOODLUST
        // Sheet-Prio: Time-Warp(Fire) → Time-Warp(Frost) → BL(Resto) → BL(Enh) → BL(Elem) → Time-Warp(Arcane)
        // ══════════════════════════════════════════════════════════
        bloodlust: {
            name: "Kampfrausch", shortName: "Lust", color: "#ef4444",
            spells: [
                { spellId: "80353",  cooldownSec: 300, durationSec: 40, requiredSpec: ["Fire"] },              // Time-Warp (Fire)
                { spellId: "80353",  cooldownSec: 300, durationSec: 40, requiredSpec: ["Frost"] },             // Time-Warp (Frost)
                { spellId: "2825",   cooldownSec: 300, durationSec: 40, requiredSpec: ["Restoration1"] },      // Bloodlust (Resto)
                { spellId: "2825",   cooldownSec: 300, durationSec: 40, requiredSpec: ["Enhancement"] },       // Bloodlust (Enh)
                { spellId: "2825",   cooldownSec: 300, durationSec: 40, requiredSpec: ["Elemental"] },         // Bloodlust (Elem)
                { spellId: "80353",  cooldownSec: 300, durationSec: 40, requiredSpec: ["Arcane"] },            // Time-Warp (Arcane)
                { spellId: "90355",  cooldownSec: 300, durationSec: 40 },                                       // Ancient Hysteria (Hunter Pet)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // STORMLASH & BANNER
        // ══════════════════════════════════════════════════════════
        stormlash: {
            name: "Stormlash", shortName: "Stormlash", color: "#3b82f6",
            spells: [
                { spellId: "120668", cooldownSec: 300, durationSec: 10, requiredSpec: ["Enhancement"] },
                { spellId: "120668", cooldownSec: 300, durationSec: 10, requiredSpec: ["Elemental"] },
                { spellId: "120668", cooldownSec: 300, durationSec: 10, requiredSpec: ["Restoration1"] }
            ]
        },
        skull_banner: {
            name: "Skull Banner", shortName: "Banner", color: "#fcd34d",
            spells: [
                { spellId: "114207", cooldownSec: 180, durationSec: 10, requiredSpec: ["Arms", "Fury"] },
                { spellId: "114207", cooldownSec: 180, durationSec: 10, requiredSpec: ["Protection"] }
            ]
        },

        // ══════════════════════════════════════════════════════════
        // MANA (NEU — für Hymn of Hope / Mana Tide)
        // ══════════════════════════════════════════════════════════
        mana: {
            name: "Mana-Regeneration", shortName: "Mana", color: "#3b82f6",
            spells: [
                { spellId: "16190",  cooldownSec: 180, durationSec: 16, requiredSpec: ["Restoration1"] },      // Mana Tide Totem (Resto Shaman)
                { spellId: "16190",  cooldownSec: 180, durationSec: 16, requiredSpec: ["Restoration1"] },      // Mana Tide Totem (2. für weitere Schamanen)
                { spellId: "64901",  cooldownSec: 360, durationSec: 8,  requiredSpec: ["Holy"] },              // Hymn of Hope (Holy)
                { spellId: "64901",  cooldownSec: 360, durationSec: 8,  requiredSpec: ["Discipline"] },        // Hymn of Hope (Disc)
                { spellId: "64901",  cooldownSec: 360, durationSec: 8,  requiredSpec: ["Shadow"] },            // Hymn of Hope (Shadow)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // AOE STUN
        // Sheet-Prio: Leg Sweep(WW) → Leg Sweep(MW) → Leg Sweep(BM) → Shadowfury×3 → Cap Totem×3 → Shockwave(Prot) → Shockwave(Fury) → Shockwave(Arms)
        // ══════════════════════════════════════════════════════════
        aoe_stun: {
            name: "AoE Stun", shortName: "AoE Stun", color: "#f97316",
            spells: [
                { spellId: "119381", cooldownSec: 45, durationSec: 5, requiredSpec: ["Windwalker"] },          // Leg Sweep
                { spellId: "119381", cooldownSec: 45, durationSec: 5, requiredSpec: ["Mistweaver"] },
                { spellId: "119381", cooldownSec: 45, durationSec: 5, requiredSpec: ["Brewmaster"] },
                { spellId: "30283",  cooldownSec: 30, durationSec: 3, requiredSpec: ["Destruction"] },         // Shadowfury
                { spellId: "30283",  cooldownSec: 30, durationSec: 3, requiredSpec: ["Demonology"] },
                { spellId: "30283",  cooldownSec: 30, durationSec: 3, requiredSpec: ["Affliction"] },
                { spellId: "118905", cooldownSec: 45, durationSec: 5, requiredSpec: ["Enhancement"] },         // Capacitor Totem
                { spellId: "118905", cooldownSec: 45, durationSec: 5, requiredSpec: ["Restoration1"] },
                { spellId: "118905", cooldownSec: 45, durationSec: 5, requiredSpec: ["Elemental"] },
                { spellId: "46968",  cooldownSec: 40, durationSec: 4, requiredSpec: ["Protection"] },          // Shockwave
                { spellId: "46968",  cooldownSec: 40, durationSec: 4, requiredSpec: ["Fury"] },
                { spellId: "46968",  cooldownSec: 40, durationSec: 4, requiredSpec: ["Arms"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // DISARM
        // Sheet-Prio: Disarm(Fury) → Disarm(Arms) → Disarm(Prot) → Dismantle(Combat/Assa/Sub) → Grapple(WW/MW/BM) → Psychic Horror(Shadow)
        // ══════════════════════════════════════════════════════════
        disarm: {
            name: "Disarm", shortName: "Disarm", color: "#94a3b8",
            spells: [
                { spellId: "676",    cooldownSec: 60, durationSec: 10, requiredSpec: ["Fury"] },               // Disarm
                { spellId: "676",    cooldownSec: 60, durationSec: 10, requiredSpec: ["Arms"] },
                { spellId: "676",    cooldownSec: 60, durationSec: 10, requiredSpec: ["Protection"] },
                { spellId: "51722",  cooldownSec: 60, durationSec: 8,  requiredSpec: ["Combat"] },             // Dismantle
                { spellId: "51722",  cooldownSec: 60, durationSec: 8,  requiredSpec: ["Assassination"] },
                { spellId: "51722",  cooldownSec: 60, durationSec: 8,  requiredSpec: ["Subtlety"] },
                { spellId: "117368", cooldownSec: 60, durationSec: 6,  requiredSpec: ["Windwalker"] },         // Grapple Weapon
                { spellId: "117368", cooldownSec: 60, durationSec: 6,  requiredSpec: ["Mistweaver"] },
                { spellId: "117368", cooldownSec: 60, durationSec: 6,  requiredSpec: ["Brewmaster"] },
                { spellId: "64044",  cooldownSec: 120, durationSec: 3, requiredSpec: ["Shadow"] },             // Psychic Horror
            ]
        },

        // ══════════════════════════════════════════════════════════
        // HAND OF PROTECTION (priority-basiert)
        // Sheet-Prio: HoP(Prot) → HoP(Retri) → HoP(Holy)
        // ══════════════════════════════════════════════════════════
        hop: {
            name: "Hand des Schutzes", shortName: "HoP", color: "#f9a8d4",
            spells: [
                { spellId: "1022", cooldownSec: 300, durationSec: 10, requiredSpec: ["Protection1"] },
                { spellId: "1022", cooldownSec: 300, durationSec: 10, requiredSpec: ["Retribution"] },
                { spellId: "1022", cooldownSec: 300, durationSec: 10, requiredSpec: ["Holy1"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // HAND OF SACRIFICE
        // Sheet-Prio: HoSac(Holy) → HoSac(Retri) → HoSac(Prot)
        // ══════════════════════════════════════════════════════════
        hos: {
            name: "Hand der Aufopferung", shortName: "HoSac", color: "#fb7185",
            spells: [
                { spellId: "6940", cooldownSec: 120, durationSec: 12, requiredSpec: ["Holy1"] },
                { spellId: "6940", cooldownSec: 120, durationSec: 12, requiredSpec: ["Retribution"] },
                { spellId: "6940", cooldownSec: 120, durationSec: 12, requiredSpec: ["Protection1"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // TANK EXTERNAL (NEU — Einzel-Target Tank-CDs)
        // ══════════════════════════════════════════════════════════
        tank_external: {
            name: "Tank External", shortName: "Tank Ext", color: "#fbbf24",
            spells: [
                { spellId: "33206",  cooldownSec: 180, durationSec: 8,  requiredSpec: ["Discipline"] },        // Pain Suppression
                { spellId: "47788",  cooldownSec: 180, durationSec: 10, requiredSpec: ["Holy"] },              // Guardian Spirit
                { spellId: "6940",   cooldownSec: 120, durationSec: 12 },                                       // HoSac (jeder Paladin)
                { spellId: "102342", cooldownSec: 60,  durationSec: 12, requiredSpec: ["Restoration"] },       // Ironbark
                { spellId: "122710", cooldownSec: 120, durationSec: 12 },                                       // Vigilance (jeder Warrior)
                { spellId: "114039", cooldownSec: 30,  durationSec: 6 },                                        // Hand of Purity (jeder Paladin)
            ]
        }
    };

    // ── State ──
    var config = null;
    var categories = {};
    var assignments = [];
    var manualOverrides = {};
    var eventOverrides = {};      // eventIdx (oder custom ID) → { disabled, firstCast, cooldown, maxCasts, name, requiredCDs, icon, delay }
    var customEvents = [];        // Komplett selbst angelegte Events (nicht aus config)
    var rosterRef = [];
    var firebaseRef = null;
    var cooldownsDB = [];

    // ── Verteilungs-Strategien (pro Boss konfigurierbar, in Firestore gespeichert) ──
    var assignStrategy = {
        spread: false,                // A: Lookahead — bei Knappheit gleichmäßig über Zeit verteilen
        prioritizeCategories: false,  // B: Hochpriore Kategorie zuerst, niedrige weglassen bei Knappheit
        roundRobin: false,            // C: Spieler reihum nutzen statt immer den ersten in Prio-Liste
        preferHeal: false,            // D: Reine Heiler vor Utility-Heals bevorzugen
        strictClassBalance: false     // E: Strikte Klassen-Rotation (nicht gleiche Klasse hintereinander)
    };

    // Round-Robin Counter (wird pro Run zurückgesetzt)
    var _rrCounters = {};

    // ── Helpers ──
    function fmt(sec) {
        var m = Math.floor(Math.abs(sec) / 60);
        var s = Math.floor(Math.abs(sec) % 60);
        return (sec < 0 ? '-' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    function getClassColor(cls) {
        return (window.classColors && window.classColors[(cls || '').toUpperCase()]) || '#FFFFFF';
    }

    // Normalisiert einen Spec-Namen für toleranten Vergleich:
    //   - Kleinschreibung, Whitespace weg
    //   - "1"-Suffix entfernen (Protection1 → protection, Holy1 → holy, ...)
    //   - deutsche/alternative Schreibweisen auf den englischen Kern mappen
    // So matchen Roster-Spec und required-Spec auch bei Format-Unterschieden.
    var _SPEC_ALIASES = {
        'schutz': 'protection', 'vergeltung': 'retribution', 'heilig': 'holy',
        'wiederherstellung': 'restoration', 'verstaerkung': 'enhancement',
        'verstärkung': 'enhancement', 'elementar': 'elemental',
        'disziplin': 'discipline', 'schatten': 'shadow', 'waechter': 'guardian',
        'wächter': 'guardian', 'wildheit': 'feral', 'gleichgewicht': 'balance',
        'blut': 'blood', 'frost': 'frost', 'unheilig': 'unholy',
        'braumeister': 'brewmaster', 'nebelwirker': 'mistweaver', 'windläufer': 'windwalker',
        'windlaeufer': 'windwalker'
    };
    function normalizeSpec(spec) {
        var s = String(spec || '').toLowerCase().trim().replace(/\s+/g, '');
        s = s.replace(/[0-9]+$/, '');        // "protection1" → "protection"
        if (_SPEC_ALIASES[s]) s = _SPEC_ALIASES[s];
        return s;
    }

    function getPlayersOfClass(cls, requiredRole, requiredSpec, useSpecSlots) {
        if (useSpecSlots && window.SlotSystem) {
            var slots = [];
            var mapping = window.SlotSystem.getMapping();
            var byClass = window.SlotSystem.getSlotsByClass();
            var classSlots = byClass[(cls || '').toUpperCase()] || [];
            classSlots.forEach(function(def) {
                var defSpecNorm = normalizeSpec(def.spec);
                var specMatch = true;
                if (requiredSpec && requiredSpec.length > 0) {
                    var specList = Array.isArray(requiredSpec) ? requiredSpec : [requiredSpec];
                    specMatch = specList.some(function(s) { 
                        var reqNorm = normalizeSpec(s);
                        return defSpecNorm.indexOf(reqNorm) !== -1 || reqNorm.indexOf(defSpecNorm) !== -1;
                    });
                }
                if (specMatch) {
                    for (var i = 1; i <= def.maxSlots; i++) {
                        var key = def.prefix + i;
                        if (mapping[key] && mapping[key].trim() !== '') {
                            slots.push(key);
                        }
                    }
                }
            });
            return slots;
        }

        // Immer dynamisch das aktuellste Roster laden
        var currentRoster = window.effectiveRoster || window.rosterData || [];
        return currentRoster.filter(function(p) {
            // 1. Klasse MUSS immer matchen
            if ((p.class || '').toUpperCase() !== (cls || '').toUpperCase()) return false;

            // 2. Spec-Filter hat Vorrang vor Role-Filter
            if (requiredSpec && requiredSpec.length > 0) {
                var playerSpec = p.spec || p.specName || p.specialization || '';
                if (!playerSpec) return true;   // Spieler ohne Spec-Angabe nicht ausschließen
                var specList = Array.isArray(requiredSpec) ? requiredSpec : [requiredSpec];
                var pSpecNorm = normalizeSpec(playerSpec);
                return specList.some(function(s) { return normalizeSpec(s) === pSpecNorm; });
            }

            // 3. Role-Filter (wenn kein Spec-Filter gesetzt)
            if (!requiredRole) return true;
            var roles = p.roles || [];
            var firstRole = (Array.isArray(roles) ? (roles[0] || '') : roles).toString().toLowerCase();
            if (requiredRole === 'heal') return firstRole.indexOf('heal') !== -1;
            if (requiredRole === 'tank') return firstRole.indexOf('tank') !== -1;
            if (requiredRole === 'dps')  {
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
                requiredRole: entry.requiredRole || cat.requiredRole || null,
                requiredSpec: entry.requiredSpec || cat.requiredSpec || null,
                found:       true
            });
        });
        return result;
    }

    // ── Timeline generieren ──
    // Gibt die effektive Event-Liste zurück: config.events + customEvents, mit Overrides angewendet
    function getEffectiveEvents() {
        var result = [];
        // config.events mit Overrides
        (config.events || []).forEach(function(evt, idx) {
            var key = 'cfg_' + idx;
            var ov = eventOverrides[key] || {};
            var isMythic = evt.name && (evt.name.indexOf('(HC)') !== -1 || evt.name.indexOf('(Mythisch)') !== -1 || evt.name.indexOf('(Mythic)') !== -1 || evt.name.indexOf('(M)') !== -1);
            var disabled = ov.disabled !== undefined ? ov.disabled : isMythic;
            if (disabled) return;
            result.push({
                _key:          key,
                _origIdx:      idx,
                _isCustom:     false,
                _hasManualCDs: ov.requiredCDs !== undefined,
                name:          ov.name          !== undefined ? ov.name          : evt.name,
                firstCast:     ov.firstCast     !== undefined ? ov.firstCast     : evt.firstCast,
                cooldown:      ov.cooldown      !== undefined ? ov.cooldown      : (evt.cooldown || 0),
                maxCasts:      ov.maxCasts      !== undefined ? ov.maxCasts      : (evt.maxCasts || 1),
                delay:         ov.delay         !== undefined ? ov.delay         : (evt.delay || 0),
                eventDuration: ov.eventDuration !== undefined ? ov.eventDuration : (evt.eventDuration || 0),
                requiredCDs:   ov.requiredCDs   !== undefined ? ov.requiredCDs.slice() : (evt.requiredCDs ? evt.requiredCDs.slice() : []),
                icon:          ov.icon          !== undefined ? ov.icon          : (evt.icon || ''),
                spellId:       evt.spellId
            });
        });
        // customEvents (komplett vom User angelegt)
        customEvents.forEach(function(evt) {
            var ov = eventOverrides[evt._key] || {};
            if (ov.disabled) return;
            result.push({
                _key:          evt._key,
                _isCustom:     true,
                _hasManualCDs: true,
                name:          evt.name,
                firstCast:     evt.firstCast,
                cooldown:      evt.cooldown || 0,
                maxCasts:      evt.maxCasts || 1,
                delay:         evt.delay || 0,
                eventDuration: evt.eventDuration || 0,
                requiredCDs:   evt.requiredCDs ? evt.requiredCDs.slice() : [],
                icon:          evt.icon || '',
                spellId:       evt.spellId || 0
            });
        });

        // --- STORMLASH & BANNER AUTO-INJECT ---
        var hasEarlyBloodlust = false;
        var hasLateBloodlust = false;
        var bloodlustEventExists = false;
        var bloodlustEvts = [];

        result.forEach(function(evt) {
            if (evt.requiredCDs && evt.requiredCDs.indexOf('bloodlust') !== -1) {
                bloodlustEventExists = true;

                if (!evt._hasManualCDs) {
                    if (evt.requiredCDs.indexOf('stormlash') === -1) evt.requiredCDs.push('stormlash');
                    if (evt.requiredCDs.indexOf('skull_banner') === -1) evt.requiredCDs.push('skull_banner');
                }
                
                if (evt.requiredCDs.indexOf('stormlash') !== -1 || evt.requiredCDs.indexOf('skull_banner') !== -1) {
                    bloodlustEvts.push(evt);
                }

                if (evt.firstCast <= 15) hasEarlyBloodlust = true;
                else hasLateBloodlust = true;
            }
        });

        // 2. Casts für die Bloodlust-Zeitpunkte (10 Sekunden danach)
        bloodlustEvts.forEach(function(blEvt) {
            var ovEntry = eventOverrides[blEvt._key];
            var triggerOv = ovEntry && ovEntry.triggerOverride;
            var blMapEntry = null;
            if (triggerOv && triggerOv.mode === 'trigger' && triggerOv.trigger) {
                blMapEntry = triggerOv.trigger;
            } else {
                blMapEntry = config.triggerMap ? config.triggerMap[blEvt.name] : null;
            }
            var isBlEncStart = false;
            if (typeof blMapEntry === 'string' && blMapEntry.indexOf('ENC_START') !== -1) isBlEncStart = true;
            else if (blMapEntry && typeof blMapEntry === 'object' && blMapEntry.trigger && blMapEntry.trigger.indexOf('ENC_START') !== -1) isBlEncStart = true;

            var followupDelay = blEvt.delay || 0;
            if (!isBlEncStart) {
                followupDelay += 10;
            }

            result.push({
                _key: 'auto_sl_banner_followup_' + blEvt.firstCast,
                _isCustom: true,
                _isFollowUp: true,
                name: 'SL/Banner (Folgecast)',
                firstCast: blEvt.firstCast + 10,
                cooldown: 0,
                maxCasts: 1,
                delay: followupDelay,
                eventDuration: 0,
                requiredCDs: ['stormlash', 'skull_banner'],
                icon: '⚔️',
                spellId: 0,
                _sourceTriggerMap: blMapEntry
            });
        });

        if (bloodlustEventExists && hasLateBloodlust && !hasEarlyBloodlust) {
            var startEvt = result.find(function(e) { return e.name === 'Kampfbeginn (SL/Banner)'; });
            if (!startEvt) {
                var encStartObj = null;
                if (config.triggerMap) {
                    for (var key in config.triggerMap) {
                        var entry = config.triggerMap[key];
                        if (typeof entry === 'string' && entry.indexOf('ENC_START') !== -1) {
                            encStartObj = entry; break;
                        } else if (entry && typeof entry === 'object' && entry.trigger && entry.trigger.indexOf('ENC_START') !== -1) {
                            encStartObj = entry.trigger; break;
                        }
                    }
                }
                if (!encStartObj) {
                    var trgSelects = document.querySelectorAll('select.assignment-select[data-assignment-id$="-trigger"]');
                    if (trgSelects.length > 0) {
                        var encOption = Array.from(trgSelects[0].options).find(function(o) { return o.value.indexOf('ENC_START') !== -1; });
                        if (encOption) encStartObj = encOption.value;
                    }
                    if (!encStartObj && config.triggerMap) {
                        for (var k in config.triggerMap) {
                            var entry = config.triggerMap[k];
                            var val = (typeof entry === 'string') ? entry : (entry && entry.trigger);
                            if (val && typeof val === 'string') {
                                encStartObj = val.split('_')[0] + '_ENC_START';
                                break;
                            }
                        }
                    }
                }
                result.push({
                    _key: 'auto_start_sl_banner_1',
                    _isCustom: true,
                    name: 'Kampfbeginn (SL/Banner)',
                    firstCast: 0,
                    cooldown: 0,
                    maxCasts: 1,
                    delay: 0,
                    eventDuration: 0,
                    requiredCDs: ['stormlash', 'skull_banner'],
                    icon: '⚔️',
                    spellId: 0,
                    _sourceTriggerMap: encStartObj
                });
                result.push({
                    _key: 'auto_start_sl_banner_2',
                    _isCustom: true,
                    name: 'Kampfbeginn (SL/Banner) Folge',
                    firstCast: 10,
                    cooldown: 0,
                    maxCasts: 1,
                    delay: 0,
                    eventDuration: 0,
                    requiredCDs: ['stormlash', 'skull_banner'],
                    icon: '⚔️',
                    spellId: 0,
                    _sourceTriggerMap: encStartObj
                });
            }
        }

        return result;
    }

    function generateTimeline() {
        var timeline = [];
        var effectiveEvents = getEffectiveEvents();
        effectiveEvents.forEach(function(event, eventIdx) {
            var casts = event.maxCasts || 1;
            for (var c = 0; c < casts; c++) {
                var absTime = event.firstCast + (c * (event.cooldown || 0));
                if (event.cooldown === 0 && c > 0) break;
                timeline.push({
                    eventIdx:      eventIdx,
                    eventKey:      event._key,
                    castNum:       c + 1,
                    absTime:       absTime,
                    delay:         event.delay || 0,
                    eventName:     event.name,
                    eventDuration: event.eventDuration || 0,
                    icon:          event.icon || '',
                    requiredCDs:   event.requiredCDs,
                    slots:         {},
                    _sourceTriggerMap: event._sourceTriggerMap
                });
            }
        });
        timeline.sort(function(a, b) { return a.absTime - b.absTime; });
        return timeline;
    }

    function getUniqueCategoryKeys() {
        var keys = [];
        var effectiveEvents = getEffectiveEvents();
        effectiveEvents.forEach(function(e) {
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
        var lastClassUsed = {}; // catKey -> dbClass

        function isAvailable(player, dbName, atTime) {
            var key = player + '::' + dbName;
            return !usedUntil[key] || atTime >= usedUntil[key];
        }
        function markUsed(player, dbName, cdSec, atTime) {
            usedUntil[player + '::' + dbName] = atTime + cdSec;
        }

        var allCatKeys = getUniqueCategoryKeys();

        // ──────────────────────────────────────────────────────────────
        // STRATEGIE A — SPREAD-MASKE
        // Vor dem Verteilen für jedes (Event-Name, Kategorie)-Paar prüfen:
        // Wie viele Casts gibt es vs. wie viele Spieler stehen zur Verfügung?
        // Wenn Casts > Capacity → eine Spread-Maske bauen, die nur jeden
        // n-ten Cast als "auto-fill" markiert. Lücken werden gleichmäßig
        // über die Zeit verteilt statt am Ende geballt.
        //
        // capacity = Anzahl Spieler die DIESEN Spell jemals casten könnten
        //   × floor(eventSpanInSec / minPlayerCooldown) + 1
        // ──────────────────────────────────────────────────────────────
        var spreadAllow = {};   // eventIdx + '-' + catKey + '-' + castNum → true/false
        if (assignStrategy.spread) {
            // Events nach Name+Kategorie gruppieren
            var groups = {};
            timeline.forEach(function(row) {
                row.requiredCDs.forEach(function(catKey) {
                    var gKey = row.eventName + '||' + catKey;
                    if (!groups[gKey]) groups[gKey] = [];
                    groups[gKey].push(row);
                });
            });

            Object.keys(groups).forEach(function(gKey) {
                var rows = groups[gKey];
                if (rows.length <= 1) {
                    rows.forEach(function(r) {
                        spreadAllow[r.eventIdx + '-' + r.castNum + '-' + r._catKey] = true;
                    });
                    return;
                }
                var parts = gKey.split('||');
                var catKey = parts[1];
                var spells = resolveCategory(catKey);

                // Capacity = wieviele verschiedene Player+Spell Kombinationen verfügbar?
                var totalPlayers = 0;
                spells.forEach(function(spell) {
                    totalPlayers += getPlayersOfClass(spell.dbClass, spell.requiredRole, spell.requiredSpec).length;
                });
                if (totalPlayers === 0) return;

                // Wie oft kann jeder Spieler im Event-Span casten?
                var minCd = spells.length ? Math.min.apply(null, spells.map(function(s) { return s.cooldownSec || 180; })) : 180;
                var firstT = rows[0].absTime;
                var lastT = rows[rows.length - 1].absTime;
                var span = lastT - firstT;
                var castsPerPlayer = 1 + Math.floor(span / minCd);
                var capacity = Math.max(1, totalPlayers * castsPerPlayer);

                if (capacity >= rows.length) {
                    // Alles abgedeckt → jeder Cast erlaubt
                    rows.forEach(function(r) {
                        spreadAllow[r.eventIdx + '-' + r.castNum + '-' + catKey] = true;
                    });
                } else {
                    // Knappheit → genau "capacity" Casts gleichmäßig markieren
                    var step = rows.length / capacity;
                    var marked = {};
                    for (var i = 0; i < capacity; i++) {
                        var idx = Math.round(i * step);
                        if (idx >= rows.length) idx = rows.length - 1;
                        marked[idx] = true;
                    }
                    rows.forEach(function(r, ri) {
                        spreadAllow[r.eventIdx + '-' + r.castNum + '-' + catKey] =
                            !!marked[ri];
                    });
                }
            });
        }

        // ──────────────────────────────────────────────────────────────
        // STRATEGIE B — KATEGORIEN-PRIORISIERUNG
        // Innerhalb eines Events werden Kategorien in der Reihenfolge
        // ihres requiredCDs-Arrays abgearbeitet (Index 0 = höchste Prio).
        // Wenn niedrigere Kategorien keine Slots mehr finden, bleiben
        // sie leer — statt einen wichtigen Spell für eine unwichtigere
        // Kategorie zu verbrennen.
        //
        // Greift implizit, weil wir die Kategorie-Schleife durch
        // row.requiredCDs ersetzen (statt allCatKeys). Außerdem wird
        // bei eingeschaltetem prioritizeCategories die Player-Capacity
        // pro Event budgetiert.
        // ──────────────────────────────────────────────────────────────

        // ──────────────────────────────────────────────────────────────
        // STRATEGIE C — ROUND-ROBIN
        // Counter pro (Spell+Spieler-Klasse-Kombo) zurücksetzen, damit
        // wir Spieler-Listen rotieren können statt immer Index 0 zu nehmen.
        // ──────────────────────────────────────────────────────────────
        _rrCounters = {};

        function pickPlayer(players, spell, atTime) {
            // Liefert ersten verfügbaren Spieler aus der Liste,
            // unter Berücksichtigung von Round-Robin wenn aktiv.
            if (!players.length) return null;

            if (assignStrategy.roundRobin) {
                var rrKey = spell.dbName + '::' + spell.dbClass;
                var start = _rrCounters[rrKey] || 0;
                for (var k = 0; k < players.length; k++) {
                    var idx = (start + k) % players.length;
                    if (isAvailable(players[idx], spell.dbName, atTime)) {
                        _rrCounters[rrKey] = (idx + 1) % players.length;
                        return players[idx];
                    }
                }
                return null;
            }

            for (var i = 0; i < players.length; i++) {
                if (isAvailable(players[i], spell.dbName, atTime)) return players[i];
            }
            return null;
        }

        // ──────────────────────────────────────────────────────────────
        // HAUPT-SCHLEIFE
        // ──────────────────────────────────────────────────────────────
        timeline.forEach(function(row) {
            // Alle Kategorien initial mit leeren Slots vorbelegen,
            // damit die UI-Spalten stimmen.
            allCatKeys.forEach(function(catKey) {
                if (!row.slots[catKey]) row.slots[catKey] = {};
            });

            // Reihenfolge: bei prioritizeCategories die Boss-Reihenfolge
            // aus requiredCDs verwenden, sonst die globale Liste.
            var iterCats = assignStrategy.prioritizeCategories
                ? (row.requiredCDs || []).slice()
                : allCatKeys;

            iterCats.forEach(function(catKey) {
                var isRequired = (row.requiredCDs || []).indexOf(catKey) !== -1;
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

                // Spread-Check: wenn diese (Event, Kategorie, Cast) durch
                // die Spread-Maske blockiert ist → leerer "geplante Lücke"-Slot
                if (assignStrategy.spread) {
                    row._catKey = catKey;  // tmp für Spread-Lookup
                    var allow = spreadAllow[row.eventIdx + '-' + row.castNum + '-' + catKey];
                    if (allow === false) {
                        row.slots[catKey] = { player: null, dbName: null, auto: true, spreadGap: true };
                        return;
                    }
                }

                var spells = resolveCategory(catKey);

                if (assignStrategy.preferHeal) {
                    spells.sort(function(a, b) {
                        var aHeal = (a.requiredRole === 'healer') ? 1 : 0;
                        var bHeal = (b.requiredRole === 'healer') ? 1 : 0;
                        return bHeal - aHeal;
                    });
                }

                if (assignStrategy.strictClassBalance && lastClassUsed[catKey]) {
                    var lastClass = lastClassUsed[catKey];
                    var diffClass = [];
                    var sameClass = [];
                    spells.forEach(function(s) {
                        if (s.dbClass === lastClass) sameClass.push(s);
                        else diffClass.push(s);
                    });
                    spells = diffClass.concat(sameClass);
                }

                var assigned = false;
                for (var si = 0; si < spells.length && !assigned; si++) {
                    var spell = spells[si];
                    var players = getPlayersOfClass(spell.dbClass, spell.requiredRole, spell.requiredSpec, catKey === 'stormlash' || catKey === 'skull_banner');
                    var picked = pickPlayer(players, spell, row.absTime);
                    if (picked) {
                        row.slots[catKey] = {
                            player: picked, dbName: spell.dbName,
                            dbClass: spell.dbClass, spellId: spell.spellId,
                            cooldownSec: spell.cooldownSec,
                            durationSec: spell.durationSec,
                            auto: true
                        };
                        markUsed(picked, spell.dbName, spell.cooldownSec, row.absTime);
                        lastClassUsed[catKey] = spell.dbClass;
                        assigned = true;
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

                // Spread-Gap: geplante Lücke durch Strategie A (Spread)
                if (slot && slot.spreadGap) {
                    return '<td class="py-1 px-1 bg-cyan-900/15 border border-cyan-700/30" title="Geplante Lücke (Spread-Strategie): hier wurde absichtlich kein Spieler eingeplant, um die verfügbaren CDs über die Zeit zu strecken.">'
                        + '<select class="auto-plan-select w-full bg-transparent text-[11px] border-none outline-none cursor-pointer" data-row="' + rowIdx + '" data-cat="' + catKey + '" style="color:#67e8f9;">'
                        + '<option value="" selected>~ Spread-Lücke</option>'
                        + '<option value="__SKIP__" style="color:#ef4444;">✖ Kein CD nötig</option>'
                        + options + '</select></td>';
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
            var tooltipStr = "";
            var mapEntry = config.triggerMap && config.triggerMap[row.eventName];
            if (typeof mapEntry === 'string') tooltipStr = mapEntry;
            else if (mapEntry && mapEntry.trigger) tooltipStr = mapEntry.trigger;

            return '<tr class="hover:bg-slate-800/30 transition-colors ' + (isNew ? 'border-t border-slate-600' : 'border-t border-slate-800/40') + '">'
                + '<td class="py-1 px-1 text-center text-sm">' + row.icon + '</td>'
                + '<td class="py-1 px-2 font-mono text-gray-300" title="Absolute Kampfzeit">' + fmt(row.absTime) + '</td>'
                + '<td class="py-1 px-2 ' + (isNew ? 'text-gray-200 font-medium' : 'text-gray-500') + '" title="' + tooltipStr + '">' + (isNew ? row.eventName : '↳') + durLabel + '</td>'
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
        var html = '';

        function renderSection(isSpec) {
            var sectionHtml = '';
            var recommended = resolveCategory(catKey);

            if (recommended.length > 0) {
                var recHtml = '';
                var byClassR = {};
                recommended.forEach(function(s) {
                    if (!byClassR[s.dbClass]) byClassR[s.dbClass] = [];
                    if (!byClassR[s.dbClass].some(function(x) { return x.dbName === s.dbName; })) byClassR[s.dbClass].push(s);
                });
                Object.entries(byClassR).forEach(function(entry) {
                    var cls = entry[0], spells = entry[1];
                    var color = getClassColor(cls);
                    var anyRendered = false;
                    spells.forEach(function(s) {
                        var players = getPlayersOfClass(cls, s.requiredRole, s.requiredSpec, isSpec);
                        if (!players.length) return;
                        if (!anyRendered) {
                            recHtml += '<option disabled style="font-weight:bold; color:' + color + '; background:#1a202c;">── ' + cls + ' ──</option>';
                            anyRendered = true;
                        }
                        var dur = s.durationSec ? ' [' + s.durationSec + 's]' : '';
                        var specMark = '';
                        if (s.requiredSpec) {
                            var specs = Array.isArray(s.requiredSpec) ? s.requiredSpec : [s.requiredSpec];
                            var labels = specs.map(function(v) { return getSpecLabel(v).replace(/\s*\([^)]+\)/, ''); });
                            specMark = ' [' + labels.join('/') + ']';
                        } else if (s.requiredRole) {
                            specMark = ' (' + s.requiredRole + ')';
                        }
                        players.forEach(function(p) {
                            recHtml += '<option value="' + p + '::' + s.dbName + '" style="color:' + color + ';">★ ' + p + ' → ' + s.dbName + dur + specMark + '</option>';
                        });
                    });
                });
                if (recHtml) {
                    sectionHtml += '<option disabled style="font-weight:bold; color:' + (isSpec ? '#a855f7' : '#fbbf24') + '; background:#1a202c;">═══ ' + (isSpec ? 'SPEC SLOTS (EMPFOHLEN)' : 'EMPFOHLEN') + ' ═══</option>' + recHtml;
                }
            }

            var allCDs = cooldownsDB.filter(function(cd) {
                return cd.name && cd.spellId && cd.name.indexOf('---') !== 0 && cd.name.indexOf('-- ') !== 0 && cd.type !== 'Personal';
            });
            var byClassA = {};
            allCDs.forEach(function(cd) {
                var cls = (cd.class || 'UNKNOWN').toUpperCase();
                if (!byClassA[cls]) byClassA[cls] = [];
                if (!byClassA[cls].some(function(x) { return x.name === cd.name; })) byClassA[cls].push(cd);
            });

            if (Object.keys(byClassA).length > 0) {
                var allHtml = '';
                Object.entries(byClassA).forEach(function(entry) {
                    var cls = entry[0], cds = entry[1];
                    var players = getPlayersOfClass(cls, null, null, isSpec);
                    if (!players.length) return;
                    var color = getClassColor(cls);
                    allHtml += '<option disabled style="font-weight:bold; color:' + color + '; background:#1a202c; opacity:0.7;">── ' + cls + ' ──</option>';
                    players.forEach(function(p) {
                        cds.forEach(function(cd) {
                            allHtml += '<option value="' + p + '::' + cd.name + '" style="color:' + color + '; opacity:0.8;">' + p + ' → ' + cd.name + '</option>';
                        });
                    });
                });
                if (allHtml) {
                    sectionHtml += '<option disabled style="font-weight:bold; color:#64748b; background:#1a202c;">═══ ' + (isSpec ? 'SPEC SLOTS (ALLE CDs)' : 'ALLE CDs') + ' ═══</option>' + allHtml;
                }
            }

            return sectionHtml;
        }

        html += renderSection(false); // First render real players
        html += renderSection(true);  // Then append Spec Slots

        return html;
    }

    // Markiert die Auto-Assign-Vorschau als veraltet (nach Event-Änderungen),
    // ohne sie neu zu berechnen. Wird durch "Auto-Assign" wieder aufgehoben.
    function markPreviewStale() {
        var btn = document.getElementById('btn-auto-assign');
        if (btn && !btn.dataset._origText) {
            btn.dataset._origText = btn.innerHTML;
        }
        if (btn) {
            btn.classList.add('animate-pulse');
            btn.style.boxShadow = '0 0 0 2px #f59e0b';
            btn.title = 'Events wurden geändert — klicke Auto-Assign, um die Vorschau zu aktualisieren.';
        }
        updateStatus('Events geändert — "Auto-Assign" klicken, um die Vorschau neu zu berechnen.');
    }

    function clearPreviewStale() {
        var btn = document.getElementById('btn-auto-assign');
        if (btn) {
            btn.classList.remove('animate-pulse');
            btn.style.boxShadow = '';
            btn.title = '';
        }
    }

    function runAutoAssign() {

        rosterRef = window.effectiveRoster || window.rosterData || [];

        var timeline = generateTimeline();
        assignments = autoAssign(timeline);
        renderTimeline(assignments);
        renderEventManager();
        clearPreviewStale();
        // Manager-Schutz erneut anwenden (neu erzeugte Felder)
        if (typeof window._autoPlannerApplyProtection === 'function') {
            window._autoPlannerApplyProtection();
        }
    }

    // ══════════════════════════════════════════════════════════════
    // EVENT MANAGER — Events deaktivieren, editieren, hinzufügen
    // ══════════════════════════════════════════════════════════════

    function renderEventManager() {
        var container = document.getElementById('auto-planner-events');
        if (!container) return;

        // Einmalig Styles
        if (!document.getElementById('event-mgr-styles')) {
            var st = document.createElement('style');
            st.id = 'event-mgr-styles';
            st.textContent =
                '#auto-planner-events .evt-row { display:grid; grid-template-columns: 30px 32px 80px 1fr 60px 70px 70px 1fr 90px 60px; gap:6px; align-items:center; padding:4px 6px; border-radius:4px; font-size:11px; }' +
                '#auto-planner-events .evt-row.disabled { opacity:0.35; }' +
                '#auto-planner-events .evt-row:hover { background:rgba(51,65,85,0.3); }' +
                '#auto-planner-events .evt-row input[type="number"], #auto-planner-events .evt-row input[type="text"] { background:#0f172a; color:#e5e7eb; border:1px solid #334155; border-radius:3px; padding:2px 4px; font-size:10px; }' +
                '#auto-planner-events .evt-row input[type="number"] { width:100%; text-align:right; }' +
                '#auto-planner-events .evt-cat-btn, #auto-planner-events .evt-trg-btn { background:#0f172a; color:#cbd5e1; border:1px solid #334155; border-radius:3px; padding:2px 6px; font-size:10px; cursor:pointer; text-align:left; width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }' +
                '#auto-planner-events .evt-cat-btn:hover, #auto-planner-events .evt-trg-btn:hover { background:#1e293b; }' +
                '#auto-planner-events .evt-trg-btn.mode-hp { border-color:#dc2626; color:#fca5a5; }' +
                '#auto-planner-events .evt-trg-btn.mode-cast { border-color:#0284c7; color:#7dd3fc; }' +
                '#auto-planner-events .evt-trg-btn.mode-auto { border-color:#334155; color:#94a3b8; }' +
                '#auto-planner-events .evt-header { font-size:9px; text-transform:uppercase; color:#94a3b8; letter-spacing:0.05em; border-bottom:1px solid #334155; padding-bottom:4px; margin-bottom:2px; }';
            document.head.appendChild(st);
        }

        // Für Anzeige brauchen wir alle Events (auch deaktivierte)
        var allRows = [];
        (config.events || []).forEach(function(evt, idx) {
            var key = 'cfg_' + idx;
            var ov = eventOverrides[key] || {};
            var isMythic = evt.name && (evt.name.indexOf('(HC)') !== -1 || evt.name.indexOf('(Mythisch)') !== -1 || evt.name.indexOf('(Mythic)') !== -1 || evt.name.indexOf('(M)') !== -1);
            var disabled = ov.disabled !== undefined ? ov.disabled : isMythic;
            allRows.push({
                _key: key, _isCustom: false,
                disabled:      !!disabled,
                name:          ov.name          !== undefined ? ov.name          : evt.name,
                firstCast:     ov.firstCast     !== undefined ? ov.firstCast     : evt.firstCast,
                cooldown:      ov.cooldown      !== undefined ? ov.cooldown      : (evt.cooldown || 0),
                maxCasts:      ov.maxCasts      !== undefined ? ov.maxCasts      : (evt.maxCasts || 1),
                requiredCDs:   ov.requiredCDs   !== undefined ? ov.requiredCDs   : (evt.requiredCDs || []),
                icon:          ov.icon          !== undefined ? ov.icon          : (evt.icon || ''),
                triggerOverride: ov.triggerOverride
            });
        });
        customEvents.forEach(function(evt) {
            var ov = eventOverrides[evt._key] || {};
            allRows.push({
                _key: evt._key, _isCustom: true,
                disabled:      !!ov.disabled,
                name:          evt.name, firstCast: evt.firstCast, cooldown: evt.cooldown || 0,
                maxCasts:      evt.maxCasts || 1, requiredCDs: evt.requiredCDs || [], icon: evt.icon || '',
                triggerOverride: ov.triggerOverride
            });
        });

        var header = '<div class="evt-row evt-header"><span></span><span>Ikon</span><span>Zeit</span><span>Name</span><span title="Cooldown zwischen Casts">CD</span><span title="Anzahl Casts">Casts</span><span title="Verzögerung">Delay</span><span>Kategorien</span><span title="Trigger-Modus für Export">Trigger</span><span></span></div>';

        var html = allRows.map(function(r) {
            var catLabels = (r.requiredCDs || []).map(function(k) {
                var c = categories[k];
                return c ? c.shortName : k;
            }).join(', ');
            if (!catLabels) catLabels = '—';

            var customBadge = r._isCustom ? '<span class="text-[8px] text-emerald-400" title="Selbst angelegt">★</span>' : '';

            // Trigger-Button: zeigt aktuellen Modus
            var tMode = 'auto', tLabel = 'Auto';
            if (r.triggerOverride) {
                tMode = r.triggerOverride.mode || 'auto';
                if (tMode === 'hp' && r.triggerOverride.percent !== undefined) {
                    tLabel = 'HP ' + r.triggerOverride.percent + '%';
                } else if (tMode === 'cast') {
                    tLabel = 'Cast #';
                } else {
                    tLabel = 'Auto';
                }
            }

            return '<div class="evt-row ' + (r.disabled ? 'disabled' : '') + '" data-key="' + r._key + '">'
                + '<input type="checkbox" class="evt-enabled" data-key="' + r._key + '"' + (r.disabled ? '' : ' checked') + ' title="Aktiv">'
                + '<input type="text" class="evt-icon" data-key="' + r._key + '" value="' + (r.icon || '') + '" style="width:100%;text-align:center;padding:2px;" title="Emoji/Icon">'
                + '<input type="number" class="evt-first" data-key="' + r._key + '" value="' + r.firstCast + '" step="5" title="Erste Zeit (Sekunden)">'
                + '<input type="text" class="evt-name" data-key="' + r._key + '" value="' + (r.name || '').replace(/"/g, '&quot;') + '" placeholder="Event-Name">'
                + '<input type="number" class="evt-cd" data-key="' + r._key + '" value="' + r.cooldown + '" step="1" title="Cooldown zwischen Casts">'
                + '<input type="number" class="evt-max" data-key="' + r._key + '" value="' + r.maxCasts + '" min="1" step="1" title="Anzahl Casts">'
                + '<input type="number" class="evt-delay" data-key="' + r._key + '" value="' + ((eventOverrides[r._key] && eventOverrides[r._key].delay !== undefined) ? eventOverrides[r._key].delay : (r._isCustom ? (customEvents.find(function(c){return c._key===r._key;}) || {}).delay || 0 : ((config.events[parseInt(r._key.replace("cfg_", ""))] || {}).delay || 0))) + '" step="1" title="Verzögerung (neg=vorher)">'
                + '<button class="evt-cat-btn" data-key="' + r._key + '" title="Klicken um Kategorien zu ändern">' + catLabels + ' ' + customBadge + '</button>'
                + '<button class="evt-trg-btn mode-' + tMode + '" data-key="' + r._key + '" title="Trigger-Modus für Export anpassen">' + tLabel + '</button>'
                + (r._isCustom ? '<button class="text-red-400 hover:text-red-300 text-xs evt-delete" data-key="' + r._key + '" title="Löschen">🗑</button>' : '<span class="text-gray-600 text-[9px] text-center" title="Basis-Event aus Config">cfg</span>')
                + '</div>';
        }).join('');

        container.innerHTML = '<div class="flex items-center justify-between mb-2">'
            + '<div class="text-xs font-bold text-gray-300">📋 Events (' + allRows.filter(function(r){return !r.disabled;}).length + ' aktiv / ' + allRows.length + ' gesamt)</div>'
            + '<button id="btn-add-event" class="bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] py-1 px-2 rounded border border-emerald-500">+ Event hinzufügen</button>'
            + '</div>'
            + header + html;

        attachEventManagerListeners();
    }

    function attachEventManagerListeners() {
        // Aktiv-Toggle
        document.querySelectorAll('.evt-enabled').forEach(function(cb) {
            cb.addEventListener('change', function(e) {
                var key = e.target.dataset.key;
                if (!eventOverrides[key]) eventOverrides[key] = {};
                eventOverrides[key].disabled = !e.target.checked;
                renderEventManager();
                markPreviewStale();
            });
        });

        // Icon
        document.querySelectorAll('.evt-icon').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                setOverride(e.target.dataset.key, 'icon', e.target.value);
            });
        });

        // FirstCast
        document.querySelectorAll('.evt-first').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                setOverride(e.target.dataset.key, 'firstCast', parseFloat(e.target.value) || 0);
            });
        });

        // Name
        document.querySelectorAll('.evt-name').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                setOverride(e.target.dataset.key, 'name', e.target.value);
            });
        });

        // Cooldown
        document.querySelectorAll('.evt-cd').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                setOverride(e.target.dataset.key, 'cooldown', parseFloat(e.target.value) || 0);
            });
        });

        // MaxCasts
        document.querySelectorAll('.evt-max').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                setOverride(e.target.dataset.key, 'maxCasts', parseInt(e.target.value) || 1);
            });
        });

        // Delay
        document.querySelectorAll('.evt-delay').forEach(function(inp) {
            inp.addEventListener('change', function(e) {
                setOverride(e.target.dataset.key, 'delay', parseFloat(e.target.value) || 0);
            });
        });

        // Kategorien-Button → Modal
        document.querySelectorAll('.evt-cat-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                openEventCategoryPicker(e.currentTarget.dataset.key);
            });
        });

        // Trigger-Button → Trigger-Modus-Modal
        document.querySelectorAll('.evt-trg-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                openEventTriggerPicker(e.currentTarget.dataset.key);
            });
        });

        // Delete (nur Custom)
        document.querySelectorAll('.evt-delete').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                var key = e.currentTarget.dataset.key;
                if (!confirm('Event wirklich löschen?')) return;
                customEvents = customEvents.filter(function(evt) { return evt._key !== key; });
                delete eventOverrides[key];
                renderEventManager();
                markPreviewStale();
            });
        });

        // Add Event
        var addBtn = document.getElementById('btn-add-event');
        if (addBtn) {
            addBtn.addEventListener('click', function() {
                var key = 'custom_' + Date.now();
                customEvents.push({
                    _key: key,
                    name: 'Neues Event',
                    icon: '⚡',
                    firstCast: 30,
                    cooldown: 0,
                    maxCasts: 1,
                    delay: 0,
                    eventDuration: 0,
                    requiredCDs: []
                });
                renderEventManager();
                markPreviewStale();
            });
        }
    }

    function setOverride(key, field, value) {
        // Bei Custom-Events direkt in customEvents schreiben statt in eventOverrides
        var custom = customEvents.find(function(e) { return e._key === key; });
        if (custom) {
            custom[field] = value;
        } else {
            if (!eventOverrides[key]) eventOverrides[key] = {};
            eventOverrides[key][field] = value;
        }
        // Event-Änderungen NICHT mehr sofort in die Vorschau verteilen — erst auf
        // "Auto-Assign". Nur den Event-Manager neu zeichnen und Vorschau als veraltet markieren.
        renderEventManager();
        markPreviewStale();
    }

    // ── Trigger-Picker pro Event ──
    // Erlaubt dem User zu wählen: Auto (triggerMap), Cast-Counter (#1..#n) oder HP-Prozent (NPC+%)
    function openEventTriggerPicker(eventKey) {
        var currentOverride = (eventOverrides[eventKey] && eventOverrides[eventKey].triggerOverride) || null;
        var currentMode = (currentOverride && currentOverride.mode) || 'auto';
        var currentPercent = (currentOverride && currentOverride.percent !== undefined) ? currentOverride.percent : 65;
        var currentNpc = (currentOverride && currentOverride.npc) || '';
        var currentTrigger = (currentOverride && currentOverride.trigger) || '';

        // Aus Boss-HTML die verfügbaren Trigger und NPCs lesen (falls vorhanden)
        var triggerOptions = [];
        var npcOptions = [];
        try {
            // globale Variablen die die Boss-HTML gesetzt hat
            if (typeof TRIGGER_OPTIONS !== 'undefined') triggerOptions = TRIGGER_OPTIONS;
            if (typeof NPC_OPTIONS !== 'undefined') npcOptions = NPC_OPTIONS;
        } catch (e) { /* ignore */ }
        // Fallback: Versuche über window (falls in globalem Scope)
        if (!triggerOptions.length && window.TRIGGER_OPTIONS) triggerOptions = window.TRIGGER_OPTIONS;
        if (!npcOptions.length && window.NPC_OPTIONS) npcOptions = window.NPC_OPTIONS;
        
        // Letzter Fallback: Aus dem DOM extrahieren (vom CD-Planer-Container der Trigger-Selects hat)
        if (!triggerOptions.length) {
            var anyTriggerSelect = document.querySelector('select[data-assignment-id$="-trigger"]');
            if (anyTriggerSelect) {
                triggerOptions = Array.from(anyTriggerSelect.options)
                    .filter(function(o) { return o.value; })
                    .map(function(o) { return { val: o.value, text: o.textContent }; });
            }
        }
        if (!npcOptions.length) {
            var anyNpcSelect = document.querySelector('select[data-assignment-id$="-npc"]');
            var anyNpcDatalist = document.querySelector('datalist[id$="-npc-list"]');
            if (anyNpcSelect) {
                npcOptions = Array.from(anyNpcSelect.options)
                    .filter(function(o) { return o.value; })
                    .map(function(o) { return o.value; });
            } else if (anyNpcDatalist) {
                npcOptions = Array.from(anyNpcDatalist.options)
                    .filter(function(o) { return o.value; })
                    .map(function(o) { return o.value; });
            }
        }

        // HEALTH-Trigger aus den Options filtern (nur der mit "HEALTH" im Val)
        var healthTrigger = triggerOptions.find(function(t) { return t.val && t.val.indexOf('HEALTH') !== -1; });

        // Overlay
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';
        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:520px;width:90%;';

        // Trigger-Auswahl (alle verfügbaren Trigger aus Boss-HTML, sofern vorhanden)
        var triggerDropdown = '';
        if (triggerOptions.length) {
            triggerDropdown = '<select id="trg-pick-trigger" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm">'
                + '<option value="">— Aus triggerMap (Default) —</option>'
                + triggerOptions.map(function(t) {
                    return '<option value="' + t.val + '"' + (currentTrigger === t.val ? ' selected' : '') + ' title="' + t.val + '">' + t.text + '</option>';
                }).join('')
                + '</select>';
        }

        // NPC-Dropdown (nur wenn HEALTH-Trigger)
        var npcDropdown = '';
        if (npcOptions.length) {
            npcDropdown = '<select id="trg-pick-npc" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm">'
                + '<option value="">— NPC wählen —</option>'
                + npcOptions.map(function(n) {
                    return '<option value="' + n + '"' + (currentNpc === n ? ' selected' : '') + '>' + n + '</option>';
                }).join('')
                + '</select>';
        }

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-1">Trigger-Modus</h4>'
            + '<div class="text-xs text-gray-400 mb-4">Wie soll dieses Event beim Export in den CD-Planer geschrieben werden?</div>'

            + '<div class="space-y-3 mb-4">'

            // Modus: Auto
            + '<label class="block p-3 bg-slate-900/50 rounded border border-slate-700 cursor-pointer hover:border-slate-500">'
            +   '<div class="flex items-start gap-2">'
            +     '<input type="radio" name="trg-mode" value="auto" class="mt-1"' + (currentMode === 'auto' ? ' checked' : '') + '>'
            +     '<div class="flex-1">'
            +       '<div class="text-sm font-bold text-gray-200">Auto (aus triggerMap)</div>'
            +       '<div class="text-[10px] text-gray-500">Nutzt die Standard-Zuordnung aus der Boss-Config</div>'
            +     '</div>'
            +   '</div>'
            + '</label>'

            // Modus: Cast-Counter
            + '<label class="block p-3 bg-slate-900/50 rounded border border-slate-700 cursor-pointer hover:border-slate-500">'
            +   '<div class="flex items-start gap-2">'
            +     '<input type="radio" name="trg-mode" value="cast" class="mt-1"' + (currentMode === 'cast' ? ' checked' : '') + '>'
            +     '<div class="flex-1">'
            +       '<div class="text-sm font-bold text-sky-300">Cast-Counter (#1, #2, #3...)</div>'
            +       '<div class="text-[10px] text-gray-500 mb-2">Condition-Feld wird die fortlaufende Cast-Nummer</div>'
            +       '<div class="text-[10px] text-gray-400 mb-1">Trigger-Typ im Planer (leer = aus triggerMap):</div>'
            +       (triggerDropdown || '<input type="text" id="trg-pick-trigger" value="' + (currentTrigger || '').replace(/"/g, '&quot;') + '" placeholder="z.B. SHAPRIDE_BANISHMENT" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm font-mono">')
            +     '</div>'
            +   '</div>'
            + '</label>'

            // Modus: HP-Prozent
            + '<label class="block p-3 bg-slate-900/50 rounded border border-slate-700 cursor-pointer hover:border-slate-500">'
            +   '<div class="flex items-start gap-2">'
            +     '<input type="radio" name="trg-mode" value="hp" class="mt-1"' + (currentMode === 'hp' ? ' checked' : '') + '>'
            +     '<div class="flex-1">'
            +       '<div class="text-sm font-bold text-red-300">HP-Prozent</div>'
            +       '<div class="text-[10px] text-gray-500 mb-2">Condition wird der HP-%-Wert, NPC wird ausgewählt</div>'
            +       '<div class="grid grid-cols-2 gap-2">'
            +         '<div><label class="text-[10px] text-gray-400">Prozent</label><input type="number" id="trg-pick-percent" value="' + currentPercent + '" min="1" max="100" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm"></label></div>'
            +         '<div><label class="text-[10px] text-gray-400">NPC</label>' + (npcDropdown || '<input type="text" id="trg-pick-npc" value="' + currentNpc + '" placeholder="NPC-Name" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm">') + '</div>'
            +       '</div>'
            +     '</div>'
            +   '</div>'
            + '</label>'

            + '</div>'

            + '<div class="flex justify-end gap-2">'
            +   '<button id="trg-pick-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            +   '<button id="trg-pick-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector('#trg-pick-save').addEventListener('click', function() {
            var mode = modal.querySelector('input[name="trg-mode"]:checked').value;
            if (mode === 'auto') {
                // Override löschen
                if (eventOverrides[eventKey]) delete eventOverrides[eventKey].triggerOverride;
            } else {
                var ov = { mode: mode };
                if (mode === 'hp') {
                    var pEl = modal.querySelector('#trg-pick-percent');
                    var nEl = modal.querySelector('#trg-pick-npc');
                    ov.percent = parseInt(pEl.value) || 65;
                    ov.npc = nEl ? nEl.value : '';
                } else if (mode === 'cast') {
                    var tEl = modal.querySelector('#trg-pick-trigger');
                    if (tEl && tEl.value) ov.trigger = tEl.value;
                }
                if (!eventOverrides[eventKey]) eventOverrides[eventKey] = {};
                eventOverrides[eventKey].triggerOverride = ov;
            }
            document.body.removeChild(overlay);
            renderEventManager();
            markPreviewStale();
        });
        modal.querySelector('#trg-pick-cancel').addEventListener('click', function() {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    // ── Kategorie-Picker pro Event ──
    function openEventCategoryPicker(eventKey) {
        // aktuelle requiredCDs holen
        var current = [];
        var custom = customEvents.find(function(e) { return e._key === eventKey; });
        if (custom) {
            current = (custom.requiredCDs || []).slice();
        } else {
            var ov = eventOverrides[eventKey] || {};
            if (ov.requiredCDs !== undefined) {
                current = ov.requiredCDs.slice();
            } else {
                var cfgIdx = parseInt(eventKey.replace('cfg_', ''));
                current = ((config.events[cfgIdx] || {}).requiredCDs || []).slice();
            }
        }

        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';
        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:500px;width:90%;max-height:80vh;overflow-y:auto;';

        var rows = Object.entries(categories).map(function(entry) {
            var key = entry[0], cat = entry[1];
            var checked = current.indexOf(key) !== -1;
            return '<label class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded cursor-pointer">'
                + '<input type="checkbox" class="cat-pick-cb" value="' + key + '"' + (checked ? ' checked' : '') + ' style="accent-color:' + cat.color + ';">'
                + '<span class="flex-1 text-sm" style="color:' + cat.color + ';">' + cat.name + '</span>'
                + '<span class="text-[9px] text-gray-500 font-mono">' + (cat.spells ? cat.spells.length : 0) + ' Spells</span>'
                + '</label>';
        }).join('');

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-3">Kategorien für dieses Event</h4>'
            + '<div class="text-xs text-gray-400 mb-3">Welche CD-Kategorien sollen bei diesem Event automatisch gesucht werden?</div>'
            + '<div class="space-y-1 mb-4">' + rows + '</div>'
            + '<div class="flex justify-end gap-2">'
            +   '<button id="cat-pick-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            +   '<button id="cat-pick-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector('#cat-pick-save').addEventListener('click', function() {
            var selected = [];
            modal.querySelectorAll('.cat-pick-cb').forEach(function(cb) {
                if (cb.checked) selected.push(cb.value);
            });
            setOverride(eventKey, 'requiredCDs', selected);
            document.body.removeChild(overlay);
        });
        modal.querySelector('#cat-pick-cancel').addEventListener('click', function() {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    function updateStatus(msg) {
        var el = document.getElementById('auto-planner-status');
        if (el) el.textContent = config.name + ' — ' + msg;
    }

    // ══════════════════════════════════════════════════════════════
    // EXPORT → CD-PLANER
    // Trigger = Event-Typ | Condition = # | Zeit = Delay | CD = DB-Name
    // ══════════════════════════════════════════════════════════════

    async function exportToPlanner() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
        if (!assignments.length) return window.showModal && window.showModal("Erst Auto-Assign ausführen!");
        var container = document.querySelector('[id$="-planner-container"]');
        if (!container) return window.showModal && window.showModal("CD-Planer nicht gefunden.");

        var prefix = container.id.replace('-planner-container', '');
        var rowNum = 1, exported = 0, skipped = 0;
        var catKeys = getUniqueCategoryKeys();
        var triggerCounts = {};

        // BATCH-MODE aktivieren: keine change-Events → keine setDoc-Calls aus handleAssignmentChange
        window._suspendAssignListeners = true;

        // Alle Änderungen sammeln für EINEN einzigen setDoc
        var batchPayload = {};
        var currentManager = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('currentManager')) || 'Unbekannt';
        var serverTs = null;
        if (window.firebaseTools && window.firebaseTools.serverTimestamp) {
            serverTs = window.firebaseTools.serverTimestamp();
        }

        function addToBatch(fieldId, data) {
            batchPayload[fieldId] = data;
        }

        try {
            assignments.forEach(function(row) {
                var validSlots = [];
                catKeys.forEach(function(catKey) {
                    var slot = row.slots[catKey];
                    if (!slot || slot.skipped || !slot.player || !slot.dbName || slot.player === '__SKIP__') return;
                    validSlots.push(slot);
                });

                if (validSlots.length === 0) return;

                // triggerMap kann String (nur Trigger) oder Object ({ trigger, npc, percent }) sein
                var mapEntry = row._sourceTriggerMap || (config.triggerMap && config.triggerMap[row.eventName]);
                var triggerVal = '';
                var npcVal = '';
                var percentVal = null;
                if (typeof mapEntry === 'string') {
                    triggerVal = mapEntry;
                } else if (mapEntry && typeof mapEntry === 'object') {
                    triggerVal = mapEntry.trigger || '';
                    npcVal = mapEntry.npc || '';
                    if (mapEntry.percent !== undefined && mapEntry.percent !== null) {
                        percentVal = mapEntry.percent;
                    }
                }

                // triggerOverride aus Event-Manager überschreibt triggerMap
                var ovEntry = eventOverrides[row.eventKey];
                var triggerOv = ovEntry && ovEntry.triggerOverride;
                if (triggerOv) {
                    if (triggerOv.mode === 'hp') {
                        var healthTrigger = null;
                        try {
                            if (typeof TRIGGER_OPTIONS !== 'undefined') {
                                var found = TRIGGER_OPTIONS.find(function(t) { return t.val && t.val.indexOf('HEALTH') !== -1; });
                                if (found) healthTrigger = found.val;
                            }
                        } catch (e) { /* ignore */ }
                        if (!healthTrigger && window.TRIGGER_OPTIONS) {
                            var found2 = window.TRIGGER_OPTIONS.find(function(t) { return t.val && t.val.indexOf('HEALTH') !== -1; });
                            if (found2) healthTrigger = found2.val;
                        }
                        if (healthTrigger) triggerVal = healthTrigger;
                        npcVal = triggerOv.npc || '';
                        percentVal = (triggerOv.percent !== undefined) ? triggerOv.percent : null;
                    } else if (triggerOv.mode === 'cast') {
                        if (triggerOv.trigger) triggerVal = triggerOv.trigger;
                        npcVal = '';
                        percentVal = null;
                    }
                }

                var isHealthTrigger = triggerVal && triggerVal.indexOf('HEALTH') !== -1;
                var isEncStartTrigger = triggerVal && triggerVal.indexOf('ENC_START') !== -1;

                var conditionVal;
                if (isEncStartTrigger) {
                    conditionVal = '1';
                } else if (isHealthTrigger && percentVal !== null) {
                    conditionVal = String(percentVal);
                } else if (triggerOv && triggerOv.mode === 'cast') {
                    conditionVal = String(row.castNum);
                } else if (row._sourceEvent && typeof row._sourceEvent.forceTriggerCondition !== 'undefined') {
                    conditionVal = String(row._sourceEvent.forceTriggerCondition);
                } else if (row._sourceEvent && row._sourceEvent._isFollowUp) {
                    conditionVal = String(triggerCounts[triggerVal] || 1);
                } else {
                    triggerCounts[triggerVal] = (triggerCounts[triggerVal] || 0) + 1;
                    conditionVal = String(triggerCounts[triggerVal]);
                }

                var timeVal;
                if (isEncStartTrigger) {
                    timeVal = String(Math.round((row.absTime || 0) + (row.delay || 0)));
                } else {
                    timeVal = String(row.delay || 0);
                }

                validSlots.forEach(function(slot) {
                    if (rowNum > 100) return;
                    var rowPrefix = prefix + '-planner-row' + rowNum;

                    // DOM aktualisieren (für sofortige Anzeige, aber OHNE change-Events)
                    setPlannerSelect(rowPrefix + '-trigger', triggerVal, true);
                    addToBatch(rowPrefix + '-trigger', { player: triggerVal, editor: currentManager, timestamp: serverTs });

                    if (isHealthTrigger && npcVal) {
                        setPlannerInput(rowPrefix + '-npc', npcVal, true);
                        addToBatch(rowPrefix + '-npc', { player: npcVal, editor: currentManager, timestamp: serverTs });
                    }

                    setPlannerInput(rowPrefix + '-condition', conditionVal, true);
                    addToBatch(rowPrefix + '-condition', { text: conditionVal, editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-time', timeVal, true);
                    addToBatch(rowPrefix + '-time', { text: timeVal, editor: currentManager, timestamp: serverTs });

                    setPlannerSelect(rowPrefix + '-player', slot.player, true);
                    addToBatch(rowPrefix + '-player', { player: slot.player, editor: currentManager, timestamp: serverTs });

                    var ok = setPlannerSelect(rowPrefix + '-cooldown', slot.dbName, true);
                    addToBatch(rowPrefix + '-cooldown', { cooldown: slot.dbName, editor: currentManager, timestamp: serverTs });

                    if (ok) exported++; else {
                        skipped++;
                        console.warn('[Auto-Planner] CD nicht gefunden: "' + slot.dbName + '" (' + slot.spellId + ')');
                    }
                    rowNum++;
                });
            });

            // EIN einziger Firestore-Write für alle Felder
            if (firebaseRef && firebaseRef.setDoc && Object.keys(batchPayload).length > 0) {
                var bossDocId = "boss-" + (config.id || prefix.toLowerCase());
                await firebaseRef.setDoc(
                    firebaseRef.doc(firebaseRef.db, "raid-tool-data", bossDocId),
                    batchPayload,
                    { merge: true }
                );
            }
        } finally {
            window._suspendAssignListeners = false;
        }

        if (window.updatePlannerSummary) setTimeout(window.updatePlannerSummary, 200);
        var msg = exported + ' Zeilen exportiert!';
        if (skipped > 0) msg += '\n⚠ ' + skipped + ' CDs nicht im Dropdown.';
        if (window.showModal) window.showModal(msg);
    }

    function setPlannerSelect(id, value, suppressEvent) {
        var el = document.querySelector('[data-assignment-id="' + id + '"]');
        if (!el) return false;
        var exists = Array.from(el.options).some(function(o) { return o.value === value; });
        el.value = value;
        var opt = el.options[el.selectedIndex];
        if (opt) el.style.color = (opt.dataset && opt.dataset.color) || '#FFFFFF';
        if (!suppressEvent) {
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return exists;
    }

    function setPlannerInput(id, value, suppressEvent) {
        var el = document.querySelector('[data-assignment-id="' + id + '"]');
        if (!el) return;
        el.value = value;
        if (!suppressEvent) {
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // ══════════════════════════════════════════════════════════════
    // FIRESTORE
    // ══════════════════════════════════════════════════════════════

    async function savePlan() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
        if (!firebaseRef) return;
        try {
            await firebaseRef.setDoc(
                firebaseRef.doc(firebaseRef.db, "auto-planner", config.id),
                {
                    bossId: config.id, bossName: config.name,
                    timestamp: new Date().toISOString(),
                    editor: sessionStorage.getItem('currentManager') || 'Unbekannt',
                    manualOverrides: manualOverrides,
                    eventOverrides: eventOverrides,
                    customEvents: customEvents,
                    assignStrategy: assignStrategy,
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
            if (snap.exists()) {
                var data = snap.data();
                manualOverrides = data.manualOverrides || {};
                eventOverrides  = data.eventOverrides  || {};
                customEvents    = data.customEvents    || [];
                if (data.assignStrategy && typeof data.assignStrategy === 'object') {
                    assignStrategy.spread              = !!data.assignStrategy.spread;
                    assignStrategy.prioritizeCategories = !!data.assignStrategy.prioritizeCategories;
                    assignStrategy.roundRobin          = !!data.assignStrategy.roundRobin;
                }
                return true;
            }
        } catch (e) { console.error("[Auto-Planner]", e); }
        return false;
    }

    async function saveCategories() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
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
            if (snap.exists() && snap.data().categories) {
                var dbCats = snap.data().categories;
                // Alte 'stormlash_banner' Kategorie aus der DB bereinigen, da sie jetzt in 2 geteilt wurde
                if (dbCats['stormlash_banner']) {
                    delete dbCats['stormlash_banner'];
                }
                
                // Merge missing categories from DEFAULT_CATEGORIES
                Object.keys(DEFAULT_CATEGORIES).forEach(function(k) {
                    if (!dbCats[k]) dbCats[k] = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES[k]));
                });
                categories = dbCats;
                return;
            }
        } catch (e) { console.error("[Auto-Planner]", e); }
        categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    }

    function renderCategoriesAdmin() {
        var el = document.getElementById('cd-categories-container');
        if (!el) return;

        // Einmalig Styles injizieren, damit der Editor korrekt scrollt und Zeilen nicht clippen
        if (!document.getElementById('cd-admin-styles')) {
            var styleTag = document.createElement('style');
            styleTag.id = 'cd-admin-styles';
            styleTag.textContent =
                '#cd-categories-container { max-height: 70vh; overflow-y: auto; overflow-x: hidden; padding-right: 6px; }' +
                '#cd-categories-container > div[data-cat-key] { overflow: visible; }' +
                '#cd-categories-container .spells-container { overflow: visible; }' +
                '#cd-categories-container .spell-row { overflow: visible; min-height: 32px; }' +
                '#cd-categories-container::-webkit-scrollbar { width: 8px; }' +
                '#cd-categories-container::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }' +
                '#cd-categories-container::-webkit-scrollbar-track { background: #1e293b; }';
            document.head.appendChild(styleTag);
        }

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

                // Spec-Anzeige: Lesbare Labels mit Klassen-Kontext
                var specList = Array.isArray(sp.requiredSpec) ? sp.requiredSpec : (sp.requiredSpec ? [sp.requiredSpec] : []);
                var specDisplay = '';
                if (specList.length === 0) {
                    specDisplay = '<span class="text-gray-500 italic">alle Specs</span>';
                } else if (specList.length <= 2) {
                    specDisplay = specList.map(function(s) { return getSpecLabel(s); }).join(', ');
                } else {
                    specDisplay = specList.length + ' Specs';
                }

                return '<div class="spell-row flex items-center gap-2 text-[11px] bg-slate-800/50 p-1.5 rounded flex-wrap" draggable="true" data-cat="' + key + '" data-idx="' + idx + '">'
                    + '<span class="drag-handle cursor-move text-gray-600 px-1" title="Ziehen zum Sortieren">⋮⋮</span>'
                    + '<span class="text-gray-500 w-4 text-right">' + (idx + 1) + '.</span>'
                    + '<span style="color:' + color + ';" class="font-medium flex-1 min-w-[140px]">' + (found ? '' : '❌ ') + name + '</span>'
                    + '<span class="text-gray-500 w-20">' + cls + '</span>'
                    + '<select class="spell-role-select bg-slate-900 text-gray-400 text-[10px] px-1 py-0.5 rounded border border-slate-600" data-cat="' + key + '" data-idx="' + idx + '" title="Nur für diese Rolle">' + roleOptions + '</select>'
                    + '<button class="spell-spec-btn bg-slate-900 hover:bg-slate-700 text-gray-300 text-[10px] px-2 py-0.5 rounded border border-slate-600 w-44 text-left truncate" data-cat="' + key + '" data-idx="' + idx + '" title="Specs auswählen">'
                    +   '<span class="opacity-60">Specs:</span> ' + specDisplay
                    + '</button>'
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

        // Spell-Spec (Button öffnet Popup mit Checkbox-Liste)
        document.querySelectorAll('.spell-spec-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                var cat = e.currentTarget.dataset.cat;
                var idx = parseInt(e.currentTarget.dataset.idx);
                openSpecPicker(cat, idx);
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

    // ── Spec-Picker: Multi-Select Dialog für Specs einer Klasse ──
    function openSpecPicker(catKey, spellIdx) {
        var sp = categories[catKey].spells[spellIdx];
        var db = resolveSpell(sp.spellId);
        var cls = db ? db.dbClass : null;
        if (!cls) {
            // Fallback: resolve über cooldownsDB
            var cd = cooldownsDB.find(function(c) { return String(c.spellId) === String(sp.spellId); });
            cls = cd ? cd.class : null;
        }
        if (!cls) {
            alert('Klasse für diesen Spell nicht ermittelbar.');
            return;
        }
        cls = cls.toUpperCase();
        var specs = SPEC_DEFINITIONS[cls] || [];
        if (!specs.length) {
            alert('Keine Specs für Klasse ' + cls + ' definiert.');
            return;
        }

        var currentSpecs = Array.isArray(sp.requiredSpec) ? sp.requiredSpec.slice() : (sp.requiredSpec ? [sp.requiredSpec] : []);

        // Overlay
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:420px;width:90%;';

        var color = getClassColor(cls);
        var spellName = db ? db.dbName : ('SpellID ' + sp.spellId);

        var checkboxesHtml = specs.map(function(spec) {
            var checked = currentSpecs.indexOf(spec.value) !== -1;
            return '<label class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded cursor-pointer">'
                + '<input type="checkbox" class="spec-pick-cb" value="' + spec.value + '"' + (checked ? ' checked' : '') + ' style="accent-color: ' + color + ';">'
                + '<span class="flex-1 text-sm" style="color:' + color + ';">' + spec.label + '</span>'
                + '<span class="text-[9px] text-gray-500 font-mono">' + spec.value + '</span>'
                + '</label>';
        }).join('');

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-1">' + spellName + '</h4>'
            + '<div class="text-xs mb-4" style="color:' + color + ';">' + cls + '</div>'
            + '<div class="text-xs text-gray-400 mb-3">Welche Specs sollen diesen Spell nutzen können?</div>'
            + '<div class="space-y-1 mb-4">'
            +   '<label class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded cursor-pointer border-b border-slate-700">'
            +   '<input type="checkbox" id="spec-pick-all" class="spec-pick-cb-all">'
            +   '<span class="flex-1 text-xs italic text-gray-300">Alle Specs (kein Filter)</span>'
            +   '</label>'
            + checkboxesHtml
            + '</div>'
            + '<div class="flex justify-end gap-2">'
            +   '<button id="spec-pick-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            +   '<button id="spec-pick-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // "Alle Specs" Checkbox-Logik
        var allCb = modal.querySelector('#spec-pick-all');
        var specCbs = modal.querySelectorAll('.spec-pick-cb');

        // Initialzustand: "Alle" wenn nichts selektiert
        allCb.checked = currentSpecs.length === 0;

        allCb.addEventListener('change', function() {
            if (allCb.checked) {
                specCbs.forEach(function(cb) { cb.checked = false; });
            }
        });

        specCbs.forEach(function(cb) {
            cb.addEventListener('change', function() {
                if (cb.checked) allCb.checked = false;
            });
        });

        // Save
        modal.querySelector('#spec-pick-save').addEventListener('click', function() {
            var selected = [];
            if (!allCb.checked) {
                specCbs.forEach(function(cb) {
                    if (cb.checked) selected.push(cb.value);
                });
            }
            if (selected.length === 0) {
                delete categories[catKey].spells[spellIdx].requiredSpec;
            } else {
                categories[catKey].spells[spellIdx].requiredSpec = selected;
            }
            document.body.removeChild(overlay);
            renderCategoriesAdmin();
        });

        // Cancel
        modal.querySelector('#spec-pick-cancel').addEventListener('click', function() {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    // ── Spell-Picker: Dialog zur Spell-Auswahl aus DB ──
    function openSpellPicker(catKey) {
        // Overlay erstellen
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:700px;max-height:80vh;overflow-y:auto;width:90%;';

        // Zähle wie oft jeder Spell bereits in der Kategorie ist (für Anzeige)
        var existingCounts = {};
        categories[catKey].spells.forEach(function(s) {
            var sid = String(s.spellId);
            existingCounts[sid] = (existingCounts[sid] || 0) + 1;
        });
        // Alle Spells aus der DB anzeigen — Duplikate explizit erlaubt für spec-spezifische Prio
        var availableCDs = cooldownsDB.filter(function(cd) {
            return cd.name && cd.spellId && cd.name.indexOf('---') !== 0 && cd.name.indexOf('-- ') !== 0;
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
                var sid = String(cd.spellId);
                var count = existingCounts[sid] || 0;
                var badge = count > 0
                    ? '<span class="text-[9px] bg-amber-700/60 text-amber-200 px-1.5 py-0.5 rounded font-mono" title="Bereits ' + count + 'x in dieser Kategorie">×' + count + '</span>'
                    : '';
                return '<div class="picker-row flex items-center gap-2 text-[11px] hover:bg-slate-700/40 p-1 rounded cursor-pointer" data-spellid="' + cd.spellId + '">'
                    + '<span style="color:' + color + ';" class="flex-1">' + cd.name + '</span>'
                    + badge
                    + '<span class="text-gray-500 font-mono text-[9px]">' + cd.spellId + '</span>'
                    + '</div>';
            }).join('');
            return '<div class="mb-3">'
                + '<h6 class="font-bold text-xs mb-1" style="color:' + color + ';">' + cls + '</h6>'
                + rows + '</div>';
        }).join('');

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-1">Spell zu "' + categories[catKey].name + '" hinzufügen</h4>'
            + '<div class="text-[11px] text-gray-400 mb-3">💡 Spells können <strong>mehrfach</strong> hinzugefügt werden - z.B. um denselben Spell für unterschiedliche Specs mit eigener Priorität zu hinterlegen. <span class="text-amber-300">×N</span> zeigt wie oft schon vorhanden.</div>'
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

    async function clearPlan() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
        
        // Lokalen State auf "wie frisch geladen" setzen, aber Events behalten
        manualOverrides = {};
        assignments = [];
        
        // Tabelle visuell leeren
        var tbody = document.getElementById('auto-planner-tbody');
        if (tbody) tbody.innerHTML = '';
        var thead = document.getElementById('auto-planner-thead');
        if (thead) thead.innerHTML = '';
        
        if (typeof window._autoPlannerApplyProtection === 'function') {
            window._autoPlannerApplyProtection();
        }
        
        // Änderungen (geleerte Zuweisungen) in DB speichern
        try {
            await savePlan();
            updateStatus("Auto-Plan geleert (Zuweisungen entfernt, Events beibehalten).");
        } catch (e) {
            console.error("[Auto-Planner] clearPlan error:", e);
            updateStatus("Plan lokal geleert (Fehler beim Speichern: " + e.message + ")");
        }
    }

    async function doInit(bossConfig) {
        config = bossConfig;
        rosterRef = window.effectiveRoster || window.rosterData || [];
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
            // Category-Admin automatisch injizieren, falls nicht im Boss-HTML vorhanden
            if (!document.getElementById('cd-categories-admin')) {
                var plannerContainer = document.getElementById('auto-planner-timeline');
                if (plannerContainer) {
                    var catWrapper = document.createElement('details');
                    catWrapper.id = 'cd-categories-admin';
                    catWrapper.className = 'mt-6 bg-slate-900 rounded-lg border border-slate-700';
                    catWrapper.innerHTML = '<summary class="p-3 text-sm font-bold text-gray-300 cursor-pointer hover:bg-slate-800 rounded-lg">⚙️ CD-Kategorien bearbeiten</summary>'
                        + '<div id="cd-categories-container" class="p-3" style="max-height:70vh; overflow-y:auto;"></div>';
                    plannerContainer.parentNode.appendChild(catWrapper);
                }
            }

            var admin = document.getElementById('cd-categories-admin');
            if (admin) admin.style.display = '';
            renderCategoriesAdmin();

            // Events-Container automatisch injizieren, falls nicht im Boss-HTML vorhanden
            if (!document.getElementById('auto-planner-events')) {
                var timelineEl = document.getElementById('auto-planner-timeline');
                if (timelineEl) {
                    var evtWrapper = document.createElement('details');
                    evtWrapper.className = 'mb-4 bg-slate-800 rounded-lg border border-slate-700';
                    evtWrapper.innerHTML = '<summary class="cursor-pointer p-3 text-sm font-bold text-cyan-400 hover:bg-slate-750 rounded-t-lg">📋 Events bearbeiten (Zeit / Kategorien / Aktivieren)</summary>'
                        + '<div class="p-3" id="auto-planner-events"></div>';
                    timelineEl.parentNode.insertBefore(evtWrapper, timelineEl);
                }
            }
            renderEventManager();
            renderStrategyPanel();
        }

        // ══════════════════════════════════════════════════════════
        // MANAGER-SCHUTZ — Nur Manager können Auto-Plan modifizieren
        // ══════════════════════════════════════════════════════════
        function applyManagerProtection() {
            var isManager = !!window.isManager;
            
            // 1. Aktions-Buttons komplett verstecken bei Nicht-Manager
            var managerOnlyButtons = [
                'btn-auto-assign',
                'btn-export-to-planner',
                'btn-save-auto-plan',
                'btn-save-categories',
                'btn-clear-auto',
                'btn-reset-events',
                'btn-clear-planner'
            ];
            managerOnlyButtons.forEach(function(btnId) {
                var btn = document.getElementById(btnId);
                if (btn) btn.style.display = isManager ? '' : 'none';
            });
            
            // Hinweis-Banner für Nicht-Manager (statt leerer Button-Reihe)
            var hint = document.getElementById('auto-planner-readonly-hint');
            if (!isManager && !hint) {
                var statusEl = document.getElementById('auto-planner-status');
                if (statusEl) {
                    hint = document.createElement('div');
                    hint.id = 'auto-planner-readonly-hint';
                    hint.className = 'text-xs italic mb-3 p-2 rounded bg-slate-700/40 border border-slate-600/50 text-gray-400';
                    hint.innerHTML = '🔒 <strong>Nur lesen</strong> - Änderungen am Auto-Plan können nur Gildenräte vornehmen.';
                    statusEl.parentNode.insertBefore(hint, statusEl);
                }
            } else if (isManager && hint) {
                hint.remove();
            }
            
            // 2. Timeline-Tabelle: alle Selects/Inputs deaktivieren
            var tbody = document.getElementById('auto-planner-tbody');
            if (tbody) {
                tbody.querySelectorAll('select, input, button').forEach(function(el) {
                    el.disabled = !isManager;
                });
            }
            
            // 3. Event-Manager-Bereich: alle Steuer-Elemente deaktivieren
            var eventArea = document.getElementById('auto-planner-events');
            if (eventArea) {
                eventArea.querySelectorAll('input, button, select').forEach(function(el) {
                    el.disabled = !isManager;
                });
            }
            
            // 4. CD-Kategorien-Editor: gar nicht erst anzeigen
            var catAdmin = document.getElementById('cd-categories-admin');
            if (catAdmin) catAdmin.style.display = isManager ? '' : 'none';
        }
        
        // Initial anwenden
        applyManagerProtection();
        
        // Bei Re-Renders (z.B. nach Auto-Assign) erneut anwenden
        window._autoPlannerApplyProtection = applyManagerProtection;
        
        // Polling: bei isManager-Status-Wechsel (Login/Logout) erneut anwenden
        var lastManagerState = !!window.isManager;
        var managerWatcher = setInterval(function() {
            var current = !!window.isManager;
            if (current !== lastManagerState) {
                lastManagerState = current;
                applyManagerProtection();
            }
        }, 1500);
        // Stop bei Page-Unload (verhindert Memory Leaks)
        window.addEventListener('beforeunload', function() { clearInterval(managerWatcher); });

        document.getElementById('btn-auto-assign').addEventListener('click', function() {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            runAutoAssign();
        });
        document.getElementById('btn-export-to-planner').addEventListener('click', function() {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            exportToPlanner();
        });
        document.getElementById('btn-save-auto-plan').addEventListener('click', function() {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            savePlan();
        });
        var btnSaveCategories = document.getElementById('btn-save-categories');
        if (btnSaveCategories) {
            btnSaveCategories.addEventListener('click', function() {
                if (!window.isManager) {
                    if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                    return;
                }
                saveCategories();
            });
        }
        document.getElementById('btn-clear-auto').addEventListener('click', function() {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            var msg = "Auto-Plan Zuweisungen leeren?\n\nLöscht alle Zuweisungen im Auto-Plan, behält aber die Event-Anpassungen (Häkchen) bei.\nDie CD-Planer-Einträge im Raidplan bleiben unangetastet.";
            if (typeof window.showModal === 'function') {
                var r = window.showModal(msg, true);
                if (r && typeof r.then === 'function') { r.then(function(ok) { if (ok) clearPlan(); }); }
                else clearPlan();
            } else { if (confirm(msg)) clearPlan(); }
        });

        // ── Events-Reset-Button dynamisch einfügen (nur für Manager) ──
        injectResetEventsButton();

        // ── Clear-Planner-Button dynamisch einfügen (nur für Manager) ──
        injectClearPlannerButton();

        // ── DB-Wipe Button dynamisch einfügen (nur für Manager) ──
        injectWipeButton();

        // Wenn ein gespeicherter Plan existiert, direkt anzeigen
        if (hasSavedPlan) {
            runAutoAssign();
        } else {
            updateStatus('Bereit. ' + found + '/' + total + ' Spells in DB. Roster: ' + rosterRef.length + ' Spieler.');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // STRATEGIE-PANEL — UI für die 3 Verteilungs-Toggles
    // ══════════════════════════════════════════════════════════════
    function renderStrategyPanel() {
        if (!window.isManager) return;

        var anchor = document.getElementById('auto-planner-events');
        if (!anchor) return;
        // Anker ist der Wrapper-Container des Events-Panels
        var wrapper = anchor.closest('details') || anchor.parentNode;
        if (!wrapper) return;

        var existing = document.getElementById('auto-planner-strategy');
        if (existing) existing.remove();

        var panel = document.createElement('details');
        panel.id = 'auto-planner-strategy';
        panel.className = 'mb-4 bg-slate-800 rounded-lg border border-slate-700';
        panel.open = false;

        var s = assignStrategy;
        panel.innerHTML =
            '<summary class="cursor-pointer p-3 text-sm font-bold text-cyan-400 hover:bg-slate-750 rounded-t-lg">⚙ Verteilungs-Strategie</summary>' +
            '<div class="p-3 space-y-2 text-xs text-gray-300">' +
                '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
                    '<input type="checkbox" id="strat-spread" class="mt-1 accent-cyan-500" ' + (s.spread ? 'checked' : '') + '>' +
                    '<div>' +
                        '<div class="font-semibold text-gray-200">A — Spread (Lookahead)</div>' +
                        '<div class="text-[10px] text-gray-400">Bei Knappheit Casts gleichmäßig über die Zeit verteilen statt am Anfang ballen. Lücken werden als "geplante Lücken" markiert.</div>' +
                    '</div>' +
                '</label>' +
                '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
                    '<input type="checkbox" id="strat-prio" class="mt-1 accent-cyan-500" ' + (s.prioritizeCategories ? 'checked' : '') + '>' +
                    '<div>' +
                        '<div class="font-semibold text-gray-200">B — Kategorien-Priorisierung</div>' +
                        '<div class="text-[10px] text-gray-400">Wichtigere Kategorien (erste in der requiredCDs-Liste) zuerst füllen. Niedrige bleiben leer wenn die Wichtigen bereits Spieler verbraucht haben.</div>' +
                    '</div>' +
                '</label>' +
                '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
                    '<input type="checkbox" id="strat-rr" class="mt-1 accent-cyan-500" ' + (s.roundRobin ? 'checked' : '') + '>' +
                    '<div>' +
                        '<div class="font-semibold text-gray-200">C — Round-Robin</div>' +
                        '<div class="text-[10px] text-gray-400">Spieler reihum nutzen statt immer den ersten. Bringt Fairness, hilft bei Lücken nur wenn Spieler-CD &lt; Event-Abstand ist.</div>' +
                    '</div>' +
                '</label>' +
                '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
                    '<input type="checkbox" id="strat-prefer-heal" class="mt-1 accent-cyan-500" ' + (s.preferHeal ? 'checked' : '') + '>' +
                    '<div>' +
                        '<div class="font-semibold text-gray-200">D — Bevorzuge Heiler</div>' +
                        '<div class="text-[10px] text-gray-400">Zieht reine Heiler-Klassen für defensiven CDs heran, bevor Utility-Heals (z.B. Vampirumarmung) der DDs genutzt werden.</div>' +
                    '</div>' +
                '</label>' +
                '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
                    '<input type="checkbox" id="strat-strict-class" class="mt-1 accent-cyan-500" ' + (s.strictClassBalance ? 'checked' : '') + '>' +
                    '<div>' +
                        '<div class="font-semibold text-gray-200">E — Strikte Klassen-Rotation</div>' +
                        '<div class="text-[10px] text-gray-400">Verhindert, dass eine Klasse mehrfach hintereinander ihre Cooldowns ziehen muss, selbst wenn sie verfügbar wäre.</div>' +
                    '</div>' +
                '</label>' +
                '<div class="text-[10px] text-gray-500 italic pt-1 border-t border-slate-700">Änderungen werden mit dem nächsten "Auto-Assign" wirksam und beim Speichern persistiert.</div>' +
            '</div>';

        wrapper.parentNode.insertBefore(panel, wrapper);

        function bind(id, key) {
            var el = panel.querySelector('#' + id);
            if (!el) return;
            el.addEventListener('change', function() {
                assignStrategy[key] = !!el.checked;
                runAutoAssign();
            });
        }
        bind('strat-spread', 'spread');
        bind('strat-prio', 'prioritizeCategories');
        bind('strat-rr', 'roundRobin');
        bind('strat-prefer-heal', 'preferHeal');
        bind('strat-strict-class', 'strictClassBalance');
    }

    // ── Dynamischer Events-Reset-Button ──
    function injectResetEventsButton() {
        if (!window.isManager) return;
        if (document.getElementById('btn-reset-events')) return;

        var btnContainer = document.getElementById('btn-clear-auto')?.parentNode;
        if (!btnContainer) return;

        var resetBtn = document.createElement('button');
        resetBtn.id = 'btn-reset-events';
        resetBtn.className = 'bg-slate-700 hover:bg-slate-800 text-white py-1.5 px-3 rounded text-xs border border-slate-500 mr-2';
        resetBtn.innerHTML = '🔄 Events Reset';
        resetBtn.title = 'Setzt alle Event-Anpassungen (Häkchen und eigene Events) auf Standard zurück';
        
        btnContainer.insertBefore(resetBtn, document.getElementById('btn-clear-auto'));

        resetBtn.addEventListener('click', function() {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            var msg = "Events zurücksetzen?\n\nSetzt alle Häkchen und manuell hinzugefügten Events auf die Standardwerte des Bosses zurück.\nBereits zugewiesene CDs bleiben in der Tabelle stehen (Auto-Assign erforderlich, um sie neu zu verteilen).";
            if (typeof window.showModal === 'function') {
                var r = window.showModal(msg, true);
                if (r && typeof r.then === 'function') {
                    r.then(function(ok) { if (ok) resetEventsOnly(); });
                } else {
                    resetEventsOnly();
                }
            } else {
                if (confirm(msg)) resetEventsOnly();
            }
        });
    }

    async function resetEventsOnly() {
        eventOverrides = {};
        customEvents = [];
        renderEventManager();
        
        try {
            await savePlan();
            updateStatus("Events zurückgesetzt.");
        } catch (e) {
            console.error("[Auto-Planner] resetEvents error:", e);
        }
    }

    // ── Dynamischer Clear-Button für Advanced CD-Plan ──
    function injectClearPlannerButton() {
        if (!window.isManager) return;
        if (document.getElementById('btn-clear-planner')) return;  // Schon da

        var btnContainer = document.getElementById('btn-clear-auto')?.parentNode;
        if (!btnContainer) return;

        var clearBtn = document.createElement('button');
        clearBtn.id = 'btn-clear-planner';
        clearBtn.className = 'bg-orange-700 hover:bg-orange-800 text-white font-bold py-1.5 px-3 rounded text-xs border border-orange-600';
        clearBtn.innerHTML = '🧹 CD-Plan leeren';
        clearBtn.title = 'Leert ALLE 100 Zeilen des Advanced CD-Plans dieses Bosses (Auto-Plan bleibt unangetastet)';
        btnContainer.appendChild(clearBtn);

        clearBtn.addEventListener('click', function() {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            var msg = "Advanced CD-Plan leeren?\n\nLöscht ALLE 100 Zeilen des CD-Planers dieses Bosses (Trigger, Spieler, Cooldowns, Zeiten, Texte).\nDer Auto-CD-Plan bleibt unangetastet.\n\nFortfahren?";
            if (typeof window.showModal === 'function') {
                var r = window.showModal(msg, true);
                if (r && typeof r.then === 'function') {
                    r.then(function(ok) { if (ok) clearPlannerOnly(); });
                } else {
                    clearPlannerOnly();
                }
            } else {
                if (confirm(msg)) clearPlannerOnly();
            }
        });
    }

    // ── Leert ALLE 100 Zeilen des Advanced CD-Plans (DOM + Firestore) ──
    async function clearPlannerOnly() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }

        var container = document.querySelector('[id$="-planner-container"]');
        if (!container) {
            if (window.showModal) window.showModal("CD-Planer nicht gefunden.");
            return;
        }

        var prefix = container.id.replace('-planner-container', '');

        // BATCH-MODE aktivieren: keine change-Events während wir leeren
        window._suspendAssignListeners = true;

        var currentManager = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('currentManager')) || 'Unbekannt';
        var serverTs = null;
        if (firebaseRef && firebaseRef.serverTimestamp) {
            serverTs = firebaseRef.serverTimestamp();
        }

        var batchPayload = {};
        var fields = ['trigger', 'npc', 'condition', 'time', 'player', 'cooldown', 'text', 'tts', 'name', 'icon'];

        try {
            // DOM leeren + Batch füllen
            for (var i = 1; i <= 100; i++) {
                var rowPrefix = prefix + '-planner-row' + i;
                fields.forEach(function(f) {
                    var fieldId = rowPrefix + '-' + f;
                    var el = document.querySelector('[data-assignment-id="' + fieldId + '"]');
                    if (el) {
                        if (el.tagName === 'SELECT') {
                            el.value = '';
                            var opt = el.options[el.selectedIndex];
                            if (opt) el.style.color = (opt.dataset && opt.dataset.color) || '#FFFFFF';
                        } else {
                            el.value = '';
                        }
                    }
                    // Auch wenn DOM-Element nicht da ist (z.B. text/tts/name/icon nicht in allen Bossen):
                    // Wenn Feld existiert hatte, in Firestore leeren — dafür ein leerer Eintrag.
                    var update = { editor: currentManager, timestamp: serverTs };
                    update[f] = '';
                    batchPayload[fieldId] = update;
                });
            }

            // Firestore-Write
            if (firebaseRef && firebaseRef.setDoc) {
                var bossDocId = "boss-" + (config.id || prefix.toLowerCase());
                try {
                    await firebaseRef.setDoc(
                        firebaseRef.doc(firebaseRef.db, "raid-tool-data", bossDocId),
                        batchPayload,
                        { merge: true }
                    );
                } catch (e) {
                    console.error("[Auto-Planner] clearPlannerOnly DB-Error:", e);
                    if (window.showModal) window.showModal("CD-Plan lokal geleert, DB-Fehler: " + e.message);
                    return;
                }
            }

            // Logbuch
            if (typeof window.logHistory === 'function') {
                window.logHistory('Auto-Planner', 'Advanced CD-Plan geleert für Boss "' + config.name + '"',
                    '100 Zeilen', currentManager);
            }

            updateStatus("Advanced CD-Plan geleert (100 Zeilen, lokal + DB).");
            if (window.showModal) window.showModal("✓ Advanced CD-Plan geleert.");

            // Planner-Summary neu rendern, falls verfügbar
            if (window.updatePlannerSummary) setTimeout(window.updatePlannerSummary, 200);
        } finally {
            window._suspendAssignListeners = false;
        }
    }

    // ── Dynamischer Wipe-Button für DB-Einträge ──
    function injectWipeButton() {
        if (!window.isManager) return;
        if (document.getElementById('btn-wipe-db')) return;  // Schon da

        var btnContainer = document.getElementById('btn-clear-auto')?.parentNode;
        if (!btnContainer) return;

        var wipeBtn = document.createElement('button');
        wipeBtn.id = 'btn-wipe-db';
        wipeBtn.className = 'bg-red-900 hover:bg-red-950 text-white font-bold py-1.5 px-3 rounded text-xs border border-red-700';
        wipeBtn.innerHTML = '☢️ DB-Einträge löschen';
        wipeBtn.title = 'Löscht ALLE Datenbank-Einträge für diesen Boss (CD-Planer + Auto-Planer)';
        btnContainer.appendChild(wipeBtn);

        wipeBtn.addEventListener('click', wipeBossFromDb);
    }

    // ── Löscht ALLE DB-Einträge für diesen Boss ──
    async function wipeBossFromDb() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Manager dürfen DB-Einträge löschen.");
            return;
        }
        if (!firebaseRef) {
            if (window.showModal) window.showModal("Firebase nicht verfügbar.");
            return;
        }

        // deleteDoc ist nicht im Standard-firebaseTools, dynamisch nachladen
        var deleteDocFn = firebaseRef.deleteDoc;
        if (!deleteDocFn) {
            try {
                var fbModule = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
                deleteDocFn = fbModule.deleteDoc;
            } catch (e) {
                if (window.showModal) window.showModal("Firestore deleteDoc konnte nicht geladen werden: " + e.message);
                return;
            }
        }

        // Doppelte Bestätigung wegen Destruktiv
        var confirmed = false;
        if (typeof window.showModal === 'function') {
            var r = window.showModal(
                "⚠️ ACHTUNG: Alle Datenbank-Einträge für '" + config.name + "' werden GELÖSCHT.\n\n" +
                "Das betrifft:\n" +
                "• Den CD-Planer (alle 100 Zeilen)\n" +
                "• Den Auto-Planer (gespeicherter Plan + Overrides + Custom-Events)\n" +
                "• Sonstige Boss-Einteilungen (Tank-Zuteilungen, Bereich-Zuteilungen etc.)\n\n" +
                "Diese Aktion kann NICHT rückgängig gemacht werden!\n\n" +
                "Fortfahren?",
                true
            );
            confirmed = (r && typeof r.then === 'function') ? await r : !!r;
        } else {
            confirmed = confirm("ALLE DB-Einträge für '" + config.name + "' löschen? NICHT rückgängig zu machen!");
        }
        if (!confirmed) return;

        // Zweite Bestätigung mit Tippcode
        var typed = prompt('Sicherheitsabfrage: Tippe "LÖSCHEN" (in Großbuchstaben), um zu bestätigen:');
        if (typed !== 'LÖSCHEN') {
            if (window.showModal) window.showModal("Abgebrochen - Sicherheitsabfrage nicht bestanden.");
            return;
        }

        var prefix = config.prefix.toLowerCase();
        var bossDocId1 = "boss-" + (config.id || prefix);             // Standard-Pattern aus index.html
        var bossDocId2 = config.id;                     // Fallback (manche Bosse nutzen direkt id)
        var autoPlannerDocId = config.id;               // Auto-Planner doc

        var deleted = [];
        var errors = [];

        // 1. raid-tool-data/boss-{prefix} löschen
        try {
            await deleteDocFn(firebaseRef.doc(firebaseRef.db, "raid-tool-data", bossDocId1));
            deleted.push("raid-tool-data/" + bossDocId1);
        } catch (e) {
            // Fehler nur loggen wenn Doc tatsächlich existierte
            if (e.code !== 'not-found') errors.push(bossDocId1 + ": " + e.message);
        }

        // 2. Falls Boss-ID anders ist, auch versuchen
        if (bossDocId2 !== bossDocId1) {
            try {
                await deleteDocFn(firebaseRef.doc(firebaseRef.db, "raid-tool-data", bossDocId2));
                deleted.push("raid-tool-data/" + bossDocId2);
            } catch (e) {
                if (e.code !== 'not-found') errors.push(bossDocId2 + ": " + e.message);
            }
        }

        // 3. auto-planner/{bossId} löschen
        try {
            await deleteDocFn(firebaseRef.doc(firebaseRef.db, "auto-planner", autoPlannerDocId));
            deleted.push("auto-planner/" + autoPlannerDocId);
        } catch (e) {
            if (e.code !== 'not-found') errors.push("auto-planner/" + autoPlannerDocId + ": " + e.message);
        }

        // Logbuch
        if (typeof window.logHistory === 'function') {
            var mgr = sessionStorage.getItem('currentManager') || 'Unbekannt';
            window.logHistory('Auto-Planner', 'DB-Wipe für Boss "' + config.name + '"',
                deleted.join(", ") || "(nichts gelöscht)", mgr);
        }

        // Lokalen State leeren
        clearPlan();

        // Auch CD-Planer-Felder im DOM leeren wenn vorhanden
        var plannerContainer = document.querySelector('[id$="-planner-container"]');
        if (plannerContainer) {
            plannerContainer.querySelectorAll('select, input').forEach(function(el) {
                if (el.tagName === 'SELECT') {
                    el.value = '';
                } else if (el.type === 'number' || el.type === 'text') {
                    el.value = '';
                }
            });
            plannerContainer.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Status-Meldung
        var msg = "✓ Gelöscht: " + (deleted.length ? deleted.join("\n• ") : "Keine Einträge gefunden");
        if (errors.length) msg += "\n\n⚠ Fehler:\n• " + errors.join("\n• ");
        if (window.showModal) window.showModal(msg);
        else alert(msg);

        // Seite reload empfehlen für sauberen Zustand
        setTimeout(function() {
            if (confirm("Empfehlung: Seite neu laden für sauberen Zustand. Jetzt reloaden?")) {
                location.reload();
            }
        }, 500);
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
        },

        // Diagnose-Helper: in der Browser-Konsole `CD_AUTO_PLANNER.debugRoster()` aufrufen,
        // um zu sehen, welche class/spec/roles-Werte die Spieler tatsächlich haben.
        // Zeigt auch, wie normalizeSpec sie interpretiert.
        debugRoster: function(filterClass) {
            var roster = window.effectiveRoster || window.rosterData || [];
            var rows = roster
                .filter(function(p) { return !filterClass || (p.class || '').toUpperCase() === filterClass.toUpperCase(); })
                .map(function(p) {
                    return {
                        name: p.name,
                        class: p.class,
                        spec: p.spec || p.specName || p.specialization || '(keine)',
                        specNormalisiert: normalizeSpec(p.spec || p.specName || p.specialization || ''),
                        roles: (p.roles || []).join(',')
                    };
                });
            console.table(rows);
            return rows;
        },

        // Testet, welche Spieler für eine Klasse+Spec gefunden werden.
        // z.B. CD_AUTO_PLANNER.debugMatch('PALADIN', 'Protection1')
        debugMatch: function(cls, spec) {
            var players = getPlayersOfClass(cls, null, spec ? [spec] : null);
            console.log('Treffer für', cls, spec || '(alle)', '→', players);

            // Detail-Analyse: warum matcht/matcht nicht jeder Spieler der Klasse?
            var roster = window.effectiveRoster || window.rosterData || [];
            var detail = roster
                .filter(function(p) { return (p.class || '').toUpperCase() === (cls || '').toUpperCase(); })
                .map(function(p) {
                    var pSpec = p.spec || p.specName || p.specialization || '';
                    var pNorm = normalizeSpec(pSpec);
                    var reqNorm = spec ? normalizeSpec(spec) : '(kein Spec-Filter)';
                    return {
                        name: p.name,
                        spec_roh: pSpec || '(keine)',
                        spec_normalisiert: pNorm,
                        gesucht_normalisiert: reqNorm,
                        match: spec ? (pNorm === normalizeSpec(spec)) : true
                    };
                });
            console.table(detail);
            return players;
        }
    };
})();