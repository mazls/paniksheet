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

window.CD_AUTO_PLANNER = (function () {
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
            { value: 'Blood', label: 'Blood (Tank)' },
            { value: 'Frost1', label: 'Frost' },
            { value: 'Unholy', label: 'Unholy' }
        ],
        DRUID: [
            { value: 'Balance', label: 'Balance' },
            { value: 'Feral', label: 'Feral' },
            { value: 'Guardian', label: 'Guardian (Tank)' },
            { value: 'Restoration', label: 'Restoration (Heal)' }
        ],
        HUNTER: [
            { value: 'Beastmastery', label: 'Beastmastery' },
            { value: 'Marksmanship', label: 'Marksmanship' },
            { value: 'Survival', label: 'Survival' }
        ],
        MAGE: [
            { value: 'Arcane', label: 'Arcane' },
            { value: 'Fire', label: 'Fire' },
            { value: 'Frost', label: 'Frost' }
        ],
        MONK: [
            { value: 'Brewmaster', label: 'Brewmaster (Tank)' },
            { value: 'Mistweaver', label: 'Mistweaver (Heal)' },
            { value: 'Windwalker', label: 'Windwalker' }
        ],
        PALADIN: [
            { value: 'Holy1', label: 'Holy (Heal)' },
            { value: 'Protection1', label: 'Protection (Tank)' },
            { value: 'Retribution', label: 'Retribution' }
        ],
        PRIEST: [
            { value: 'Discipline', label: 'Discipline (Heal)' },
            { value: 'Holy', label: 'Holy (Heal)' },
            { value: 'Shadow', label: 'Shadow' }
        ],
        ROGUE: [
            { value: 'Assassination', label: 'Assassination' },
            { value: 'Combat', label: 'Combat' },
            { value: 'Subtlety', label: 'Subtlety' }
        ],
        SHAMAN: [
            { value: 'Elemental', label: 'Elemental' },
            { value: 'Enhancement', label: 'Enhancement' },
            { value: 'Restoration1', label: 'Restoration (Heal)' }
        ],
        WARLOCK: [
            { value: 'Affliction', label: 'Affliction' },
            { value: 'Demonology', label: 'Demonology' },
            { value: 'Destruction', label: 'Destruction' }
        ],
        WARRIOR: [
            { value: 'Arms', label: 'Arms' },
            { value: 'Fury', label: 'Fury' },
            { value: 'Protection', label: 'Protection (Tank)' }
        ]
    };

    // Hilfsfunktion: Raidhelper-Name → Label
    function getSpecLabel(specValue) {
        for (var cls in SPEC_DEFINITIONS) {
            var found = SPEC_DEFINITIONS[cls].find(function (s) { return s.value === specValue; });
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
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Retribution"] },       // Devo (Retri)
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Protection1"] },       // Devo (Prot)
                { spellId: "62618", cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },        // PW:Barrier (Disc)
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Holy1"] },             // Devo (Holy)
                { spellId: "98008", cooldownSec: 180, durationSec: 6, requiredSpec: ["Restoration1"] },      // SLT (Resto Shaman)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // PHYSICAL DAMAGE REDUCTION
        // Sheet-Prio: Devo(Retri) → PW:B(Disc) → SLT(Resto)
        // ══════════════════════════════════════════════════════════
        physical_dr: {
            name: "Physische Schadensred.", shortName: "Phys DR", color: "#d97706",
            spells: [
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Retribution"] },
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Protection1"] },
                { spellId: "62618", cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Holy1"] },
                { spellId: "98008", cooldownSec: 180, durationSec: 6, requiredSpec: ["Restoration1"] },
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
                { spellId: "740", cooldownSec: 180, durationSec: 8, requiredSpec: ["Restoration"] },        // Tranquility (Resto: 3min)
                { spellId: "64843", cooldownSec: 180, durationSec: 8, requiredSpec: ["Holy"] },              // Divine Hymn
                { spellId: "115310", cooldownSec: 180, durationSec: 0, requiredSpec: ["Mistweaver"] },        // Revival
                { spellId: "15286", cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },            // Vampiric Embrace
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
                { spellId: "120517", cooldownSec: 40, durationSec: 1, requiredSpec: ["Holy"] },              // Halo (Holy)
                { spellId: "120517", cooldownSec: 40, durationSec: 1, requiredSpec: ["Discipline"] },        // Halo (Disc)
                { spellId: "120517", cooldownSec: 40, durationSec: 1, requiredSpec: ["Shadow"] },            // Halo (Shadow)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // ANY HEALING (Kombination aus Major + Minor)
        // ══════════════════════════════════════════════════════════
        any_heal: {
            name: "Beliebige Heilung", shortName: "Any Heal", color: "#6ee7b7",
            spells: [
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Restoration1"] },      // HTT (Resto)
                { spellId: "740", cooldownSec: 180, durationSec: 8, requiredSpec: ["Restoration"] },        // Tranquility
                { spellId: "64843", cooldownSec: 180, durationSec: 8, requiredSpec: ["Holy"] },              // Divine Hymn
                { spellId: "115310", cooldownSec: 180, durationSec: 0, requiredSpec: ["Mistweaver"] },        // Revival
                { spellId: "15286", cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },            // Vampiric Embrace
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Elemental"] },         // HTT (Elem)
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Enhancement"] },       // HTT (Enh)
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Elemental"] },         // AG (Elem)
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Enhancement"] },       // AG (Enh)
                { spellId: "120517", cooldownSec: 40, durationSec: 1, requiredSpec: ["Holy"] },              // Halo
                { spellId: "120517", cooldownSec: 40, durationSec: 1, requiredSpec: ["Discipline"] },
                { spellId: "120517", cooldownSec: 40, durationSec: 1, requiredSpec: ["Shadow"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // ADDITIONAL SURVIVAL
        // Sheet-Prio: Rallying Cry(Warrior) → Demo Banner(Warrior) → SLT(Resto)
        // ══════════════════════════════════════════════════════════
        additional_surv: {
            name: "Zusaetzliches Ueberleben", shortName: "Add. Surv", color: "#f59e0b",
            spells: [
                { spellId: "97462", cooldownSec: 180, durationSec: 10 },                                       // Rallying Cry (jede Warrior-Spec)
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },                                       // Demo Banner
                { spellId: "98008", cooldownSec: 180, durationSec: 6, requiredSpec: ["Restoration1"] },      // SLT
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
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Retribution"] },
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Protection1"] },
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Holy1"] },
                { spellId: "62618", cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },
                { spellId: "98008", cooldownSec: 180, durationSec: 6, requiredSpec: ["Restoration1"] },
                // Raid-Utility
                { spellId: "97462", cooldownSec: 180, durationSec: 10 },                                       // Rallying Cry
                { spellId: "76577", cooldownSec: 180, durationSec: 5 },                                       // Smoke Bomb
                // Heals als Notfall
                { spellId: "740", cooldownSec: 180, durationSec: 8, requiredSpec: ["Restoration"] },
                { spellId: "64843", cooldownSec: 180, durationSec: 8, requiredSpec: ["Holy"] },
                { spellId: "115310", cooldownSec: 180, durationSec: 0, requiredSpec: ["Mistweaver"] },
                { spellId: "15286", cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Restoration1"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Elemental"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Enhancement"] },
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },                                       // Demo Banner
                { spellId: "51052", cooldownSec: 120, durationSec: 10 },                                       // AMZ (alle DKs)
                { spellId: "122278", cooldownSec: 90, durationSec: 10 },                                       // Dampen Harm (alle Mönche)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // ANY DEFENSIVE COOLDOWN / HEAL
        // ══════════════════════════════════════════════════════════
        any_def: {
            name: "Beliebiger Defensiv-CD", shortName: "Any Def", color: "#c084fc",
            spells: [
                // Paladin Auras
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Retribution"] },
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Protection1"] },
                { spellId: "31821", cooldownSec: 180, durationSec: 6, requiredSpec: ["Holy1"] },
                // Major Raid-CDs
                { spellId: "62618", cooldownSec: 180, durationSec: 10, requiredSpec: ["Discipline"] },
                { spellId: "98008", cooldownSec: 180, durationSec: 6, requiredSpec: ["Restoration1"] },
                { spellId: "97462", cooldownSec: 180, durationSec: 10 },
                { spellId: "76577", cooldownSec: 180, durationSec: 5 },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Restoration1"] },
                { spellId: "740", cooldownSec: 180, durationSec: 8, requiredSpec: ["Restoration"] },
                { spellId: "64843", cooldownSec: 180, durationSec: 8, requiredSpec: ["Holy"] },
                { spellId: "115310", cooldownSec: 180, durationSec: 0, requiredSpec: ["Mistweaver"] },
                { spellId: "15286", cooldownSec: 180, durationSec: 15, requiredSpec: ["Shadow"] },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Elemental"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Elemental"] },
                { spellId: "108281", cooldownSec: 120, durationSec: 10, requiredSpec: ["Enhancement"] },
                { spellId: "108280", cooldownSec: 180, durationSec: 10, requiredSpec: ["Enhancement"] },
                { spellId: "114203", cooldownSec: 180, durationSec: 15 },
                { spellId: "51052", cooldownSec: 120, durationSec: 10 },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // MOVEMENT SPEED
        // Sheet-Prio: Stampeding Roar (alle Druid-Specs)
        // ══════════════════════════════════════════════════════════
        movement: {
            name: "Bewegungsgeschw.", shortName: "Speed", color: "#22d3ee",
            spells: [
                { spellId: "77764", cooldownSec: 120, durationSec: 8, requiredSpec: ["Guardian"] },
                { spellId: "77764", cooldownSec: 120, durationSec: 8, requiredSpec: ["Feral"] },
                { spellId: "77764", cooldownSec: 120, durationSec: 8, requiredSpec: ["Balance"] },
                { spellId: "77764", cooldownSec: 120, durationSec: 8, requiredSpec: ["Restoration"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // BLOODLUST
        // Sheet-Prio: Time-Warp(Fire) → Time-Warp(Frost) → BL(Resto) → BL(Enh) → BL(Elem) → Time-Warp(Arcane)
        // ══════════════════════════════════════════════════════════
        bloodlust: {
            name: "Kampfrausch", shortName: "Lust", color: "#ef4444",
            spells: [
                { spellId: "80353", cooldownSec: 300, durationSec: 40, requiredSpec: ["Fire"] },              // Time-Warp (Fire)
                { spellId: "80353", cooldownSec: 300, durationSec: 40, requiredSpec: ["Frost"] },             // Time-Warp (Frost)
                { spellId: "2825", cooldownSec: 300, durationSec: 40, requiredSpec: ["Restoration1"] },      // Bloodlust (Resto)
                { spellId: "2825", cooldownSec: 300, durationSec: 40, requiredSpec: ["Enhancement"] },       // Bloodlust (Enh)
                { spellId: "2825", cooldownSec: 300, durationSec: 40, requiredSpec: ["Elemental"] },         // Bloodlust (Elem)
                { spellId: "80353", cooldownSec: 300, durationSec: 40, requiredSpec: ["Arcane"] },            // Time-Warp (Arcane)
                { spellId: "90355", cooldownSec: 300, durationSec: 40 },                                       // Ancient Hysteria (Hunter Pet)
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
        // MANA (NEU - für Hymn of Hope / Mana Tide)
        // ══════════════════════════════════════════════════════════
        mana: {
            name: "Mana-Regeneration", shortName: "Mana", color: "#3b82f6",
            spells: [
                { spellId: "16190", cooldownSec: 180, durationSec: 16, requiredSpec: ["Restoration1"] },      // Mana Tide Totem (Resto Shaman)
                { spellId: "16190", cooldownSec: 180, durationSec: 16, requiredSpec: ["Restoration1"] },      // Mana Tide Totem (2. für weitere Schamanen)
                { spellId: "64901", cooldownSec: 360, durationSec: 8, requiredSpec: ["Holy"] },              // Hymn of Hope (Holy)
                { spellId: "64901", cooldownSec: 360, durationSec: 8, requiredSpec: ["Discipline"] },        // Hymn of Hope (Disc)
                { spellId: "64901", cooldownSec: 360, durationSec: 8, requiredSpec: ["Shadow"] },            // Hymn of Hope (Shadow)
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
                { spellId: "30283", cooldownSec: 30, durationSec: 3, requiredSpec: ["Destruction"] },         // Shadowfury
                { spellId: "30283", cooldownSec: 30, durationSec: 3, requiredSpec: ["Demonology"] },
                { spellId: "30283", cooldownSec: 30, durationSec: 3, requiredSpec: ["Affliction"] },
                { spellId: "118905", cooldownSec: 45, durationSec: 5, requiredSpec: ["Enhancement"] },         // Capacitor Totem
                { spellId: "118905", cooldownSec: 45, durationSec: 5, requiredSpec: ["Restoration1"] },
                { spellId: "118905", cooldownSec: 45, durationSec: 5, requiredSpec: ["Elemental"] },
                { spellId: "46968", cooldownSec: 40, durationSec: 4, requiredSpec: ["Protection"] },          // Shockwave
                { spellId: "46968", cooldownSec: 40, durationSec: 4, requiredSpec: ["Fury"] },
                { spellId: "46968", cooldownSec: 40, durationSec: 4, requiredSpec: ["Arms"] },
            ]
        },

        // ══════════════════════════════════════════════════════════
        // DISARM
        // Sheet-Prio: Disarm(Fury) → Disarm(Arms) → Disarm(Prot) → Dismantle(Combat/Assa/Sub) → Grapple(WW/MW/BM) → Psychic Horror(Shadow)
        // ══════════════════════════════════════════════════════════
        disarm: {
            name: "Disarm", shortName: "Disarm", color: "#94a3b8",
            spells: [
                { spellId: "676", cooldownSec: 60, durationSec: 10, requiredSpec: ["Fury"] },               // Disarm
                { spellId: "676", cooldownSec: 60, durationSec: 10, requiredSpec: ["Arms"] },
                { spellId: "676", cooldownSec: 60, durationSec: 10, requiredSpec: ["Protection"] },
                { spellId: "51722", cooldownSec: 60, durationSec: 8, requiredSpec: ["Combat"] },             // Dismantle
                { spellId: "51722", cooldownSec: 60, durationSec: 8, requiredSpec: ["Assassination"] },
                { spellId: "51722", cooldownSec: 60, durationSec: 8, requiredSpec: ["Subtlety"] },
                { spellId: "117368", cooldownSec: 60, durationSec: 6, requiredSpec: ["Windwalker"] },         // Grapple Weapon
                { spellId: "117368", cooldownSec: 60, durationSec: 6, requiredSpec: ["Mistweaver"] },
                { spellId: "117368", cooldownSec: 60, durationSec: 6, requiredSpec: ["Brewmaster"] },
                { spellId: "64044", cooldownSec: 120, durationSec: 3, requiredSpec: ["Shadow"] },             // Psychic Horror
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
        // TANK EXTERNAL (NEU - Einzel-Target Tank-CDs)
        // ══════════════════════════════════════════════════════════
        tank_external: {
            name: "Tank External", shortName: "Tank Ext", color: "#fbbf24",
            spells: [
                { spellId: "33206", cooldownSec: 180, durationSec: 8, requiredSpec: ["Discipline"] },        // Pain Suppression
                { spellId: "47788", cooldownSec: 180, durationSec: 10, requiredSpec: ["Holy"] },              // Guardian Spirit
                { spellId: "6940", cooldownSec: 120, durationSec: 12 },                                       // HoSac (jeder Paladin)
                { spellId: "102342", cooldownSec: 60, durationSec: 12, requiredSpec: ["Restoration"] },       // Ironbark
                { spellId: "122710", cooldownSec: 120, durationSec: 12 },                                       // Vigilance (jeder Warrior)
                { spellId: "114039", cooldownSec: 30, durationSec: 6 },                                        // Hand of Purity (jeder Paladin)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // P2 TANK-SOAK (NUR PHYSISCH) - Malkorók Blutrausch
        // Personals (nur soakender Tank) + Externals (von anderen).
        // Die eigentliche gestaffelte Verteilung macht das Blood-Rage-
        // Add-on; diese Liste sorgt für Spalte, Fallback & Dropdowns.
        // ══════════════════════════════════════════════════════════
        tank_soak_phys: {
            name: "P2 Tank-Soak (phys)", shortName: "Soak", color: "#c8aa6e",
            spells: [
                // -- Personals --
                { spellId: "86659", cooldownSec: 180, durationSec: 12, requiredSpec: ["Protection1"] }, // Wächter d. ualten Könige (50%)
                { spellId: "48792", cooldownSec: 180, durationSec: 12, requiredSpec: ["Blood"] },       // Eisige Gegenwehr (50%, inkl. Sanguine F.)
                { spellId: "61336", cooldownSec: 180, durationSec: 12, requiredSpec: ["Guardian"] },    // Überlebensinstinkte (50%, 2 Ladungen)
                { spellId: "871", cooldownSec: 180, durationSec: 12, requiredSpec: ["Protection"] },  // Schildwall (40%)
                { spellId: "115203", cooldownSec: 180, durationSec: 15, requiredSpec: ["Brewmaster"] },  // Stärkendes Gebräu (20%)
                { spellId: "122278", cooldownSec: 90, durationSec: 5, requiredSpec: ["Brewmaster"] },  // Schaden dämpfen (50%, 3 Treffer)
                { spellId: "31850", cooldownSec: 180, durationSec: 10, requiredSpec: ["Protection1"] }, // Unermüdl. Verteidiger (20%) *
                { spellId: "22812", cooldownSec: 60, durationSec: 12, requiredSpec: ["Guardian"] },    // Baumrinde (20%)
                // -- Externals --
                { spellId: "33206", cooldownSec: 180, durationSec: 8, requiredSpec: ["Discipline"] },  // Schmerzunterdrücken (40%)
                { spellId: "6940", cooldownSec: 120, durationSec: 12 },                                // Hand der Aufopferung (30%)
                { spellId: "122710", cooldownSec: 120, durationSec: 12 },                                // Wachsamkeit (30%)
                { spellId: "102342", cooldownSec: 60, durationSec: 12, requiredSpec: ["Restoration"] }, // Eisenborke (20%)
                { spellId: "114039", cooldownSec: 30, durationSec: 6 },                                 // Hand der Reinheit (10%)
            ]
        },

        // ══════════════════════════════════════════════════════════
        // VIRTUELLE KATEGORIEN (TTS-Warnungen ohne Spieler-CDs)
        // ══════════════════════════════════════════════════════════
        kampfpots: {
            name: "Kampfpots (TTS)", shortName: "Pots", color: "#fca5a5",
            isVirtual: true,
            defaultPlayer: "Alle",
            defaultNote: "Kampfpots ziehen!",
            defaultTts: "pots",
            defaultName: "Kampfpots",
            defaultIcon: "18",
            spells: []
        },
        tts_warning: {
            name: "TTS Warnung", shortName: "Warn", color: "#fbbf24",
            isVirtual: true,
            defaultPlayer: "Alle",
            defaultNote: "Achtung!",
            defaultTts: "achtung",
            defaultName: "Warnung",
            defaultIcon: "1",
            spells: []
        }
    };

    // ── State ──
    var config = null;
    var categories = {};
    var assignments = [];
    var manualOverrides = {};

    // Eindeutiger Override-Key-Präfix pro Zeile. Continuous-Coverage-Folgezeilen
    // behalten eventIdx/castNum der Ursprungszeile - ohne den _contIdx-Suffix
    // würde ein manueller Override auf ALLE Folgezeilen desselben Casts wirken.
    // Namensraum eines Zeilen-Overrides. Continuous-Folgezeilen ("-c1") und die
    // Rotationszeilen des Tank-Soaks ("-s2", "-s3", ...) bekommen einen eigenen,
    // damit ein manueller CD genau in DER Zeile landet, in der er gesetzt wurde.
    // Die erste Soak-Zeile behält bewusst den Basis-Prefix - so bleiben bereits
    // gespeicherte Overrides aus älteren Plänen gültig.
    // Baut aus einem manuellen Override das Slot-Objekt der Tabelle.
    // Als eigene Funktion, weil Overrides an zwei Stellen angewendet werden:
    // in autoAssign (normale Zeilen) und nach der Blood-Rage-Expansion
    // (Soak-Rotationszeilen, die es zum Zeitpunkt von autoAssign noch nicht gab).
    function buildSlotFromOverride(ov) {
        if (!ov) return null;

        if (ov.skip) {
            return { player: null, dbName: null, auto: false, skipped: true };
        }
        if (ov.isExtraPlaceholder) {
            return { isExtraPlaceholder: true };
        }
        if (ov.isVirtualCategoryKey) {
            var vCat = categories[ov.isVirtualCategoryKey];
            if (vCat) {
                return {
                    isVirtual: true,
                    player: normalizePlayerForPlanner(ov.player === 'Alle' || ov.player === 'ALL' ? vCat.defaultPlayer : ov.player),
                    dbName: '',
                    note: vCat.defaultNote || '',
                    tts: vCat.defaultTts || '',
                    varname: vCat.defaultName || '',
                    icon: vCat.defaultIcon || '',
                    auto: false,
                    skipped: false,
                    isVirtualCategoryKey: ov.isVirtualCategoryKey
                };
            }
            // Kategorie gibt es nicht mehr -> unten als normaler Override behandeln
        }
        // Manuell zugewiesener Spieler, der nicht (mehr) im Roster ist ->
        // NICHT einplanen/exportieren, sondern sichtbar als Warnung markieren.
        if (ov.player && ov.dbName && !isPlayerInRoster(ov.player)) {
            return {
                player: ov.player, dbName: ov.dbName,
                dbClass: ov.dbClass, spellId: ov.spellId,
                cooldownSec: ov.cooldownSec, durationSec: ov.durationSec,
                auto: false, notInRoster: true
            };
        }

        var slot = JSON.parse(JSON.stringify(ov));
        slot.auto = false;
        return slot;
    }

    // Zieht die manuellen Overrides für die Soak-Rotationszeilen nach.
    // Diese Zeilen baut das Blood-Rage-Add-on erst NACH autoAssign, deshalb
    // läuft die Override-Schleife dort noch ins Leere. Ohne diesen Schritt
    // verschwindet jeder CD, den man in eine Soak-Zeile einträgt, beim
    // nächsten Auto-Zuweisen wieder.
    function applyOverridesToExpandedRows(rows) {
        (rows || []).forEach(function (row) {
            if (!row._bloodrageExpanded) return;
            var rowPrefix = rowOverridePrefix(row) + '-';
            Object.keys(manualOverrides).forEach(function (oKey) {
                if (oKey.indexOf(rowPrefix) !== 0) return;
                var slotKey = oKey.substring(rowPrefix.length);
                if (/^[cs]\d+-/.test(slotKey)) return;
                var slot = buildSlotFromOverride(manualOverrides[oKey]);
                if (slot) row.slots[slotKey] = slot;
            });
        });
    }

    function rowOverridePrefix(row) {
        return row.eventIdx + '-' + row.castNum
            + (row._contIdx ? '-c' + row._contIdx : '')
            + (row._soakIdx > 1 ? '-s' + row._soakIdx : '');
    }

    // ── Kategorie-Spezifikationen mit Anzahl ──
    // requiredCDs-Einträge können "catKey" oder "catKey:N" sein.
    // N = wie viele CDs dieser Kategorie GLEICHZEITIG bei einem Cast gebraucht
    // werden (z.B. "any_dr:2" = zwei Schadensreduktionen zusammen, wie bei
    // Beschützer-Unheil: 2× DR + 1× Heal).
    // Die Slot-Instanzen heißen dann: catKey (1.), catKey@2 (2.), catKey@3 ...
    // - so bleiben alte gespeicherte Pläne/Overrides (nur catKey) kompatibel.
    function parseCatSpec(entry) {
        if (!entry) return null;
        if (typeof entry === 'object') {
            var k = entry.cat || entry.key;
            if (!k) return null;
            return { key: k, count: Math.max(1, parseInt(entry.count) || 1) };
        }
        var s = String(entry);
        var at = s.indexOf('@');
        if (at !== -1) {
            // Explizite Slot-Instanz (z.B. Continuous-Coverage-Folgezeile "any_dr@2")
            return { key: s.slice(0, at), count: 1, instanceKey: s };
        }
        var i = s.indexOf(':');
        if (i === -1) return { key: s, count: 1 };
        return { key: s.slice(0, i), count: Math.max(1, parseInt(s.slice(i + 1)) || 1) };
    }

    // Slot-Instanz-Key ("any_dr@2") → Kategorie-Key ("any_dr")
    function baseCatKey(slotKey) {
        if (!slotKey) return slotKey;
        var at = String(slotKey).indexOf('@');
        return at === -1 ? slotKey : String(slotKey).slice(0, at);
    }

    // Instanz-Nummer eines Slot-Keys (1 für "any_dr", 2 für "any_dr@2", ...)
    function slotInstanceNum(slotKey) {
        var at = String(slotKey || '').indexOf('@');
        return at === -1 ? 1 : (parseInt(String(slotKey).slice(at + 1)) || 1);
    }

    // Alle Slot-Instanz-Keys für eine requiredCDs-Liste, Reihenfolge = Priorität.
    // ["any_dr:2", "any_heal"] → ["any_dr", "any_dr@2", "any_heal"]
    function slotKeysForRequired(requiredCDs) {
        var keys = [];
        (requiredCDs || []).forEach(function (entry) {
            var spec = parseCatSpec(entry);
            if (!spec || !spec.key) return;
            if (spec.instanceKey) {
                if (keys.indexOf(spec.instanceKey) === -1) keys.push(spec.instanceKey);
                return;
            }
            for (var n = 1; n <= spec.count; n++) {
                var k = (n === 1) ? spec.key : spec.key + '@' + n;
                if (keys.indexOf(k) === -1) keys.push(k);
            }
        });
        return keys;
    }

    // Enthält eine requiredCDs-Liste (auch mit ":N"-Suffixen) diese Kategorie?
    function requiredHasCat(requiredCDs, catKey) {
        return (requiredCDs || []).some(function (entry) {
            var spec = parseCatSpec(entry);
            return spec && spec.key === catKey;
        });
    }
    var eventOverrides = {};      // eventIdx (oder custom ID) → { disabled, firstCast, cooldown, maxCasts, name, requiredCDs, icon, delay }
    var customEvents = [];        // Komplett selbst angelegte Events (nicht aus config)
    var rosterRef = [];
    var firebaseRef = null;
    var cooldownsDB = [];

    // ── Dirty-Tracking: ungespeicherte Änderungen sichtbar machen ──
    var _isDirty = false;
    function refreshDirtyIndicator() {
        var btn = document.getElementById('btn-save-auto-plan');
        if (!btn) return;
        btn.classList.toggle('cd-save-dirty', !!_isDirty);
        btn.title = _isDirty ? 'Ungespeicherte Änderungen - klicke „Plan speichern".' : '';
    }
    function markDirty() {
        if (_isDirty) return;
        _isDirty = true;
        refreshDirtyIndicator();
    }
    function clearDirty() {
        _isDirty = false;
        refreshDirtyIndicator();
    }

    // Ist <name> im aktuellen Roster (oder ein Gruppen-Keyword / gemappter Spec-Slot)?
    // Manuelle Overrides auf Spieler, die nicht (mehr) im Roster sind, sollen NICHT
    // eingeplant oder exportiert werden.
    function isPlayerInRoster(name) {
        if (!name) return false;
        var up = String(name).toUpperCase();
        if (['ALL', 'ALLE', 'TANKS', 'TANK', 'HEALER', 'HEALERS', 'HEAL',
            'MELEE', 'MELEEDPS', 'RANGE', 'RANGED', 'RANGEDDPS'].indexOf(up) !== -1) return true;
        // Gemappte Spec-Slot-Keys (z.B. HPALA1) sind gültig, auch ohne echten Roster-Namen.
        if (window.SlotSystem && typeof window.SlotSystem.getMapping === 'function') {
            var m = window.SlotSystem.getMapping() || {};
            if (m[name] && String(m[name]).trim() !== '') return true;
        }
        var roster = window.effectiveRoster || window.rosterData || [];
        return roster.some(function (p) { return (p.name || '').toUpperCase() === up; });
    }

    // ── Verteilungs-Strategien (pro Boss konfigurierbar, in Firestore gespeichert) ──
    var assignStrategy = {
        spread: false,                // A: Lookahead - bei Knappheit gleichmäßig über Zeit verteilen
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
            classSlots.forEach(function (def) {
                var defSpecNorm = normalizeSpec(def.spec);
                var specMatch = true;
                if (requiredSpec && requiredSpec.length > 0) {
                    var specList = Array.isArray(requiredSpec) ? requiredSpec : [requiredSpec];
                    specMatch = specList.some(function (s) {
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
        return currentRoster.filter(function (p) {
            // 1. Klasse MUSS immer matchen
            if ((p.class || '').toUpperCase() !== (cls || '').toUpperCase()) return false;

            // 2. Spec-Filter hat Vorrang vor Role-Filter
            if (requiredSpec && requiredSpec.length > 0) {
                var playerSpec = p.spec || p.specName || p.specialization || '';
                if (!playerSpec) return true;   // Spieler ohne Spec-Angabe nicht ausschließen
                var specList = Array.isArray(requiredSpec) ? requiredSpec : [requiredSpec];
                var pSpecNorm = normalizeSpec(playerSpec);
                return specList.some(function (s) { return normalizeSpec(s) === pSpecNorm; });
            }

            // 3. Role-Filter (wenn kein Spec-Filter gesetzt)
            if (!requiredRole) return true;
            var roles = p.roles || [];
            var firstRole = (Array.isArray(roles) ? (roles[0] || '') : roles).toString().toLowerCase();
            if (requiredRole === 'heal') return firstRole.indexOf('heal') !== -1;
            if (requiredRole === 'tank') return firstRole.indexOf('tank') !== -1;
            if (requiredRole === 'dps') {
                return firstRole.indexOf('heal') === -1 &&
                    firstRole.indexOf('tank') === -1 &&
                    firstRole.indexOf('bench') === -1 &&
                    firstRole.indexOf('absence') === -1;
            }
            return true;
        }).map(function (p) { return p.name; });
    }

    // Ist <spellId> für <player> beim aktuellen Boss deaktiviert (Roster-Patch)?
    // Slot-Keys (z.B. 'HPALA1') matchen keine Spielernamen → werden nicht gefiltert.
    function isSpellDisabledForPlayer(player, spellId) {
        return !!(window.RosterPatches && typeof window.RosterPatches.isAbilityDisabled === 'function' &&
            window.RosterPatches.isAbilityDisabled(window.currentBossIdForPatches, player, spellId));
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
        cat.spells.forEach(function (entry) {
            var db = resolveSpell(entry.spellId);
            if (!db) return;
            result.push({
                dbName: db.name,
                dbClass: db.class,
                spellId: entry.spellId,
                cooldownSec: parseInt(db.cooldownSec) || entry.cooldownSec || 180,
                durationSec: parseInt(db.durationSec) || entry.durationSec || 0,
                requiredRole: entry.requiredRole || cat.requiredRole || null,
                requiredSpec: entry.requiredSpec || cat.requiredSpec || null,
                found: true
            });
        });
        return result;
    }

    // ── Timeline generieren ──
    // Gibt die effektive Event-Liste zurück: config.events + customEvents, mit Overrides angewendet
    function getEffectiveEvents() {
        var result = [];
        // config.events mit Overrides
        (config.events || []).forEach(function (evt, idx) {
            var key = 'cfg_' + idx;
            var ov = eventOverrides[key] || {};
            var isMythic = evt.name && (evt.name.indexOf('(HC)') !== -1 || evt.name.indexOf('(Mythisch)') !== -1 || evt.name.indexOf('(Mythic)') !== -1 || evt.name.indexOf('(M)') !== -1);
            // defaultDisabled: Event bleibt in der Config (Trigger, Zeiten), ist aber
            // standardmäßig AUS - nur Key-Fähigkeiten sind an. Per Häkchen im
            // Event-Manager reaktivierbar (Override gewinnt immer).
            var disabled = ov.disabled !== undefined ? ov.disabled : (evt.defaultDisabled === true || isMythic);
            if (disabled) return;
            result.push({
                _key: key,
                _origIdx: idx,
                _isCustom: false,
                _hasManualCDs: ov.requiredCDs !== undefined,
                name: ov.name !== undefined ? ov.name : evt.name,
                firstCast: ov.firstCast !== undefined ? ov.firstCast : evt.firstCast,
                cooldown: ov.cooldown !== undefined ? ov.cooldown : (evt.cooldown || 0),
                maxCasts: ov.maxCasts !== undefined ? ov.maxCasts : (evt.maxCasts || 1),
                delay: ov.delay !== undefined ? ov.delay : (evt.delay || 0),
                eventDuration: ov.eventDuration !== undefined ? ov.eventDuration : (evt.eventDuration || 0),
                overlapSec: ov.overlapSec !== undefined ? ov.overlapSec : (evt.overlapSec || 0),
                resetEscalation: ov.resetEscalation !== undefined ? ov.resetEscalation : (evt.resetEscalation || 0),
                escalationRanges: ov.escalationRanges !== undefined ? ov.escalationRanges : (evt.escalationRanges || []),
                continuousCoverage: ov.continuousCoverage !== undefined ? ov.continuousCoverage : (evt.continuousCoverage || false),
                requiredCDs: ov.requiredCDs !== undefined ? ov.requiredCDs.slice() : (evt.requiredCDs ? evt.requiredCDs.slice() : []),
                icon: ov.icon !== undefined ? ov.icon : (evt.icon || ''),
                spellId: evt.spellId,
                soak: ov.soak !== undefined ? ov.soak : (evt.soak || null)
            });
        });
        // customEvents (komplett vom User angelegt)
        customEvents.forEach(function (evt) {
            var ov = eventOverrides[evt._key] || {};
            if (ov.disabled) return;
            result.push({
                _key: evt._key,
                _isCustom: true,
                _hasManualCDs: true,
                name: evt.name,
                firstCast: evt.firstCast,
                cooldown: evt.cooldown || 0,
                maxCasts: evt.maxCasts || 1,
                delay: evt.delay || 0,
                eventDuration: evt.eventDuration || 0,
                overlapSec: (eventOverrides[evt._key] && eventOverrides[evt._key].overlapSec !== undefined) ? eventOverrides[evt._key].overlapSec : (evt.overlapSec || 0),
                resetEscalation: (eventOverrides[evt._key] && eventOverrides[evt._key].resetEscalation !== undefined) ? eventOverrides[evt._key].resetEscalation : (evt.resetEscalation || 0),
                escalationRanges: (eventOverrides[evt._key] && eventOverrides[evt._key].escalationRanges !== undefined) ? eventOverrides[evt._key].escalationRanges : (evt.escalationRanges || []),
                continuousCoverage: (eventOverrides[evt._key] && eventOverrides[evt._key].continuousCoverage !== undefined) ? eventOverrides[evt._key].continuousCoverage : (evt.continuousCoverage || false),
                requiredCDs: evt.requiredCDs ? evt.requiredCDs.slice() : [],
                icon: evt.icon || '',
                spellId: evt.spellId || 0,
                soak: (eventOverrides[evt._key] && eventOverrides[evt._key].soak !== undefined) ? eventOverrides[evt._key].soak : (evt.soak || null)
            });
        });

        // --- STORMLASH & BANNER AUTO-INJECT ---
        var hasEarlyBloodlust = false;
        var hasLateBloodlust = false;
        var bloodlustEventExists = false;
        var bloodlustEvts = [];

        result.forEach(function (evt) {
            if (evt.requiredCDs && requiredHasCat(evt.requiredCDs, 'bloodlust')) {
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

        // 2. Anzahl möglicher Casts ermitteln (Max aus Schamanen / Kriegern)
        var numShamans = getPlayersOfClass('SHAMAN').length;
        var numWarriors = getPlayersOfClass('WARRIOR').length;
        var maxCasts = Math.max(1, Math.max(numShamans, numWarriors));

        // 3. Folgecasts und 3-Minuten-Casts für die Bloodlust-Zeitpunkte
        bloodlustEvts.forEach(function (blEvt) {
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

            // --- Folgecasts direkt nach BL ---
            for (var i = 1; i < maxCasts; i++) {
                var currentDelay = isBlEncStart ? 0 : ((blEvt.delay || 0) + i * 10);
                result.push({
                    _key: 'auto_sl_banner_followup_' + blEvt.firstCast + '_' + i,
                    _isCustom: true,
                    _isFollowUp: true,
                    name: 'SL/Banner (Folge ' + i + ')',
                    firstCast: blEvt.firstCast + (i * 10),
                    cooldown: 0,
                    maxCasts: 1,
                    delay: currentDelay,
                    eventDuration: 0,
                    requiredCDs: ['stormlash', 'skull_banner'],
                    icon: '⚔️',
                    spellId: 0,
                    _sourceTriggerMap: blMapEntry
                });
            }

            // --- Zusätzlicher Cast + Folgecasts nach 3 Minuten (180s) ---
            for (var i = 0; i < maxCasts; i++) {
                var currentDelay = isBlEncStart ? 0 : ((blEvt.delay || 0) + i * 10);
                var timeOffset = 180 + (i * 10);
                var evtName = (i === 0) ? 'SL/Banner (Nach 3 Min)' : 'SL/Banner (Nach 3 Min, Folge ' + i + ')';

                result.push({
                    _key: 'auto_sl_banner_3min_' + blEvt.firstCast + '_' + i,
                    _isCustom: true,
                    _isFollowUp: true,
                    name: evtName,
                    firstCast: blEvt.firstCast + timeOffset,
                    cooldown: 0,
                    maxCasts: 1,
                    delay: currentDelay,
                    eventDuration: 0,
                    requiredCDs: ['stormlash', 'skull_banner'],
                    icon: '⚔️',
                    spellId: 0,
                    _sourceTriggerMap: blMapEntry
                });
            }
        });

        if (bloodlustEventExists && hasLateBloodlust && !hasEarlyBloodlust) {
            var startEvt = result.find(function (e) { return e.name === 'Kampfbeginn (SL/Banner)'; });
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
                        var encOption = Array.from(trgSelects[0].options).find(function (o) { return o.value.indexOf('ENC_START') !== -1; });
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
        effectiveEvents.forEach(function (event, eventIdx) {
            var casts = event.maxCasts || 1;
            for (var c = 0; c < casts; c++) {
                var absTime = event.firstCast + (c * (event.cooldown || 0));
                if (event.cooldown === 0 && c > 0) break;

                var currentCastNum = c + 1;
                var effectiveReqCDs = event.requiredCDs || [];

                if (event.escalationRanges && event.escalationRanges.length > 0) {
                    var evaluateCastNum = currentCastNum;
                    if (event.resetEscalation) {
                        evaluateCastNum = ((currentCastNum - 1) % event.resetEscalation) + 1;
                    }
                    var matchRange = event.escalationRanges.find(function (r) { return evaluateCastNum >= r.start && evaluateCastNum <= r.end; });
                    if (matchRange) {
                        effectiveReqCDs = matchRange.categories || [];
                    } else {
                        effectiveReqCDs = [];
                    }
                }

                timeline.push({
                    eventIdx: eventIdx,
                    eventKey: event._key,
                    // castIdx = der wievielte Cast DIESES Events (1,2,3...) - die
                    // Nummer, die auch die Eskalations-Phasen meinen. castNum wird
                    // darunter global pro Event-NAME neu vergeben und dient nur noch
                    // als Schlüsselbestandteil für gespeicherte Overrides.
                    castIdx: currentCastNum,
                    castNum: currentCastNum,
                    absTime: absTime,
                    delay: event.delay || 0,
                    eventName: event.name,
                    eventDuration: event.eventDuration || 0,
                    continuousCoverage: event.continuousCoverage || false,
                    overlapSec: event.overlapSec || 0,
                    icon: event.icon || '',
                    requiredCDs: effectiveReqCDs,
                    slots: {},
                    _sourceTriggerMap: event._sourceTriggerMap || (config.triggerMap && config.triggerMap[event.name]) || null,
                    soak: event.soak || null
                });
            }
        });
        timeline.sort(function (a, b) { return a.absTime - b.absTime; });

        var nameCounters = {};
        timeline.forEach(function (row) {
            nameCounters[row.eventName] = (nameCounters[row.eventName] || 0) + 1;
            row.castNum = nameCounters[row.eventName];
        });

        return timeline;
    }

    // Alle verwendeten Kategorie-BASIS-Keys ("any_dr:2" → "any_dr").
    // Wird für das Vorwärmen der Dropdown-Fragmente genutzt.
    function getUniqueCategoryKeys() {
        var keys = [];
        function add(entry) {
            var spec = parseCatSpec(entry);
            if (spec && spec.key && keys.indexOf(spec.key) === -1) keys.push(spec.key);
        }
        var effectiveEvents = getEffectiveEvents();
        effectiveEvents.forEach(function (e) {
            (e.requiredCDs || []).forEach(add);
            (e.escalationRanges || []).forEach(function (r) {
                (r.categories || []).forEach(add);
            });
        });
        return keys;
    }

    // ══════════════════════════════════════════════════════════════
    // AUTO-ASSIGN
    // ══════════════════════════════════════════════════════════════

    async function autoAssign(timeline) {
        var usedUntil = {};
        var lastClassUsed = {}; // catKey -> dbClass
        var cachedResolvedCats = {};
        function getResolvedCategory(catKey) {
            if (!cachedResolvedCats[catKey]) {
                cachedResolvedCats[catKey] = resolveCategory(catKey);
            }
            return cachedResolvedCats[catKey];
        }

        // Alle manuellen Overrides der Timeline als Reservierungen vormerken,
        // damit der Auto-Assign niemandem einen CD "wegnimmt", der später
        // manuell fest verplant ist. (Prefix-Scan statt Kategorie-Schleife:
        // deckt auch Slot-Instanzen wie "any_dr@2", Zusatz-CDs und per Vorlage
        // eingefügte Kategorien ab.)
        var manualReservations = {};
        timeline.forEach(function (row) {
            var prefix = rowOverridePrefix(row) + '-';
            Object.keys(manualOverrides).forEach(function (oKey) {
                if (oKey.indexOf(prefix) !== 0) return;
                var rest = oKey.substring(prefix.length);
                // Keys von Continuous-Coverage-Folgezeilen ("...-c1-cat") nicht
                // der Basiszeile zuordnen - die Folgezeile matcht selbst.
                if (/^c\d+-/.test(rest)) return;
                var ov = manualOverrides[oKey];
                if (ov && ov.player && ov.dbName && !ov.skip && !ov.isVirtualCategoryKey && !ov.isExtraPlaceholder && isPlayerInRoster(ov.player)) {
                    var k = ov.player + '::' + ov.dbName;
                    if (!manualReservations[k]) manualReservations[k] = [];
                    manualReservations[k].push({ time: row.absTime, cdSec: ov.cooldownSec || 180 });
                }
            });
        });

        function isAvailable(player, dbName, atTime, currentCdSec) {
            var key = player + '::' + dbName;
            if (usedUntil[key] && atTime < usedUntil[key]) return false;
            if (manualReservations[key]) {
                for (var i = 0; i < manualReservations[key].length; i++) {
                    var res = manualReservations[key][i];
                    if (atTime < res.time && atTime + currentCdSec > res.time) return false;
                }
            }
            return true;
        }
        function markUsed(player, dbName, cdSec, atTime) {
            usedUntil[player + '::' + dbName] = atTime + cdSec;
        }

        var spreadAllow = {};
        if (assignStrategy.spread) {
            // Gruppen: (Event, Kategorie) → Liste der Slot-INSTANZEN über alle Casts.
            // Bei "any_dr:2" zählt jeder Cast doppelt - die Kapazität muss ja beide
            // gleichzeitigen Slots aus demselben Spieler-Pool bedienen.
            var groups = {};
            timeline.forEach(function (row) {
                slotKeysForRequired(row.requiredCDs).forEach(function (slotKey) {
                    var key = row.eventIdx + '||' + baseCatKey(slotKey);
                    if (!groups[key]) groups[key] = [];
                    groups[key].push({ row: row, slotKey: slotKey });
                });
            });

            Object.keys(groups).forEach(function (gKey) {
                var rows = groups[gKey];
                var parts = gKey.split('||');
                var catKey = parts[1];

                if (rows.length <= 1) {
                    rows.forEach(function (e) {
                        spreadAllow[e.row.eventIdx + '-' + e.row.castNum + '-' + e.slotKey] = true;
                    });
                    return;
                }

                var spells = getResolvedCategory(catKey);

                // Realistische Kapazität: DISTINCTE verfügbare Spieler (nicht pro Spell
                // doppelt zählen - das war der Bug, der zu "alle CDs am Anfang, dann
                // nichts mehr" führte) und pro Spieler die tatsächlich mögliche Anzahl
                // Casts im Zeitfenster, basierend auf seinem kürzesten anwendbaren CD.
                var playerBestCd = {};
                spells.forEach(function (spell) {
                    var cd = spell.cooldownSec || 180;
                    getPlayersOfClass(spell.dbClass, spell.requiredRole, spell.requiredSpec).forEach(function (p) {
                        if (isSpellDisabledForPlayer(p, spell.spellId)) return; // nicht geskillt
                        if (playerBestCd[p] === undefined || cd < playerBestCd[p]) playerBestCd[p] = cd;
                    });
                });
                var distinctPlayers = Object.keys(playerBestCd);
                if (distinctPlayers.length === 0) return;

                var firstT = rows[0].row.absTime;
                var lastT = rows[rows.length - 1].row.absTime;
                var span = Math.max(0, lastT - firstT);

                var capacity = 0;
                distinctPlayers.forEach(function (p) {
                    capacity += 1 + Math.floor(span / playerBestCd[p]);
                });
                capacity = Math.max(1, capacity);

                if (capacity >= rows.length) {
                    // Pool kann realistisch alle Slots abdecken → jeder erlaubt
                    rows.forEach(function (e) {
                        spreadAllow[e.row.eventIdx + '-' + e.row.castNum + '-' + e.slotKey] = true;
                    });
                } else {
                    // Knappheit → genau "capacity" Slots gleichmäßig über die Zeit verteilen
                    var step = rows.length / capacity;
                    var marked = {};
                    for (var i = 0; i < capacity; i++) {
                        var idx = Math.round(i * step);
                        if (idx >= rows.length) idx = rows.length - 1;
                        marked[idx] = true;
                    }
                    rows.forEach(function (e, ri) {
                        spreadAllow[e.row.eventIdx + '-' + e.row.castNum + '-' + e.slotKey] = !!marked[ri];
                    });
                }
            });
        }

        // ──────────────────────────────────────────────────────────────
        // KATEGORIEN-PRIORISIERUNG
        // Innerhalb eines Events werden die Slots immer in der Reihenfolge
        // des requiredCDs-Arrays abgearbeitet (Index 0 = höchste Prio,
        // Mehrfach-Slots direkt hintereinander): die zuerst gelistete
        // Kategorie greift beim gemeinsamen Spieler-Pool zuerst zu,
        // spätere gehen bei Knappheit leer aus.
        // ──────────────────────────────────────────────────────────────

        // ──────────────────────────────────────────────────────────────
        // STRATEGIE C - ROUND-ROBIN
        // Counter pro (Spell+Spieler-Klasse-Kombo) zurücksetzen, damit
        // wir Spieler-Listen rotieren können statt immer Index 0 zu nehmen.
        // ──────────────────────────────────────────────────────────────
        _rrCounters = {};

        function pickPlayer(players, spell, atTime) {
            // Liefert ersten verfügbaren Spieler aus der Liste,
            // unter Berücksichtigung von Round-Robin wenn aktiv.
            if (!players.length) return null;
            // Spieler ausschließen, für die diese Fähigkeit deaktiviert ist (nicht geskillt).
            players = players.filter(function (p) { return !isSpellDisabledForPlayer(p, spell.spellId); });
            if (!players.length) return null;
            var cdSec = spell.cooldownSec || 180;

            if (assignStrategy.roundRobin) {
                var rrKey = spell.dbName + '::' + spell.dbClass;
                var start = _rrCounters[rrKey] || 0;
                for (var k = 0; k < players.length; k++) {
                    var idx = (start + k) % players.length;
                    if (isAvailable(players[idx], spell.dbName, atTime, cdSec)) {
                        _rrCounters[rrKey] = (idx + 1) % players.length;
                        return players[idx];
                    }
                }
                return null;
            }

            for (var i = 0; i < players.length; i++) {
                if (isAvailable(players[i], spell.dbName, atTime, cdSec)) return players[i];
            }
            return null;
        }

        function normalizePlayerForPlanner(p) {
            if (!p) return 'ALL';
            var up = p.toUpperCase();
            if (up === 'ALLE' || up === 'ALL') return 'ALL';
            if (up === 'TANKS' || up === 'TANK') return 'TANKS';
            if (up === 'HEALER' || up === 'HEALERS' || up === 'HEAL') return 'HEALERS';
            if (up === 'MELEE' || up === 'MELEEDPS') return 'MELEEDPS';
            if (up === 'RANGE' || up === 'RANGED' || up === 'RANGEDDPS') return 'RANGEDDPS';
            return p; // Keep class names like Priest as is
        }

        var chunkCounter = 0;
        var finalAssignments = [];

        while (timeline.length > 0) {
            var row = timeline.shift();
            finalAssignments.push(row);

            chunkCounter++;
            if (chunkCounter % 15 === 0) {
                await new Promise(function (r) { setTimeout(r, 0); });
            }

            // Slot-Instanzen dieser Zeile: erst die benötigten Kategorien
            // (Reihenfolge = Priorität, inkl. Mehrfach-Slots wie "any_dr@2"),
            // danach alle manuell überschriebenen Slots (Zusatz-CDs, Vorlagen).
            var requiredSlotKeys = slotKeysForRequired(row.requiredCDs);
            var iterSlots = requiredSlotKeys.slice();

            var rowPrefix = rowOverridePrefix(row) + '-';
            Object.keys(manualOverrides).forEach(function (oKey) {
                if (oKey.indexOf(rowPrefix) !== 0) return;
                var ck = oKey.substring(rowPrefix.length);
                // Overrides von Continuous-Coverage-Folgezeilen ("c1-...") und
                // Soak-Rotationszeilen ("s2-...") gehören nicht zur Basiszeile.
                if (/^[cs]\d+-/.test(ck)) return;
                if (iterSlots.indexOf(ck) === -1) iterSlots.push(ck);
            });

            iterSlots.forEach(function (slotKey) {
                var catKey = baseCatKey(slotKey);
                var isRequired = requiredSlotKeys.indexOf(slotKey) !== -1;
                var oKey = rowPrefix + slotKey;
                var hasOverride = !!manualOverrides[oKey];

                if (!isRequired && !hasOverride) return;

                if (hasOverride) {
                    var ov = manualOverrides[oKey];
                    var ovSlot = buildSlotFromOverride(ov);
                    row.slots[slotKey] = ovSlot;
                    // Nur echte Zuweisungen belegen den Spieler-Cooldown.
                    if (!ovSlot.skipped && !ovSlot.isExtraPlaceholder && !ovSlot.isVirtual
                        && !ovSlot.notInRoster && ov.player && ov.dbName) {
                        markUsed(ov.player, ov.dbName, ov.cooldownSec || 180, row.absTime);
                    }
                    return;
                }

                if (!isRequired) return;

                var catConfig = categories[catKey];
                if (catConfig && catConfig.isVirtual) {
                    row.slots[slotKey] = {
                        isVirtual: true,
                        player: normalizePlayerForPlanner(catConfig.defaultPlayer),
                        dbName: '',
                        note: catConfig.defaultNote || '',
                        tts: catConfig.defaultTts || '',
                        varname: catConfig.defaultName || '',
                        icon: catConfig.defaultIcon || '',
                        auto: true
                    };
                    return;
                }

                // Spread-Check: wenn diese Slot-Instanz durch die Spread-Maske
                // blockiert ist → leerer "geplante Lücke"-Slot
                if (assignStrategy.spread) {
                    var allow = spreadAllow[row.eventIdx + '-' + row.castNum + '-' + slotKey];
                    if (allow === false) {
                        row.slots[slotKey] = { player: null, dbName: null, auto: true, spreadGap: true };
                        return;
                    }
                }

                var spells = getResolvedCategory(catKey);

                if (assignStrategy.preferHeal) {
                    spells.sort(function (a, b) {
                        var aHeal = (a.requiredRole === 'healer') ? 1 : 0;
                        var bHeal = (b.requiredRole === 'healer') ? 1 : 0;
                        return bHeal - aHeal;
                    });
                }

                if (assignStrategy.strictClassBalance && lastClassUsed[catKey]) {
                    var lastClass = lastClassUsed[catKey];
                    var diffClass = [];
                    var sameClass = [];
                    spells.forEach(function (s) {
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
                        row.slots[slotKey] = {
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
                    row.slots[slotKey] = { player: null, dbName: null, auto: true, unavailable: true };
                }

                // Continuous Coverage Logic
                if (assigned && row.continuousCoverage && row.eventDuration > 0 && row.slots[slotKey].durationSec) {
                    var dur = row.slots[slotKey].durationSec;
                    var remaining = row.eventDuration - dur;
                    if (remaining > 0) {
                        var nextAbsTime = row.absTime + dur + (row.overlapSec || 0);
                        var nextDelay = row.delay + dur + (row.overlapSec || 0);

                        // Folgezeile NUR für diese Slot-Instanz einreihen (der
                        // Instanz-Key "any_dr@2" bleibt erhalten, damit zwei
                        // parallele Slots derselben Kategorie getrennte
                        // Folgezeilen-Overrides bekommen).
                        timeline.push({
                            eventIdx: row.eventIdx,
                            eventKey: row.eventKey,
                            castIdx: row.castIdx,
                            castNum: row.castNum,
                            absTime: nextAbsTime,
                            delay: nextDelay,
                            eventName: row.eventName + ' (Forts. ' + catKey + ')',
                            eventDuration: remaining,
                            continuousCoverage: true,
                            overlapSec: row.overlapSec || 0,
                            icon: row.icon || '',
                            requiredCDs: [slotKey],
                            slots: {},
                            _sourceTriggerMap: row._sourceTriggerMap,
                            _isContinuous: true,
                            _contIdx: (row._contIdx || 0) + 1,
                            _continuousOffset: (row._continuousOffset || 0) + dur + (row.overlapSec || 0),
                            soak: row.soak || null
                        });
                        timeline.sort(function (a, b) { return a.absTime - b.absTime; });
                    }
                }
            });
        }

        // The original timeline arrays were returned by autoAssign, but now finalAssignments holds them in sorted order.
        return finalAssignments;
    }

    // ══════════════════════════════════════════════════════════════
    // UI RENDERING
    // ══════════════════════════════════════════════════════════════

    // Auto-injizierte Lust&Banner-Hilfszeilen (SL/Banner Folge-Casts,
    // 3-Minuten-Wiederholungen, Kampfbeginn-SL/Banner) - standardmäßig
    // ausgeblendet, per Toggle unter der Tabelle einblendbar. Die Zuweisung
    // und der Export laufen unabhängig davon ganz normal weiter.
    var _showLustBanner = false;
    function isLustBannerHelperRow(row) {
        return typeof row.eventKey === 'string' && row.eventKey.indexOf('auto_') === 0;
    }

    // Eingeklappte Event-Blöcke (eventKey → true). Ein Event mit vielen Casts
    // (z.B. Kreischen mit 28) lässt sich so zu einer Zeile zusammenfalten,
    // damit die anderen Fähigkeiten übersichtlich bleiben. Reine Anzeige -
    // Zuweisung, Speichern und Export bleiben unberührt.
    var _collapsedEvents = {};

    function renderTimeline(timeline) {
        var thead = document.getElementById('auto-planner-thead');
        var tbody = document.getElementById('auto-planner-tbody');
        if (!thead || !tbody) return;
        var catKeys = getUniqueCategoryKeys();

        // ── Anzeige-Reihenfolge: nach EVENT gruppiert ──
        // Kampfbeginn (t=0) zuerst, danach jedes Event als Block mit seinen
        // Casts #1, #2, #3... direkt untereinander (statt zeitlich mit anderen
        // Events verschachtelt). Blöcke sortiert nach ihrem ersten Cast.
        // WICHTIG: nur die DARSTELLUNG ist gruppiert - die Zuweisung selbst
        // (autoAssign) bleibt chronologisch, sonst stimmt die CD-Verfügbarkeit
        // nicht. data-row zeigt weiter auf den Original-Index in assignments.
        var groupMin = {};
        timeline.forEach(function (row) {
            var g = row.eventKey || row.eventName;
            if (groupMin[g] === undefined || row.absTime < groupMin[g]) groupMin[g] = row.absTime;
        });
        var displayIdx = timeline.map(function (_, i) { return i; });
        displayIdx.sort(function (a, b) {
            var ra = timeline[a], rb = timeline[b];
            var ga = ra.eventKey || ra.eventName, gb = rb.eventKey || rb.eventName;
            if (ga !== gb) {
                var d = groupMin[ga] - groupMin[gb];
                if (d !== 0) return d;
                return ga < gb ? -1 : (ga > gb ? 1 : 0);
            }
            if (ra.absTime !== rb.absTime) return ra.absTime - rb.absTime;
            return a - b;
        });

        // Lust&Banner-Hilfszeilen ausblenden (Standard) - Toggle unten
        var lbRowCount = timeline.filter(isLustBannerHelperRow).length;
        var hasLustBanner = lbRowCount > 0 || timeline.some(function (r) {
            return requiredHasCat(r.requiredCDs, 'stormlash') || requiredHasCat(r.requiredCDs, 'skull_banner');
        });
        if (!_showLustBanner) {
            displayIdx = displayIdx.filter(function (i) { return !isLustBannerHelperRow(timeline[i]); });
        }

        // ── Event-Gruppen (für das Ein-/Ausklappen einzelner Fähigkeiten) ──
        var groups = [];
        var groupOf = {};
        displayIdx.forEach(function (i) {
            var row = timeline[i];
            var g = row.eventKey || row.eventName;
            if (!groupOf[g]) {
                groupOf[g] = { key: g, name: row.eventName, icon: row.icon || '', idxs: [] };
                groups.push(groupOf[g]);
            }
            groupOf[g].idxs.push(i);
        });
        // Eingeklappte Gruppen fliegen komplett aus der Darstellung - dadurch
        // verschwinden auch ihre Spalten und die restlichen CDs rücken zusammen.
        var visibleIdx = [];
        groups.forEach(function (g) {
            g.collapsed = !!_collapsedEvents[g.key];
            if (!g.collapsed) visibleIdx = visibleIdx.concat(g.idxs);
        });

        // ── Matrix mit Instanz-Spalten ──
        // Eine Spalte pro Slot-Instanz: "any_dr:2" ergibt zwei nebeneinander-
        // liegende Spalten (Any DR #1 / Any DR #2). Spalten kommen nur aus den
        // SICHTBAREN Zeilen; eingeklappte Events und ausgeblendetes Lust&Banner
        // nehmen ihre Spalten mit.
        var colKeys = [];
        visibleIdx.forEach(function (i) {
            var row = timeline[i];
            slotKeysForRequired(row.requiredCDs).forEach(function (k) {
                if (colKeys.indexOf(k) === -1) colKeys.push(k);
            });
            // Auch manuell belegte Kategorien als Spalte zeigen. Die frühere
            // "Zusatz-CDs"-Spalte gibt es nicht mehr; alte extra_-Zuweisungen
            // aus gespeicherten Plänen bekommen trotzdem eine Spalte, damit sie
            // sichtbar (und per Dropdown entfernbar) sind statt unsichtbar
            // mitexportiert zu werden.
            Object.keys(row.slots || {}).forEach(function (k) {
                var s = row.slots[k];
                if (s && s.isExtraPlaceholder) return;
                if (k.indexOf('extra_') === 0 && !(s && s.player)) return;
                if (colKeys.indexOf(k) === -1) colKeys.push(k);
            });
        });
        if (!_showLustBanner) {
            colKeys = colKeys.filter(function (k) {
                var b = baseCatKey(k);
                return b !== 'stormlash' && b !== 'skull_banner';
            });
        }
        // Instanzen derselben Kategorie nebeneinander gruppieren,
        // Reihenfolge der Basis-Kategorien = erste Erscheinung.
        var baseOrder = [];
        colKeys.forEach(function (k) {
            var b = baseCatKey(k);
            if (baseOrder.indexOf(b) === -1) baseOrder.push(b);
        });
        colKeys.sort(function (a, b) {
            var da = baseOrder.indexOf(baseCatKey(a)) - baseOrder.indexOf(baseCatKey(b));
            if (da !== 0) return da;
            return slotInstanceNum(a) - slotInstanceNum(b);
        });
        // Hat eine Kategorie mehrere Instanz-Spalten? (für "#1"-Beschriftung)
        var baseHasSiblings = {};
        colKeys.forEach(function (k) {
            var b = baseCatKey(k);
            baseHasSiblings[b] = (baseHasSiblings[b] || 0) + 1;
        });

        // Thead
        var thCols = colKeys.map(function (k) {
            var b = baseCatKey(k);
            var isLegacyExtra = b.indexOf('extra_') === 0;
            var cat = categories[b];
            var c = isLegacyExtra ? '#64748b' : (cat ? cat.color : '#888');
            var inst = slotInstanceNum(k);
            var n = isLegacyExtra ? 'Zusatz (alt)' : (cat ? cat.shortName : b);
            if (!isLegacyExtra && baseHasSiblings[b] > 1) n += ' #' + inst;
            var t = isLegacyExtra ? ' title="Zusatz-CD aus einem älteren Plan. Über das Dropdown auf „-" setzen, um ihn zu entfernen."' : '';
            return '<th class="py-2 px-2 min-w-[170px]"' + t + ' style="border-bottom:2px solid ' + c + ';"><span style="color:' + c + ';">' + n + '</span></th>';
        }).join('');

        // Die Delay-Spalte ist ein reines Export-Stellrad - für Gäste nur Rauschen.
        var canEdit = !!window.isManager;
        var fixedCols = canEdit ? 5 : 4;

        thead.innerHTML = '<tr class="text-left text-gray-400 uppercase tracking-wider border-b border-slate-700 text-[10px]">'
            + '<th class="py-2 px-1 w-8"></th>'
            + '<th class="py-2 px-2 w-16">ETA</th>'
            + '<th class="py-2 px-2 min-w-[130px]">Event</th>'
            + '<th class="py-2 px-1 w-8 text-center">#</th>'
            + (canEdit ? '<th class="py-2 px-1 w-10 text-center" title="Verzögerung zum Trigger (für Export)">Delay</th>' : '')
            + thCols + '</tr>';

        // Tbody
        // Dropdown-Optionen werden NICHT mehr eager in jede Zelle eingebettet.
        // Signatur aktualisieren → gecachte Fragmente werden nur dann neu gebaut,
        // wenn sich Roster/CDs/Kategorien geändert haben (siehe getDropdownFragment).
        _dropdownSig = computeDropdownSig();

        // Was ändert sich gegenüber dem vorherigen Cast desselben Events?
        // "+Heal −DR" direkt an der Zeile macht die Eskalationsstufen sichtbar,
        // ohne dass man die Kategorie-Spalten vergleichen muss.
        function escalationDelta(prevReq, curReq) {
            function specs(list) {
                var m = {};
                (list || []).forEach(function (entry) {
                    var sp = parseCatSpec(entry);
                    if (sp && sp.key) m[sp.key] = sp.count;
                });
                return m;
            }
            var a = specs(prevReq), b = specs(curReq);
            var parts = [];
            function label(key, count) {
                var c = categories[key];
                return (c ? c.shortName : key) + (count > 1 ? '×' + count : '');
            }
            function color(key) {
                var c = categories[key];
                return c ? c.color : '#94a3b8';
            }
            Object.keys(b).forEach(function (k) {
                if (a[k] === undefined) parts.push('<span style="color:' + color(k) + ';">+' + label(k, b[k]) + '</span>');
                else if (a[k] !== b[k]) parts.push('<span style="color:' + color(k) + ';">' + label(k, b[k]) + '</span>');
            });
            Object.keys(a).forEach(function (k) {
                if (b[k] === undefined) parts.push('<span class="text-slate-600">−' + label(k, a[k]) + '</span>');
            });
            return parts.join(' ');
        }

        function renderRow(rowIdx, isFirstOfGroup, group, nInGroup) {
            var row = timeline[rowIdx];
            var isNew = isFirstOfGroup;

            var requiredKeys = slotKeysForRequired(row.requiredCDs);

            var cells = colKeys.map(function (slotKey) {
                var slot = row.slots[slotKey];
                var isReq = requiredKeys.indexOf(slotKey) !== -1;

                // Skipped - bewusst „kein CD nötig", also so leise wie möglich
                if (slot && slot.skipped) {
                    return '<td class="relative py-1 px-1 align-middle bg-slate-900/30 border border-slate-700/40" style="max-width:105px; height:34px;" title="Hier ist bewusst kein Cooldown eingeplant.">'
                        + '<div class="pointer-events-none w-full flex items-center justify-center h-full text-center"><span class="text-[11px] text-slate-600">✖</span></div>'
                        + '<select class="auto-plan-select absolute inset-0 w-full h-full opacity-0 cursor-pointer" data-row="' + rowIdx + '" data-cat="' + slotKey + '">'
                        + '<option value="">-- Cooldown --</option>'
                        + '<option value="__SKIP__" selected>✖ Kein CD nötig</option>'
                        + '</select></td>';
                }

                // Nicht required, kein Override → dezenter Strich (klickbar)
                if (!isReq && (!slot || !slot.player)) {
                    return '<td class="relative py-1 px-1 opacity-50 hover:opacity-100 transition-opacity align-middle bg-slate-900/20 border border-slate-700/50" style="max-width:105px; height:34px;">'
                        + '<div class="pointer-events-none w-full flex items-center justify-center h-full text-center"><span class="text-[11px] text-gray-500">-</span></div>'
                        + '<select class="auto-plan-select absolute inset-0 w-full h-full opacity-0 cursor-pointer" data-row="' + rowIdx + '" data-cat="' + slotKey + '">'
                        + '<option value="" selected>-</option></select></td>';
                }

                // Spread-Gap: geplante Lücke durch Strategie A (Spread)
                if (slot && slot.spreadGap) {
                    return '<td class="relative py-1 px-1 align-middle bg-slate-900/25 border border-slate-700/40" style="max-width:105px; height:34px;" title="Geplante Lücke (Spread-Strategie): hier wurde absichtlich kein Spieler eingeplant, um die verfügbaren CDs über die Zeit zu strecken.">'
                        + '<div class="pointer-events-none w-full flex items-center justify-center h-full text-center"><span class="text-[11px] text-cyan-500/50">~</span></div>'
                        + '<select class="auto-plan-select absolute inset-0 w-full h-full opacity-0 cursor-pointer" data-row="' + rowIdx + '" data-cat="' + slotKey + '">'
                        + '<option value="" selected>~ Spread-Lücke</option>'
                        + '<option value="__SKIP__">✖ Kein CD nötig</option>'
                        + '</select></td>';
                }

                // Manuell zugewiesen, aber Spieler nicht (mehr) im Roster → Warnung.
                // Die bleibt farbig: hier muss wirklich jemand ran.
                if (slot && slot.notInRoster) {
                    return '<td class="relative py-1 px-1 align-middle bg-orange-900/20 border border-orange-700/40" style="max-width:105px; height:34px;" title="' + (slot.player || '') + ' ist nicht im aktuellen Roster - wird NICHT eingeplant/exportiert. Bitte neu zuweisen oder Spieler ins Roster aufnehmen.">'
                        + '<div class="pointer-events-none w-full flex flex-col items-center justify-center h-full text-center">'
                        + '<div class="font-bold text-[11px] leading-[13px] truncate w-full text-center text-orange-300/80" style="text-decoration:line-through;">' + (slot.player || '') + '</div>'
                        + '<div class="text-[8px] leading-[10px] truncate w-full text-center text-orange-400/70">nicht im Roster</div>'
                        + '</div>'
                        + '<select class="auto-plan-select absolute inset-0 w-full h-full opacity-0 cursor-pointer" data-row="' + rowIdx + '" data-cat="' + slotKey + '">'
                        + '<option value="" selected>⚠ ' + (slot.player || '') + ' (nicht im Roster)</option>'
                        + '<option value="__SKIP__">✖ Kein CD nötig</option>'
                        + '</select></td>';
                }

                // Unavailable - kein CD frei. Dezent, sonst leuchtet bei 28 Casts
                // die halbe Tabelle rot; die Gesamtzahl steht in der Statuszeile.
                if (!slot || slot.unavailable) {
                    return '<td class="relative py-1 px-1 align-middle bg-slate-900/25 border border-slate-700/40" style="max-width:105px; height:34px;" title="Kein Cooldown dieser Kategorie war zu diesem Zeitpunkt frei.">'
                        + '<div class="pointer-events-none w-full flex items-center justify-center h-full text-center"><span class="text-[10px] text-rose-400/55">----</span></div>'
                        + '<select class="auto-plan-select absolute inset-0 w-full h-full opacity-0 cursor-pointer" data-row="' + rowIdx + '" data-cat="' + slotKey + '">'
                        + '<option value="" selected>⚠ kein CD</option>'
                        + '<option value="__SKIP__">✖ Kein CD nötig</option>'
                        + '</select></td>';
                }

                // Zugewiesen
                var color = getClassColor(slot.dbClass);
                var bg = slot.auto ? 'bg-slate-800/50' : 'bg-yellow-900/30';
                var brd = slot.auto ? 'border-slate-700/50' : 'border-yellow-600/50';
                var title = 'Dauer: ' + (slot.durationSec || '?') + 's | CD: ' + (slot.cooldownSec || '?') + 's';
                var pStr = slot.player || '';
                var dStr = slot.dbName || (slot.isVirtual ? (categories[slot.isVirtualCategoryKey || baseCatKey(slotKey)] ? categories[slot.isVirtualCategoryKey || baseCatKey(slotKey)].name : 'Virtuell') : '');

                return '<td class="relative py-1 px-1 align-middle ' + bg + ' border ' + brd + '" style="max-width:105px; height:34px;" title="' + title + '">'
                    + '<div class="pointer-events-none w-full flex flex-col items-center justify-center h-full">'
                    + '<div class="font-bold text-[11px] leading-[13px] truncate w-full text-center" style="color:' + color + ';">' + pStr + '</div>'
                    + '<div class="text-[9px] leading-[11px] truncate w-full text-center opacity-80" style="color:' + color + ';">' + dStr + '</div>'
                    + '</div>'
                    + '<select class="auto-plan-select absolute inset-0 w-full h-full opacity-0 cursor-pointer" data-row="' + rowIdx + '" data-cat="' + slotKey + '">'
                    + '<option value="">-- Cooldown --</option>'
                    + '<option value="__SKIP__">✖ Kein CD nötig</option>'
                    + '</select></td>';
            }).join('');

            var durLabel = row.eventDuration ? ' <span class="text-gray-600 text-[9px]">(' + row.eventDuration + 's)</span>' : '';
            var tooltipStr = "";
            var mapEntry = config.triggerMap && config.triggerMap[row.eventName];
            if (typeof mapEntry === 'string') tooltipStr = mapEntry;
            else if (mapEntry && mapEntry.trigger) tooltipStr = mapEntry.trigger;

            // Eskalationsstufe: unterscheiden sich die geforderten Kategorien vom
            // vorherigen Cast desselben Events, wird die Änderung angeschrieben.
            var deltaHtml = '';
            if (!isNew && group && nInGroup > 0) {
                var prevRow = timeline[group.idxs[nInGroup - 1]];
                if (prevRow) deltaHtml = escalationDelta(prevRow.requiredCDs, row.requiredCDs);
            }

            // Erste Zeile eines Events: Name + Einklapp-Pfeil. Folgezeilen: „↳".
            var nameCell = isNew
                ? '<button class="evt-collapse-btn text-left w-full text-gray-200 font-medium hover:text-cyan-300" data-key="' + group.key + '" title="Diesen Event-Block einklappen">'
                + '▾ ' + row.eventName + '</button>'
                : '<span class="text-gray-500">↳</span>'
                + (deltaHtml ? ' <span class="text-[9px]" title="Änderung gegenüber dem vorherigen Cast">' + deltaHtml + '</span>' : '');

            return '<tr class="hover:bg-slate-800/30 transition-colors ' + (isNew ? 'border-t border-slate-600/80' : (deltaHtml ? 'border-t border-slate-600/50' : 'border-t border-slate-800/30')) + '">'
                + '<td class="py-1 px-1 text-center text-sm">' + row.icon + '</td>'
                + '<td class="py-1 px-2 font-mono text-gray-300" title="Absolute Kampfzeit">' + fmt(row.absTime) + '</td>'
                + '<td class="py-1 px-2" title="' + tooltipStr + '">' + nameCell + durLabel + '</td>'
                + '<td class="py-1 px-1 text-center text-gray-500" title="Der wievielte Cast dieses Events">' + (row.castIdx || row.castNum) + '</td>'
                + (canEdit
                    ? '<td class="py-1 px-1 text-center"><input type="number" class="auto-plan-delay w-10 bg-slate-800/40 text-[11px] text-center text-gray-400 border border-slate-700/60 rounded px-1 py-0.5" data-row="' + rowIdx + '" value="' + (row.delay || 0) + '" title="Verzögerung (neg=vorher)"></td>'
                    : '')
                + cells + '</tr>';
        }

        // Kurzfassung der Eskalation eines Event-Blocks: aufeinanderfolgende Casts
        // mit gleichen Kategorien zusammenfassen → "#1–5 DR · #6 DR+Heal · #7–28 …".
        // So sieht man den geplanten Aufbau auch, ohne 28 Zeilen aufzuklappen.
        function escalationSummary(idxs) {
            var phases = [];
            var cur = null;
            idxs.forEach(function (i, n) {
                var row = timeline[i];
                var castNo = row.castIdx || row.castNum || (n + 1);
                var labels = (row.requiredCDs || []).map(function (entry) {
                    var spec = parseCatSpec(entry);
                    if (!spec) return { text: String(entry), color: '#94a3b8' };
                    var c = categories[spec.key];
                    return {
                        text: (c ? c.shortName : spec.key) + (spec.count > 1 ? '×' + spec.count : ''),
                        color: c ? c.color : '#94a3b8'
                    };
                });
                var sig = labels.map(function (l) { return l.text; }).join('+');
                if (cur && cur.sig === sig) { cur.end = castNo; return; }
                if (cur) phases.push(cur);
                cur = { start: castNo, end: castNo, sig: sig, labels: labels };
            });
            if (cur) phases.push(cur);
            if (phases.length < 2) return '';   // ohne Aufbau lohnt die Zeile nicht

            return phases.map(function (p) {
                var span = p.start === p.end ? '#' + p.start : '#' + p.start + '–' + p.end;
                var cats = p.labels.length
                    ? p.labels.map(function (l) { return '<span style="color:' + l.color + ';">' + l.text + '</span>'; }).join('+')
                    : '<span class="text-slate-600">-</span>';
                return '<span class="text-slate-500">' + span + '</span>&nbsp;' + cats;
            }).join('<span class="text-slate-700"> · </span>');
        }

        // Eingeklappter Event-Block: eine Zeile mit Kurzfassung
        function renderCollapsedGroup(group) {
            var casts = group.idxs.length;
            var cdCount = group.idxs.reduce(function (n, i) {
                return n + Object.keys(timeline[i].slots || {}).filter(function (k) {
                    var s = timeline[i].slots[k];
                    return s && s.player && s.player !== '__SKIP__';
                }).length;
            }, 0);
            var firstT = Math.min.apply(null, group.idxs.map(function (i) { return timeline[i].absTime; }));
            var lastT = Math.max.apply(null, group.idxs.map(function (i) { return timeline[i].absTime; }));
            var span = (casts > 1) ? (fmt(firstT) + '–' + fmt(lastT)) : fmt(firstT);
            var esc = escalationSummary(group.idxs);

            return '<tr class="border-t border-slate-600/80 bg-slate-900/40">'
                + '<td class="py-1 px-1 text-center text-sm">' + group.icon + '</td>'
                + '<td class="py-1 px-2 font-mono text-gray-500 text-[10px]">' + span + '</td>'
                + '<td class="py-1 px-2" colspan="' + (fixedCols - 2 + colKeys.length) + '">'
                + '<button class="evt-collapse-btn text-left text-gray-300 hover:text-cyan-300 font-medium" data-key="' + group.key + '" title="Diesen Event-Block wieder ausklappen">'
                + '▸ ' + group.name
                + ' <span class="text-gray-500 font-normal text-[10px]">(' + casts + ' Cast' + (casts === 1 ? '' : 's') + ', ' + cdCount + ' CDs eingeklappt)</span>'
                + '</button>'
                + (esc ? '<div class="text-[10px] leading-[14px] mt-0.5 pl-3">' + esc + '</div>' : '')
                + '</td></tr>';
        }

        var rows = '';

        // Steuerzeile: alles ein-/ausklappen + Lust&Banner-Umschalter
        var collapsedCount = groups.filter(function (g) { return g.collapsed; }).length;
        var ctrl = '<button id="btn-collapse-all" class="bg-slate-900/40 hover:bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-gray-400 py-1 px-2" '
            + 'title="Alle Event-Blöcke einklappen">⊟ Alle einklappen</button>'
            + '<button id="btn-expand-all" class="bg-slate-900/40 hover:bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-gray-400 py-1 px-2" '
            + 'title="Alle Event-Blöcke ausklappen">⊞ Alle ausklappen</button>';
        if (hasLustBanner) {
            ctrl += '<button id="btn-toggle-lustbanner" class="bg-slate-900/40 hover:bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-gray-400 py-1 px-2" '
                + 'title="Die automatischen Stormlash/Banner-Folge-Casts werden auch ausgeblendet ganz normal zugewiesen und exportiert.">'
                + (_showLustBanner
                    ? '▾ ⚔️ Lust &amp; Banner ausblenden'
                    : '▸ ⚔️ Lust &amp; Banner einblenden (' + lbRowCount + ')')
                + '</button>';
        }
        if (collapsedCount > 0) {
            ctrl += '<span class="text-[10px] text-cyan-400/80 self-center">'
                + collapsedCount + (collapsedCount === 1 ? ' Block' : ' Blöcke') + ' eingeklappt</span>';
        }
        rows += '<tr><td colspan="' + (fixedCols + colKeys.length) + '" class="py-1 px-1">'
            + '<div class="flex flex-wrap gap-2">' + ctrl + '</div></td></tr>';

        groups.forEach(function (g) {
            if (g.collapsed) {
                rows += renderCollapsedGroup(g);
            } else {
                g.idxs.forEach(function (rowIdx, n) {
                    rows += renderRow(rowIdx, n === 0, g, n);
                });
            }
        });

        tbody.innerHTML = rows;

        // Set dropdown values
        timeline.forEach(function (row, rowIdx) {
            var allSlotKeys = Object.keys(row.slots);
            allSlotKeys.forEach(function (slotKey) {
                var slot = row.slots[slotKey];
                if (!slot || (!slot.player && !slot.isVirtual)) return;
                var sel = tbody.querySelector('select[data-row="' + rowIdx + '"][data-cat="' + slotKey + '"]');
                if (!sel) return;

                var catKey = baseCatKey(slotKey);
                var val;
                if (slot.isVirtualCategoryKey) {
                    var playerStr = slot.player === 'Alle' ? 'ALL' : slot.player;
                    val = playerStr + '::__VIRTUAL__::' + slot.isVirtualCategoryKey;
                } else if (slot.isVirtual && !slot.dbName) {
                    var playerStr = slot.player === 'Alle' ? 'ALL' : slot.player;
                    val = playerStr + '::__VIRTUAL__::' + catKey;
                } else {
                    val = slot.player + '::' + slot.dbName;
                }

                if (!Array.from(sel.options).some(function (o) { return o.value === val; })) {
                    var virtCat = categories[slot.isVirtualCategoryKey || catKey];
                    var displayCatName = slot.isVirtual ? (virtCat ? virtCat.name : 'Virtuell') : slot.dbName;
                    var opt = new Option(slot.player + ' → ' + displayCatName, val);
                    opt.style.color = getClassColor(slot.dbClass || 'General');
                    opt.dataset.tmp = '1';
                    sel.appendChild(opt);
                }
                sel.value = val;
                sel.style.color = getClassColor(slot.dbClass || 'General');
            });
        });

        // Listeners: Dropdown (Event Delegation)
        if (!tbody._hasAutoPlanListener) {
            tbody._hasAutoPlanListener = true;
            // Optionen erst beim Fokussieren/Öffnen eines Selects befüllen (lazy).
            tbody.addEventListener('focusin', function (e) {
                if (e.target && e.target.classList && e.target.classList.contains('auto-plan-select')) {
                    fillSelectOptions(e.target);
                }
            });
            // Ein-/Ausklappen (Event-Blöcke, Lust&Banner) - reine Anzeige,
            // deshalb kein markDirty() und kein Neuberechnen der Zuweisung.
            tbody.addEventListener('click', function (e) {
                if (!e.target || !e.target.closest) return;
                var cb = e.target.closest('.evt-collapse-btn');
                if (cb) {
                    var k = cb.dataset.key;
                    if (_collapsedEvents[k]) delete _collapsedEvents[k];
                    else _collapsedEvents[k] = true;
                    renderTimeline(assignments);
                    return;
                }
                if (e.target.closest('#btn-collapse-all')) {
                    (assignments || []).forEach(function (r) {
                        _collapsedEvents[r.eventKey || r.eventName] = true;
                    });
                    renderTimeline(assignments);
                    return;
                }
                if (e.target.closest('#btn-expand-all')) {
                    _collapsedEvents = {};
                    renderTimeline(assignments);
                    return;
                }
                if (e.target.closest('#btn-toggle-lustbanner')) {
                    _showLustBanner = !_showLustBanner;
                    renderTimeline(assignments);
                    return;
                }
            });
            tbody.addEventListener('change', function (e) {
                if (!e.target || !e.target.classList.contains('auto-plan-select')) return;

                var ri = parseInt(e.target.dataset.row);
                var ck = e.target.dataset.cat;
                var row = assignments[ri];
                if (!row) return;
                var oKey = rowOverridePrefix(row) + '-' + ck;

                if (!e.target.value) {
                    delete manualOverrides[oKey];
                } else if (e.target.value === '__SKIP__') {
                    manualOverrides[oKey] = { player: '__SKIP__', dbName: '__SKIP__', skip: true };
                } else {
                    var parts = e.target.value.split('::');
                    var player = parts[0], dbName = parts[1];

                    if (dbName === '__VIRTUAL__') {
                        var virtKey = parts[2];
                        manualOverrides[oKey] = {
                            player: player, dbName: '__VIRTUAL__',
                            isVirtualCategoryKey: virtKey
                        };
                    } else {
                        var dbEntry = cooldownsDB.find(function (cd) { return cd.name === dbName; });
                        var catSpell = resolveCategory(baseCatKey(ck)).find(function (s) { return s.dbName === dbName; });
                        manualOverrides[oKey] = {
                            player: player, dbName: dbName,
                            dbClass: dbEntry ? dbEntry.class : 'UNKNOWN',
                            spellId: dbEntry ? dbEntry.spellId : '',
                            cooldownSec: (catSpell && catSpell.cooldownSec) || parseInt(dbEntry && dbEntry.cooldownSec) || 180,
                            durationSec: (catSpell && catSpell.durationSec) || parseInt(dbEntry && dbEntry.durationSec) || 0
                        };
                    }
                }
                markDirty();
                runAutoAssign();
            });
        }

        // Listeners: Delay
        tbody.querySelectorAll('.auto-plan-delay').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                var ri = parseInt(e.target.dataset.row);
                if (assignments[ri]) assignments[ri].delay = parseInt(e.target.value) || 0;
                markDirty();
            });
        });

        var missing = timeline.filter(function (r) {
            return Object.values(r.slots).some(function (s) { return s.unavailable; });
        }).length;
        var hidden = [];
        var lbHidden = timeline.length - displayIdx.length;
        if (lbHidden > 0) hidden.push(lbHidden + ' Lust/Banner-Zeilen ausgeblendet');
        var collapsedRows = displayIdx.length - visibleIdx.length;
        if (collapsedRows > 0) hidden.push(collapsedRows + ' Zeilen eingeklappt');
        updateStatus(timeline.length + ' Events, ' + missing + ' ohne CD'
            + (hidden.length ? ' - ' + hidden.join(', ') : ''));

        if (typeof window._autoPlannerApplyProtection === 'function') {
            window._autoPlannerApplyProtection();
        }

        // Optionsfragmente im Leerlauf vorbauen, damit das erste Öffnen instant ist.
        prewarmDropdowns(catKeys);
    }

    // ── Lazy-Dropdown-Cache ──────────────────────────────────────────
    // Die vollständigen Optionslisten (CD × Spieler) sind riesig. Sie werden
    // NICHT mehr in jede Tabellenzelle eingebettet (das erzeugte hunderttausende
    // <option>-Knoten und ließ die Seite 10-20s hängen), sondern erst beim
    // Öffnen eines konkreten Selects per fillSelectOptions() injiziert.
    //
    // Performance: Die Optionen werden EINMAL in ein <template> geparst und als
    // DocumentFragment gecacht. Beim Öffnen wird nur noch geklont (cloneNode) -
    // das spart das teure erneute HTML-Parsing pro Select. Der Cache überlebt
    // re-renders und wird nur neu gebaut, wenn sich Roster/CDs/Kategorien ändern
    // (erkannt über eine Signatur). Zusätzlich werden die Fragmente nach jedem
    // Render im Browser-Leerlauf (requestIdleCallback) vorgebaut, damit das erste
    // Öffnen sofort ist.
    var _dropdownFragCache = {};   // key -> { sig, frag }
    var _dropdownSig = '';

    function computeDropdownSig() {
        var roster = window.effectiveRoster || window.rosterData || [];
        var rosterPart = roster.map(function (p) {
            return (p.name || '') + (p.class || '') + (p.spec || p.specName || p.specialization || '');
        }).join(',');
        // Deaktivierte Fähigkeiten mit in die Signatur, damit Änderungen die
        // gecachten Optionsfragmente neu bauen.
        var disabledPart = '';
        if (window.RosterPatches && typeof window.RosterPatches.getBossDisabledAbilities === 'function') {
            disabledPart = JSON.stringify(window.RosterPatches.getBossDisabledAbilities(window.currentBossIdForPatches) || {});
        }
        return (cooldownsDB ? cooldownsDB.length : 0) + '|' + roster.length + '|' + rosterPart
            + '|' + Object.keys(categories).length + '|' + disabledPart;
    }

    function getDropdownFragment(catKey) {
        // Zusatz-CDs teilen sich ein Fragment; Slot-Instanzen ("any_dr@2")
        // nutzen das Fragment ihrer Basis-Kategorie.
        var key = (catKey && catKey.indexOf('extra_') === 0) ? '__EXTRA__' : baseCatKey(catKey);
        var entry = _dropdownFragCache[key];
        if (!entry || entry.sig !== _dropdownSig) {
            var tpl = document.createElement('template');
            tpl.innerHTML = buildDropdownOptions(key);
            entry = { sig: _dropdownSig, frag: tpl.content };
            _dropdownFragCache[key] = entry;
        }
        return entry.frag;
    }

    function fillSelectOptions(sel) {
        if (!sel || sel._optionsFilled) return;
        sel._optionsFilled = true;
        var frag = getDropdownFragment(sel.dataset.cat);
        if (!frag) return;
        var current = sel.value;
        sel.appendChild(frag.cloneNode(true));
        // Falls der aktuell gewählte Wert sowohl als temporär angehängte Option
        // (data-tmp) als auch im Katalog vorkommt → das Duplikat entfernen.
        if (current) {
            var dupes = Array.prototype.filter.call(sel.options, function (o) { return o.value === current; });
            if (dupes.length > 1) {
                dupes.forEach(function (o) { if (o.dataset && o.dataset.tmp === '1') o.remove(); });
            }
            sel.value = current;
        }
    }

    // Baut die Optionsfragmente im Leerlauf vor, damit das erste Öffnen instant ist.
    function prewarmDropdowns(keys, i) {
        i = i || 0;
        if (i >= keys.length) return;
        try { getDropdownFragment(keys[i]); } catch (e) { /* ignore */ }
        var next = function () { prewarmDropdowns(keys, i + 1); };
        if (window.requestIdleCallback) window.requestIdleCallback(next, { timeout: 500 });
        else setTimeout(next, 30);
    }

    // ── Dropdown: Empfohlen + Alle CDs + Virtuell ──
    function buildDropdownOptions(catKey) {
        var html = '';

        function renderSection(isSpec) {
            var sectionHtml = '';
            var recommended = resolveCategory(catKey);

            if (recommended.length > 0) {
                var recHtml = '';
                var byClassR = {};
                // KEIN Dedup mehr nach dbName: derselbe Spell kann für mehrere Specs
                // hinterlegt sein (z.B. Devotion Aura für Retri/Prot/Holy). Früher
                // überlebte nur der erste Eintrag, wodurch Spieler anderer Specs (z.B.
                // der Prot-Pala) in der Empfohlen-Liste fehlten.
                recommended.forEach(function (s) {
                    if (!byClassR[s.dbClass]) byClassR[s.dbClass] = [];
                    byClassR[s.dbClass].push(s);
                });
                Object.entries(byClassR).forEach(function (entry) {
                    var cls = entry[0], spells = entry[1];
                    var color = getClassColor(cls);
                    var anyRendered = false;
                    var emitted = {}; // player::dbName → schon ausgegeben (keine Doppel)
                    spells.forEach(function (s) {
                        var players = getPlayersOfClass(cls, s.requiredRole, s.requiredSpec, isSpec);
                        if (!players.length) return;
                        var dur = s.durationSec ? ' [' + s.durationSec + 's]' : '';
                        var specMark = '';
                        if (s.requiredSpec) {
                            var specs = Array.isArray(s.requiredSpec) ? s.requiredSpec : [s.requiredSpec];
                            var labels = specs.map(function (v) { return getSpecLabel(v).replace(/\s*\([^)]+\)/, ''); });
                            specMark = ' [' + labels.join('/') + ']';
                        } else if (s.requiredRole) {
                            specMark = ' (' + s.requiredRole + ')';
                        }
                        players.forEach(function (p) {
                            if (isSpellDisabledForPlayer(p, s.spellId)) return; // deaktiviert (nicht geskillt)
                            var ekey = p + '::' + s.dbName;
                            if (emitted[ekey]) return;
                            emitted[ekey] = true;
                            if (!anyRendered) {
                                recHtml += '<option disabled style="font-weight:bold; color:' + color + '; background:#1a202c;">── ' + cls + ' ──</option>';
                                anyRendered = true;
                            }
                            recHtml += '<option value="' + p + '::' + s.dbName + '" style="color:' + color + ';">★ ' + p + ' → ' + s.dbName + dur + specMark + '</option>';
                        });
                    });
                });
                if (recHtml) {
                    sectionHtml += '<option disabled style="font-weight:bold; color:' + (isSpec ? '#a855f7' : '#fbbf24') + '; background:#1a202c;">═══ ' + (isSpec ? 'SPEC SLOTS (EMPFOHLEN)' : 'EMPFOHLEN') + ' ═══</option>' + recHtml;
                }
            }

            var allCDs = cooldownsDB.filter(function (cd) {
                return cd.name && cd.spellId && cd.spellId !== "nil" && cd.name.indexOf('---') !== 0 && cd.name.indexOf('-- ') !== 0 && cd.type !== 'Personal';
            });
            var byClassA = {};
            allCDs.forEach(function (cd) {
                var cls = (cd.class || 'UNKNOWN').toUpperCase();
                if (!byClassA[cls]) byClassA[cls] = [];
                if (!byClassA[cls].some(function (x) { return x.name === cd.name; })) byClassA[cls].push(cd);
            });

            if (Object.keys(byClassA).length > 0) {
                var allHtml = '';
                Object.entries(byClassA).forEach(function (entry) {
                    var cls = entry[0], cds = entry[1];
                    var players = getPlayersOfClass(cls, null, null, isSpec);
                    if (!players.length) return;
                    var color = getClassColor(cls);
                    allHtml += '<option disabled style="font-weight:bold; color:' + color + '; background:#1a202c; opacity:0.7;">── ' + cls + ' ──</option>';
                    players.forEach(function (p) {
                        cds.forEach(function (cd) {
                            if (isSpellDisabledForPlayer(p, cd.spellId)) return; // deaktiviert (nicht geskillt)
                            allHtml += '<option value="' + p + '::' + cd.name + '" style="color:' + color + '; opacity:0.8;">' + p + ' → ' + cd.name + '</option>';
                        });
                    });
                });
                if (allHtml) {
                    sectionHtml += '<option disabled style="font-weight:bold; color:#64748b; background:#1a202c;">═══ ' + (isSpec ? 'SPEC SLOTS (ALLE CDs)' : 'ALLE CDs') + ' ═══</option>' + allHtml;
                }
            }

            // Virtuelle Kategorien (Warnungen)
            if (!isSpec) {
                var virtHtml = '';
                Object.keys(categories).forEach(function (vKey) {
                    var cat = categories[vKey];
                    if (cat && cat.isVirtual && cat.name) {
                        var playerVal = cat.defaultPlayer || 'ALL';
                        var playerDisplay = playerVal;
                        if (playerVal === 'ALL') playerDisplay = 'Alle';
                        if (playerVal === 'TANKS') playerDisplay = 'Tanks';
                        if (playerVal === 'HEALERS') playerDisplay = 'Heiler';
                        if (playerVal === 'MELEEDPS') playerDisplay = 'Melee';
                        if (playerVal === 'RANGEDDPS') playerDisplay = 'Range';

                        var ttsHint = cat.defaultTts ? ' (TTS: ' + cat.defaultTts + ')' : '';
                        virtHtml += '<option value="' + playerVal + '::__VIRTUAL__::' + vKey + '" style="color:' + cat.color + ';">★ ' + playerDisplay + ' → ' + cat.name + ttsHint + '</option>';
                    }
                });
                if (virtHtml) {
                    sectionHtml += '<option disabled style="font-weight:bold; color:#f43f5e; background:#1a202c;">═══ VIRTUELL (WARNUNGEN) ═══</option>' + virtHtml;
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
            btn.title = 'Events wurden geändert - klicke Auto-Assign, um die Vorschau zu aktualisieren.';
        }
        updateStatus('Events geändert - "Auto-Assign" klicken, um die Vorschau neu zu berechnen.');
    }

    function clearPreviewStale() {
        var btn = document.getElementById('btn-auto-assign');
        if (btn) {
            btn.classList.remove('animate-pulse');
            btn.style.boxShadow = '';
            btn.title = '';
        }
    }

    async function runAutoAssign() {
        var btn = document.getElementById('btn-auto-assign');
        var oldBtnHTML = '';
        if (btn) {
            oldBtnHTML = btn.innerHTML;
            btn.innerHTML = '<span class="animate-pulse">⏳ Berechne...</span>';
            btn.disabled = true;
        }

        try {
            rosterRef = window.effectiveRoster || window.rosterData || [];
            var timeline = generateTimeline();
            assignments = await autoAssign(timeline);

            // ── Blood-Rage-Soak: Events mit Kategorie tank_soak_phys expandieren ──
            if (window.CD_BLOODRAGE) {
                assignments = window.CD_BLOODRAGE.applyToAssignments(assignments, {
                    catKey: "tank_soak_phys",
                    planOpts: { expectedHitDmg: 1800000, threshold: 0.50, swingSec: 1.5 } // nur Fallback
                });
                // Die Rotationszeilen entstehen erst hier - manuelle CDs, die in
                // einer dieser Zeilen stehen, jetzt nachziehen.
                applyOverridesToExpandedRows(assignments);
            }

            renderTimeline(assignments);
            renderEventManager();
            clearPreviewStale();
            // Manager-Schutz erneut anwenden (neu erzeugte Felder)
            if (typeof window._autoPlannerApplyProtection === 'function') {
                window._autoPlannerApplyProtection();
            }
        } finally {
            if (btn) {
                btn.innerHTML = oldBtnHTML;
                btn.disabled = false;
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // EVENT MANAGER - Events deaktivieren, editieren, hinzufügen
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
                '#auto-planner-events .evt-header { font-size:9px; text-transform:uppercase; color:#94a3b8; letter-spacing:0.05em; border-bottom:1px solid #334155; padding-bottom:4px; margin-bottom:2px; }' +
                '#auto-planner-events .evt-settings-btn.active { border-color:#22d3ee !important; color:#67e8f9 !important; box-shadow:0 0 0 1px rgba(34,211,238,0.45) inset; }' +
                '#auto-planner-events .evt-soak-btn.active { box-shadow:0 0 0 1px rgba(200,170,110,0.7) inset; background:#1a1408 !important; }' +
                '#auto-planner-events .evt-cat-btn.custom { border-color:#34d399 !important; color:#6ee7b7 !important; }' +
                '#auto-planner-events .evt-trg-btn.mode-hp, #auto-planner-events .evt-trg-btn.mode-cast { font-weight:bold; }' +
                '#auto-planner-events .evt-row.has-settings { box-shadow:inset 3px 0 0 0 #22d3ee; }' +
                '@keyframes cdSaveBlink { 0%,100% { box-shadow:0 0 0 0 rgba(250,204,21,0); } 50% { box-shadow:0 0 0 3px rgba(250,204,21,0.95); } }' +
                '#btn-save-auto-plan.cd-save-dirty { animation:cdSaveBlink 1s ease-in-out infinite; }';
            document.head.appendChild(st);
        }

        // Für Anzeige brauchen wir alle Events (auch deaktivierte)
        var allRows = [];
        (config.events || []).forEach(function (evt, idx) {
            var key = 'cfg_' + idx;
            var ov = eventOverrides[key] || {};
            var isMythic = evt.name && (evt.name.indexOf('(HC)') !== -1 || evt.name.indexOf('(Mythisch)') !== -1 || evt.name.indexOf('(Mythic)') !== -1 || evt.name.indexOf('(M)') !== -1);
            var disabled = ov.disabled !== undefined ? ov.disabled : (evt.defaultDisabled === true || isMythic);
            allRows.push({
                _key: key, _isCustom: false,
                disabled: !!disabled,
                name: ov.name !== undefined ? ov.name : evt.name,
                firstCast: ov.firstCast !== undefined ? ov.firstCast : evt.firstCast,
                cooldown: ov.cooldown !== undefined ? ov.cooldown : (evt.cooldown || 0),
                maxCasts: ov.maxCasts !== undefined ? ov.maxCasts : (evt.maxCasts || 1),
                requiredCDs: ov.requiredCDs !== undefined ? ov.requiredCDs : (evt.requiredCDs || []),
                icon: ov.icon !== undefined ? ov.icon : (evt.icon || ''),
                triggerOverride: ov.triggerOverride,
                _hasManualCDs: ov.requiredCDs !== undefined,
                eventDuration: ov.eventDuration !== undefined ? ov.eventDuration : (evt.eventDuration || 0),
                escalationRanges: ov.escalationRanges !== undefined ? ov.escalationRanges : (evt.escalationRanges || []),
                overlapSec: ov.overlapSec !== undefined ? ov.overlapSec : (evt.overlapSec || 0),
                resetEscalation: ov.resetEscalation !== undefined ? ov.resetEscalation : (evt.resetEscalation || 0),
                continuousCoverage: ov.continuousCoverage !== undefined ? ov.continuousCoverage : (evt.continuousCoverage || false),
                soak: ov.soak !== undefined ? ov.soak : (evt.soak || null)
            });
        });
        customEvents.forEach(function (evt) {
            var ov = eventOverrides[evt._key] || {};
            allRows.push({
                _key: evt._key, _isCustom: true,
                disabled: !!ov.disabled,
                name: evt.name, firstCast: evt.firstCast, cooldown: evt.cooldown || 0,
                maxCasts: evt.maxCasts || 1, requiredCDs: evt.requiredCDs || [], icon: evt.icon || '',
                triggerOverride: ov.triggerOverride,
                _hasManualCDs: true,
                eventDuration: ov.eventDuration !== undefined ? ov.eventDuration : (evt.eventDuration || 0),
                escalationRanges: ov.escalationRanges !== undefined ? ov.escalationRanges : (evt.escalationRanges || []),
                overlapSec: ov.overlapSec !== undefined ? ov.overlapSec : (evt.overlapSec || 0),
                resetEscalation: ov.resetEscalation !== undefined ? ov.resetEscalation : (evt.resetEscalation || 0),
                continuousCoverage: ov.continuousCoverage !== undefined ? ov.continuousCoverage : (evt.continuousCoverage || false),
                soak: ov.soak !== undefined ? ov.soak : (evt.soak || null)
            });
        });

        var header = '<div class="evt-row evt-header"><span></span><span>Ikon</span><span>Zeit</span><span>Name</span><span title="Cooldown zwischen Casts">CD</span><span title="Anzahl Casts">Casts</span><span title="Verzögerung">Delay</span><span>Kategorien</span><span title="Trigger-Modus für Export">Trigger</span><span></span></div>';

        var html = allRows.map(function (r) {
            var catLabels = (r.requiredCDs || []).map(function (entry) {
                var spec = parseCatSpec(entry);
                if (!spec) return String(entry);
                var c = categories[spec.key];
                var label = c ? c.shortName : spec.key;
                return spec.count > 1 ? label + ' ×' + spec.count : label;
            }).join(', ');
            if (!catLabels) catLabels = '-';

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

            // Welche Event-Einstellungen sind aktiv (abweichend von "leer/Standard")?
            var settingsBits = [];
            if (r.eventDuration > 0) settingsBits.push('Dauer ' + r.eventDuration + 's');
            if (r.escalationRanges && r.escalationRanges.length) settingsBits.push(r.escalationRanges.length + ' Eskal.-Phasen');
            if (r.continuousCoverage) settingsBits.push('Durchgehende Abdeckung');
            if (r.overlapSec > 0) settingsBits.push('Overlap ' + r.overlapSec + 's');
            if (r.resetEscalation > 0) settingsBits.push('Reset ' + r.resetEscalation + 's');
            var settingsActive = settingsBits.length > 0;
            var soakConfigured = !!r.soak;
            var catsCustom = !!r._hasManualCDs;
            var rowHasSettings = settingsActive || soakConfigured || catsCustom || (tMode !== 'auto');

            var settingsTitle = 'Event-Dauer & Eskalations-Phasen'
                + (settingsActive ? ' - AKTIV: ' + settingsBits.join(', ') : '');

            return '<div class="evt-row ' + (r.disabled ? 'disabled' : '') + (rowHasSettings ? ' has-settings' : '') + '" data-key="' + r._key + '">'
                + '<input type="checkbox" class="evt-enabled" data-key="' + r._key + '"' + (r.disabled ? '' : ' checked') + ' title="Aktiv">'
                + '<input type="text" class="evt-icon" data-key="' + r._key + '" value="' + (r.icon || '') + '" style="width:100%;text-align:center;padding:2px;" title="Emoji/Icon">'
                + '<input type="number" class="evt-first" data-key="' + r._key + '" value="' + r.firstCast + '" step="5" title="Erste Zeit (Sekunden)">'
                + '<input type="text" class="evt-name" data-key="' + r._key + '" value="' + (r.name || '').replace(/"/g, '&quot;') + '" placeholder="Event-Name">'
                + '<input type="number" class="evt-cd" data-key="' + r._key + '" value="' + r.cooldown + '" step="1" title="Cooldown zwischen Casts">'
                + '<input type="number" class="evt-max" data-key="' + r._key + '" value="' + r.maxCasts + '" min="1" step="1" title="Anzahl Casts">'
                + '<input type="number" class="evt-delay" data-key="' + r._key + '" value="' + ((eventOverrides[r._key] && eventOverrides[r._key].delay !== undefined) ? eventOverrides[r._key].delay : (r._isCustom ? (customEvents.find(function (c) { return c._key === r._key; }) || {}).delay || 0 : ((config.events[parseInt(r._key.replace("cfg_", ""))] || {}).delay || 0))) + '" step="1" title="Verzögerung (neg=vorher)">'
                + (function () {
                    var soakBtnVisible = requiredHasCat(r.requiredCDs, 'tank_soak_phys');
                    return '<div style="display:flex;gap:4px;min-width:0;">'
                        + '<button class="evt-cat-btn' + (catsCustom ? ' custom' : '') + '" data-key="' + r._key + '" title="' + (catsCustom ? 'Kategorien angepasst - ' : '') + 'Klicken um Kategorien zu ändern" style="flex:1;min-width:0;">' + catLabels + ' ' + customBadge + (catsCustom ? ' ✎' : '') + '</button>'
                        + (soakBtnVisible ? '<button class="evt-soak-btn' + (soakConfigured ? ' active' : '') + '" data-key="' + r._key + '" title="Soak-Einstellungen' + (soakConfigured ? ' (konfiguriert)' : '') + '" style="flex:0 0 auto;background:#0f172a;border:1px solid #c8aa6e;color:#c8aa6e;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;">🛡</button>' : '')
                        + '<button class="evt-settings-btn' + (settingsActive ? ' active' : '') + '" data-key="' + r._key + '" title="' + settingsTitle.replace(/"/g, '&quot;') + '" style="flex:0 0 auto;background:#0f172a;border:1px solid #64748b;color:#94a3b8;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;">⚙️' + (settingsActive ? '<span style="color:#22d3ee;">•</span>' : '') + '</button>'
                        + '<button class="evt-copy-btn" data-key="' + r._key + '" title="Komplette CD-Einteilung dieses Events auf ein anderes Event kopieren" style="flex:0 0 auto;background:#0f172a;border:1px solid #64748b;color:#94a3b8;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;">⧉</button>'
                        + '</div>';
                })()
                + '<button class="evt-trg-btn mode-' + tMode + '" data-key="' + r._key + '" title="Trigger-Modus für Export anpassen">' + tLabel + '</button>'
                + (r._isCustom ? '<button class="text-red-400 hover:text-red-300 text-xs evt-delete" data-key="' + r._key + '" title="Löschen">🗑</button>' : '<span class="text-gray-600 text-[9px] text-center" title="Basis-Event aus Config">cfg</span>')
                + '</div>';
        }).join('');

        container.innerHTML = '<div class="flex items-center justify-between mb-2">'
            + '<div class="text-xs font-bold text-gray-300">📋 Events (' + allRows.filter(function (r) { return !r.disabled; }).length + ' aktiv / ' + allRows.length + ' gesamt)</div>'
            + '<button id="btn-add-event" class="bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] py-1 px-2 rounded border border-emerald-500">+ Event hinzufügen</button>'
            + '</div>'
            + header + html;

        attachEventManagerListeners();

        // Sicherheitsnetz: Die Danger-Zone hängt neben diesem Container, kann
        // aber bei sehr alten Boss-Layouts noch darin liegen. Falls sie durch das
        // innerHTML-Neuzeichnen verschwunden ist, hier wieder aufbauen.
        if (window.isManager && !document.getElementById('planner-danger-zone')) {
            injectResetEventsButton();
            injectWipeButton();
        }
    }

    function attachEventManagerListeners() {
        // Aktiv-Toggle
        document.querySelectorAll('.evt-enabled').forEach(function (cb) {
            cb.addEventListener('change', function (e) {
                var key = e.target.dataset.key;
                if (!eventOverrides[key]) eventOverrides[key] = {};
                eventOverrides[key].disabled = !e.target.checked;
                markDirty();
                renderEventManager();
                markPreviewStale();
            });
        });

        // Icon
        document.querySelectorAll('.evt-icon').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                setOverride(e.target.dataset.key, 'icon', e.target.value);
            });
        });

        // FirstCast
        document.querySelectorAll('.evt-first').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                setOverride(e.target.dataset.key, 'firstCast', parseFloat(e.target.value) || 0);
            });
        });

        // Name
        document.querySelectorAll('.evt-name').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                setOverride(e.target.dataset.key, 'name', e.target.value);
            });
        });

        // Cooldown
        document.querySelectorAll('.evt-cd').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                setOverride(e.target.dataset.key, 'cooldown', parseFloat(e.target.value) || 0);
            });
        });

        // MaxCasts
        document.querySelectorAll('.evt-max').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                setOverride(e.target.dataset.key, 'maxCasts', parseInt(e.target.value) || 1);
            });
        });

        // Delay
        document.querySelectorAll('.evt-delay').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                setOverride(e.target.dataset.key, 'delay', parseFloat(e.target.value) || 0);
            });
        });

        // Kategorien-Button → Modal
        document.querySelectorAll('.evt-cat-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                openEventCategoryPicker(e.currentTarget.dataset.key);
            });
        });

        // Soak-Einstellungen → Modal
        document.querySelectorAll('.evt-soak-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                openEventSoakPicker(e.currentTarget.dataset.key);
            });
        });

        // Event-Settings (Dauer, Eskalation) → Modal
        document.querySelectorAll('.evt-settings-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                openEventSettingsPicker(e.currentTarget.dataset.key);
            });
        });

        // CD-Einteilung auf ein anderes Event kopieren → Modal
        document.querySelectorAll('.evt-copy-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                openEventCopyPicker(e.currentTarget.dataset.key);
            });
        });

        // Trigger-Button → Trigger-Modus-Modal
        document.querySelectorAll('.evt-trg-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                openEventTriggerPicker(e.currentTarget.dataset.key);
            });
        });

        // Delete (nur Custom)
        document.querySelectorAll('.evt-delete').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                var key = e.currentTarget.dataset.key;
                if (!confirm('Event wirklich löschen?')) return;
                customEvents = customEvents.filter(function (evt) { return evt._key !== key; });
                delete eventOverrides[key];
                markDirty();
                renderEventManager();
                markPreviewStale();
            });
        });

        // Add Event
        var addBtn = document.getElementById('btn-add-event');
        if (addBtn) {
            addBtn.addEventListener('click', function () {
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
                markDirty();
                renderEventManager();
                markPreviewStale();
            });
        }
    }

    function setOverride(key, field, value, silent) {
        // Bei Custom-Events direkt in customEvents schreiben statt in eventOverrides
        var custom = customEvents.find(function (e) { return e._key === key; });
        if (custom) {
            custom[field] = value;
        } else {
            if (!eventOverrides[key]) eventOverrides[key] = {};
            eventOverrides[key][field] = value;
        }
        markDirty();

        if (!silent) {
            // Event-Änderungen NICHT mehr sofort in die Vorschau verteilen - erst auf
            // "Auto-Assign". Nur den Event-Manager neu zeichnen und Vorschau als veraltet markieren.
            renderEventManager();
            markPreviewStale();
        }
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
                    .filter(function (o) { return o.value; })
                    .map(function (o) { return { val: o.value, text: o.textContent }; });
            }
        }
        if (!npcOptions.length) {
            var anyNpcSelect = document.querySelector('select[data-assignment-id$="-npc"]');
            var anyNpcDatalist = document.querySelector('datalist[id$="-npc-list"]');
            if (anyNpcSelect) {
                npcOptions = Array.from(anyNpcSelect.options)
                    .filter(function (o) { return o.value; })
                    .map(function (o) { return o.value; });
            } else if (anyNpcDatalist) {
                npcOptions = Array.from(anyNpcDatalist.options)
                    .filter(function (o) { return o.value; })
                    .map(function (o) { return o.value; });
            }
        }

        // HEALTH-Trigger aus den Options filtern (nur der mit "HEALTH" im Val)
        var healthTrigger = triggerOptions.find(function (t) { return t.val && t.val.indexOf('HEALTH') !== -1; });

        // Overlay
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';
        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:520px;width:90%;';

        // Trigger-Auswahl (alle verfügbaren Trigger aus Boss-HTML, sofern vorhanden)
        var triggerDropdown = '';
        if (triggerOptions.length) {
            triggerDropdown = '<select id="trg-pick-trigger" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm">'
                + '<option value="">- Aus triggerMap (Default) -</option>'
                + triggerOptions.map(function (t) {
                    return '<option value="' + t.val + '"' + (currentTrigger === t.val ? ' selected' : '') + ' title="' + t.val + '">' + t.text + '</option>';
                }).join('')
                + '</select>';
        }

        // NPC-Dropdown (nur wenn HEALTH-Trigger)
        var npcDropdown = '';
        if (npcOptions.length) {
            npcDropdown = '<select id="trg-pick-npc" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm">'
                + '<option value="">- NPC wählen -</option>'
                + npcOptions.map(function (n) {
                    return '<option value="' + n + '"' + (currentNpc === n ? ' selected' : '') + '>' + n + '</option>';
                }).join('')
                + '</select>';
        }

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-1">Trigger-Modus</h4>'
            + '<div class="text-xs text-gray-400 mb-4">Wie soll dieses Event beim Export in den CD-Planer geschrieben werden?</div>'

            + '<div class="space-y-3 mb-4">'

            // Modus: Auto
            + '<label class="block p-3 bg-slate-900/50 rounded border border-slate-700 cursor-pointer hover:border-slate-500">'
            + '<div class="flex items-start gap-2">'
            + '<input type="radio" name="trg-mode" value="auto" class="mt-1"' + (currentMode === 'auto' ? ' checked' : '') + '>'
            + '<div class="flex-1">'
            + '<div class="text-sm font-bold text-gray-200">Auto (aus triggerMap)</div>'
            + '<div class="text-[10px] text-gray-500">Nutzt die Standard-Zuordnung aus der Boss-Config</div>'
            + '</div>'
            + '</div>'
            + '</label>'

            // Modus: Cast-Counter
            + '<label class="block p-3 bg-slate-900/50 rounded border border-slate-700 cursor-pointer hover:border-slate-500">'
            + '<div class="flex items-start gap-2">'
            + '<input type="radio" name="trg-mode" value="cast" class="mt-1"' + (currentMode === 'cast' ? ' checked' : '') + '>'
            + '<div class="flex-1">'
            + '<div class="text-sm font-bold text-sky-300">Cast-Counter (#1, #2, #3...)</div>'
            + '<div class="text-[10px] text-gray-500 mb-2">Condition-Feld wird die fortlaufende Cast-Nummer</div>'
            + '<div class="text-[10px] text-gray-400 mb-1">Trigger-Typ im Planer (leer = aus triggerMap):</div>'
            + (triggerDropdown || '<input type="text" id="trg-pick-trigger" value="' + (currentTrigger || '').replace(/"/g, '&quot;') + '" placeholder="z.B. SHAPRIDE_BANISHMENT" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm font-mono">')
            + '</div>'
            + '</div>'
            + '</label>'

            // Modus: HP-Prozent
            + '<label class="block p-3 bg-slate-900/50 rounded border border-slate-700 cursor-pointer hover:border-slate-500">'
            + '<div class="flex items-start gap-2">'
            + '<input type="radio" name="trg-mode" value="hp" class="mt-1"' + (currentMode === 'hp' ? ' checked' : '') + '>'
            + '<div class="flex-1">'
            + '<div class="text-sm font-bold text-red-300">HP-Prozent</div>'
            + '<div class="text-[10px] text-gray-500 mb-2">Condition wird der HP-%-Wert, NPC wird ausgewählt</div>'
            + '<div class="grid grid-cols-2 gap-2">'
            + '<div><label class="text-[10px] text-gray-400">Prozent</label><input type="number" id="trg-pick-percent" value="' + currentPercent + '" min="1" max="100" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm"></label></div>'
            + '<div><label class="text-[10px] text-gray-400">NPC</label>' + (npcDropdown || '<input type="text" id="trg-pick-npc" value="' + currentNpc + '" placeholder="NPC-Name" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm">') + '</div>'
            + '</div>'
            + '</div>'
            + '</div>'
            + '</label>'

            + '</div>'

            + '<div class="flex justify-end gap-2">'
            + '<button id="trg-pick-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            + '<button id="trg-pick-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector('#trg-pick-save').addEventListener('click', function () {
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
            markDirty();
            document.body.removeChild(overlay);
            renderEventManager();
            markPreviewStale();
        });
        modal.querySelector('#trg-pick-cancel').addEventListener('click', function () {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // EVENT-EINSTELLUNGEN + ESKALATIONS-PLANER
    // Geplant wird CAST-WEISE ("beim 6. Schrei der erste Heal-CD, beim 7. eine
    // BoP"). Gespeichert wird weiterhin im kompakten start/end-Format, in das
    // die Cast-Liste beim Speichern wieder zusammengefasst wird - alte Pläne
    // bleiben dadurch unverändert lesbar.
    // ══════════════════════════════════════════════════════════════
    function openEventSettingsPicker(eventKey) {
        var evtObj = null;
        if (eventKey.startsWith('cfg_')) {
            evtObj = config.events[parseInt(eventKey.replace('cfg_', ''))] || {};
        } else {
            evtObj = customEvents.find(function (e) { return e._key === eventKey; }) || {};
        }
        var ov = eventOverrides[eventKey] || {};
        function val(field, fallback) {
            return ov[field] !== undefined ? ov[field] : (evtObj[field] !== undefined ? evtObj[field] : fallback);
        }

        var evtDur = val('eventDuration', 0) || 0;
        var overlap = val('overlapSec', 0) || 0;
        var resEsc = val('resetEscalation', 0) || 0;
        var contCov = !!val('continuousCoverage', false);
        var maxCasts = val('maxCasts', 1) || 1;
        var firstCast = val('firstCast', 0) || 0;
        var evtCd = val('cooldown', 0) || 0;
        var baseReq = (val('requiredCDs', []) || []).slice();
        var evtName = val('name', eventKey) || eventKey;
        var evtIcon = val('icon', '') || '';

        var escRanges = JSON.parse(JSON.stringify(val('escalationRanges', []) || []));

        // Ohne Cooldown gibt es nur einen Cast (siehe generateTimeline).
        var totalCasts = evtCd > 0 ? Math.max(1, Math.min(200, maxCasts)) : 1;

        // ── Wer ist aktuell auf welchem Cast eingeteilt? (nur zur Anschauung) ──
        var assignedByPos = {};
        var pos = 0;
        (assignments || []).forEach(function (r) {
            if (r.eventKey !== eventKey || r._isContinuous) return;
            pos++;
            var names = [];
            Object.keys(r.slots || {}).forEach(function (sk) {
                var s = r.slots[sk];
                if (!s || !s.player || s.player === '__SKIP__') return;
                if (s.unavailable || s.spreadGap || s.skipped) return;
                if (names.indexOf(s.player) === -1) names.push(s.player);
            });
            assignedByPos[pos] = names;
        });

        // ── Cast-Liste aufbauen: castCats[n-1] = Kategorie-Einträge für Cast n ──
        // Zyklus-Länge: mit "Reset nach N Casts" wiederholt sich das Muster,
        // dann reicht es, die ersten N zu planen.
        var cycleLen, castCats;
        function rebuildCastList() {
            cycleLen = resEsc > 0 ? Math.max(1, Math.min(resEsc, totalCasts)) : totalCasts;
            var hadRanges = escRanges.length > 0;
            castCats = [];
            for (var n = 1; n <= cycleLen; n++) {
                var m = escRanges.find(function (r) { return n >= r.start && n <= r.end; });
                castCats.push(m ? (m.categories || []).slice() : (hadRanges ? [] : baseReq.slice()));
            }
        }
        rebuildCastList();

        var sel = {};        // Cast-Nummer → ausgewählt
        var anchor = null;   // für Shift+Klick

        function selectedCasts() {
            return Object.keys(sel).filter(function (k) { return sel[k]; })
                .map(Number).sort(function (a, b) { return a - b; });
        }

        // ── Styles (einmalig) ──
        if (!document.getElementById('esc-planner-styles')) {
            var est = document.createElement('style');
            est.id = 'esc-planner-styles';
            est.textContent =
                '.esc-casts { max-height:250px; overflow-y:auto; border:1px solid #334155; border-radius:4px; background:#0f172a; }' +
                '.esc-row { display:flex; align-items:center; gap:6px; padding:3px 6px; cursor:pointer; border-bottom:1px solid rgba(51,65,85,0.4); user-select:none; }' +
                '.esc-row:last-child { border-bottom:none; }' +
                '.esc-row:hover { background:rgba(51,65,85,0.35); }' +
                '.esc-row.sel { background:rgba(34,211,238,0.13); box-shadow:inset 2px 0 0 0 #22d3ee; }' +
                '.esc-row .esc-n { width:34px; font-size:10px; font-weight:bold; color:#cbd5e1; text-align:right; flex:0 0 auto; }' +
                '.esc-row .esc-t { width:42px; font-size:9px; color:#64748b; font-family:monospace; flex:0 0 auto; }' +
                '.esc-row .esc-c { flex:1 1 auto; display:flex; flex-wrap:wrap; gap:3px; min-width:0; }' +
                '.esc-row .esc-a { flex:0 0 auto; max-width:35%; font-size:9px; color:#64748b; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }' +
                '.esc-chip { font-size:9px; padding:0 5px; border-radius:8px; line-height:15px; border:1px solid currentColor; opacity:0.9; }' +
                '.esc-empty { font-size:9px; color:#475569; font-style:italic; }' +
                '.esc-cat { font-size:10px; padding:2px 7px; border-radius:10px; border:1px solid #334155; background:#0f172a; color:#94a3b8; cursor:pointer; }' +
                '.esc-cat.on { background:rgba(255,255,255,0.06); font-weight:bold; }' +
                '.esc-cat.part { border-style:dashed; }' +
                '.esc-cat .esc-x { margin-left:4px; font-size:9px; opacity:0.75; }' +
                '.esc-mini { font-size:10px; padding:2px 6px; border-radius:3px; border:1px solid #334155; background:#0f172a; color:#cbd5e1; cursor:pointer; }' +
                '.esc-mini:hover { background:#1e293b; }';
            document.head.appendChild(est);
        }

        var content = document.createElement('div');
        content.innerHTML = ''
            + '<div class="mb-3 space-y-2">'
            + '<div class="flex gap-2">'
            + '<div class="flex-1"><label class="block text-[10px] text-gray-400 mb-1">Event-Dauer (Sek)</label>'
            + '<input type="number" id="es-dur" class="w-full bg-slate-900 border border-slate-700 text-white text-xs px-2 py-1 rounded" value="' + evtDur + '" step="0.5"></div>'
            + '<div class="flex-1"><label class="block text-[10px] text-gray-400 mb-1" title="Wie viel Sek. vor Ablauf des vorherigen CD soll der nächste gezogen werden?">Overlap (Sek)</label>'
            + '<input type="number" id="es-overlap" class="w-full bg-slate-900 border border-slate-700 text-white text-xs px-2 py-1 rounded" value="' + overlap + '" step="0.5"></div>'
            + '<div class="flex-1"><label class="block text-[10px] text-gray-400 mb-1" title="Nach wie vielen Casts fängt die Eskalation wieder bei 1 an? (0 = nie)">Reset nach Cast</label>'
            + '<input type="number" id="es-res" class="w-full bg-slate-900 border border-slate-700 text-white text-xs px-2 py-1 rounded" value="' + resEsc + '" min="0"></div>'
            + '</div>'
            + '<label class="flex items-center gap-2 text-[10px] text-gray-400 cursor-pointer">'
            + '<input type="checkbox" id="es-cont-cov" ' + (contCov ? 'checked' : '') + ' style="accent-color:#10b981;">'
            + 'Continuous Coverage (Folge-CDs automatisch anreihen, falls das Event länger dauert)</label>'
            + '</div>'

            + '<div class="border-t border-slate-700 pt-3">'
            + '<div class="flex items-baseline justify-between mb-1">'
            + '<div class="text-[11px] font-bold text-gray-200">📈 Eskalation - welcher Cast bekommt welche CDs?</div>'
            + '<div class="text-[10px] text-gray-500" id="es-cycle-info"></div>'
            + '</div>'
            + '<div class="text-[10px] text-gray-500 mb-2">Casts anklicken (Shift = Bereich, Strg = einzeln dazu), dann unten die Kategorien setzen.</div>'
            + '<div id="es-casts" class="esc-casts"></div>'
            + '<div class="flex flex-wrap items-center gap-1 mt-2">'
            + '<button class="esc-mini" id="es-sel-all">Alle</button>'
            + '<button class="esc-mini" id="es-sel-none">Keine</button>'
            + '<button class="esc-mini" id="es-sel-toend" title="Von der ersten Auswahl bis zum letzten Cast erweitern">▶ bis Ende</button>'
            + '<button class="esc-mini" id="es-copy-prev" title="Die Kategorien des Casts vor der Auswahl übernehmen">⧉ wie davor</button>'
            + '<span class="text-[10px] text-cyan-400/80 ml-1" id="es-sel-info"></span>'
            + '</div>'
            + '<div class="text-[10px] text-gray-400 mt-3 mb-1" id="es-pal-label">Kategorien für die Auswahl</div>'
            + '<div id="es-palette" class="flex flex-wrap gap-1"></div>'
            + '<div class="text-[10px] text-gray-500 mt-3 leading-relaxed" id="es-summary"></div>'
            + '</div>';

        var castsEl = content.querySelector('#es-casts');
        var paletteEl = content.querySelector('#es-palette');
        var summaryEl = content.querySelector('#es-summary');
        var selInfoEl = content.querySelector('#es-sel-info');
        var cycleInfoEl = content.querySelector('#es-cycle-info');
        var palLabelEl = content.querySelector('#es-pal-label');

        function catChip(entry) {
            var spec = parseCatSpec(entry);
            if (!spec) return '';
            var c = categories[spec.key];
            var color = c ? c.color : '#94a3b8';
            var label = c ? c.shortName : spec.key;
            if (spec.count > 1) label += ' ×' + spec.count;
            return '<span class="esc-chip" style="color:' + color + ';">' + label + '</span>';
        }

        function renderCasts() {
            // Scrollposition halten - bei 28 Casts würde die Liste sonst bei jedem
            // Klick nach oben springen.
            var scroll = castsEl.scrollTop;
            var html = '';
            for (var n = 1; n <= cycleLen; n++) {
                var cats = castCats[n - 1] || [];
                var t = firstCast + (n - 1) * evtCd;
                var names = assignedByPos[n] || [];
                html += '<div class="esc-row' + (sel[n] ? ' sel' : '') + '" data-n="' + n + '">'
                    + '<span class="esc-n">#' + n + '</span>'
                    + '<span class="esc-t">' + fmt(t) + '</span>'
                    + '<span class="esc-c">' + (cats.length ? cats.map(catChip).join('') : '<span class="esc-empty">keine CDs</span>') + '</span>'
                    + '<span class="esc-a" title="' + names.join(', ') + '">' + names.join(', ') + '</span>'
                    + '</div>';
            }
            castsEl.innerHTML = html;
            castsEl.scrollTop = scroll;
            cycleInfoEl.textContent = resEsc > 0
                ? cycleLen + ' Casts im Zyklus (von ' + totalCasts + ', wiederholt sich)'
                : totalCasts + ' Casts';
        }

        function renderPalette() {
            var chosen = selectedCasts();
            selInfoEl.textContent = chosen.length
                ? (chosen.length === 1 ? 'Cast #' + chosen[0] : chosen.length + ' Casts ausgewählt (#' + chosen[0] + '–#' + chosen[chosen.length - 1] + ')')
                : '';
            var html = '';
            Object.keys(categories).forEach(function (catKey) {
                var c = categories[catKey];
                var hits = 0, count = 1;
                chosen.forEach(function (n) {
                    (castCats[n - 1] || []).forEach(function (e) {
                        var sp = parseCatSpec(e);
                        if (sp && sp.key === catKey) { hits++; count = Math.max(count, sp.count); }
                    });
                });
                var all = chosen.length > 0 && hits === chosen.length;
                var some = hits > 0 && !all;
                var style = (all || some) ? ' style="color:' + c.color + ';border-color:' + c.color + ';"' : '';
                html += '<button class="esc-cat' + (all ? ' on' : '') + (some ? ' part' : '') + '" data-cat="' + catKey + '"'
                    + style + ' title="' + String(c.name).replace(/"/g, '&quot;') + '">'
                    + (c.shortName || catKey)
                    + (all && count > 1 ? '<span class="esc-x" data-count="1">×' + count + '</span>' : (all ? '<span class="esc-x" data-count="1">×1</span>' : ''))
                    + '</button>';
            });
            paletteEl.innerHTML = html || '<span class="text-[10px] text-gray-600">Keine Kategorien vorhanden.</span>';
            paletteEl.style.opacity = chosen.length ? '1' : '0.4';
            palLabelEl.textContent = chosen.length
                ? 'Kategorien für die Auswahl - nochmal auf ×N klicken für mehrere gleichzeitig'
                : 'Kategorien - erst oben Casts auswählen';
        }

        function renderSummary() {
            var parts = [];
            var cur = null;
            castCats.forEach(function (cats, i) {
                var sig = JSON.stringify(cats);
                if (cur && cur.sig === sig) { cur.end = i + 1; return; }
                if (cur) parts.push(cur);
                cur = { start: i + 1, end: i + 1, cats: cats, sig: sig };
            });
            if (cur) parts.push(cur);
            summaryEl.innerHTML = '<b class="text-gray-400">Ergibt:</b> ' + parts.map(function (p) {
                var span = p.start === p.end ? '#' + p.start : '#' + p.start + '–' + p.end;
                var labels = p.cats.length
                    ? p.cats.map(function (e) {
                        var sp = parseCatSpec(e);
                        var c = sp && categories[sp.key];
                        return (c ? c.shortName : (sp ? sp.key : e)) + (sp && sp.count > 1 ? '×' + sp.count : '');
                    }).join('+')
                    : '-';
                return '<span class="text-gray-400">' + span + '</span> ' + labels;
            }).join(' · ');
        }

        function renderAll() { renderCasts(); renderPalette(); renderSummary(); }
        renderAll();

        // ── Auswahl ──
        castsEl.addEventListener('click', function (e) {
            var row = e.target.closest('.esc-row');
            if (!row) return;
            var n = parseInt(row.dataset.n);
            if (e.shiftKey && anchor) {
                var a = Math.min(anchor, n), b = Math.max(anchor, n);
                if (!e.ctrlKey && !e.metaKey) sel = {};
                for (var i = a; i <= b; i++) sel[i] = true;
            } else if (e.ctrlKey || e.metaKey) {
                if (sel[n]) delete sel[n]; else sel[n] = true;
                anchor = n;
            } else {
                var wasOnly = sel[n] && selectedCasts().length === 1;
                sel = {};
                if (!wasOnly) sel[n] = true;
                anchor = n;
            }
            renderCasts();
            renderPalette();
        });

        content.querySelector('#es-sel-all').addEventListener('click', function () {
            sel = {};
            for (var i = 1; i <= cycleLen; i++) sel[i] = true;
            anchor = 1;
            renderCasts(); renderPalette();
        });
        content.querySelector('#es-sel-none').addEventListener('click', function () {
            sel = {}; anchor = null;
            renderCasts(); renderPalette();
        });
        content.querySelector('#es-sel-toend').addEventListener('click', function () {
            var chosen = selectedCasts();
            if (!chosen.length) return;
            for (var i = chosen[0]; i <= cycleLen; i++) sel[i] = true;
            renderCasts(); renderPalette();
        });
        content.querySelector('#es-copy-prev').addEventListener('click', function () {
            var chosen = selectedCasts();
            if (!chosen.length || chosen[0] < 2) return;
            var src = (castCats[chosen[0] - 2] || []).slice();
            chosen.forEach(function (n) { castCats[n - 1] = src.slice(); });
            renderAll();
        });

        // ── Kategorien setzen ──
        paletteEl.addEventListener('click', function (e) {
            var btn = e.target.closest('.esc-cat');
            if (!btn) return;
            var chosen = selectedCasts();
            if (!chosen.length) return;
            var catKey = btn.dataset.cat;

            // Klick auf das "×N"-Badge zählt nur die Anzahl hoch (1→2→3→4→1),
            // ohne die Kategorie zu entfernen.
            if (e.target.classList.contains('esc-x')) {
                var next = (parseInt(String(e.target.textContent).replace('×', '')) || 1) % 4 + 1;
                chosen.forEach(function (n) { setCat(n, catKey, true, next); });
                renderAll();
                return;
            }

            var allHave = chosen.every(function (n) { return requiredHasCat(castCats[n - 1] || [], catKey); });
            chosen.forEach(function (n) { setCat(n, catKey, !allHave, 1); });
            renderAll();
        });

        function setCat(n, catKey, on, count) {
            var arr = castCats[n - 1] || (castCats[n - 1] = []);
            var idx = -1;
            for (var i = 0; i < arr.length; i++) {
                var sp = parseCatSpec(arr[i]);
                if (sp && sp.key === catKey) { idx = i; break; }
            }
            if (!on) { if (idx !== -1) arr.splice(idx, 1); return; }
            var entry = count > 1 ? catKey + ':' + count : catKey;
            if (idx === -1) arr.push(entry); else arr[idx] = entry;
        }

        // Reset-Feld ändert die Zykluslänge → Liste neu aufbauen
        content.querySelector('#es-res').addEventListener('change', function (e) {
            var newRes = parseInt(e.target.value) || 0;
            if (newRes === resEsc) return;
            escRanges = buildRanges();       // aktuellen Stand sichern
            resEsc = newRes;
            rebuildCastList();
            sel = {}; anchor = null;
            renderAll();
        });

        // ── Cast-Liste wieder zu start/end-Bereichen zusammenfassen ──
        function buildRanges() {
            if (!castCats.length) return [];
            var firstSig = JSON.stringify(castCats[0]);
            var uniform = castCats.every(function (c) { return JSON.stringify(c) === firstSig; });
            // Überall dasselbe wie die Basis-Kategorien des Events → keine
            // Eskalation nötig, dann bleibt der Event-Eintrag sauber.
            if (uniform && firstSig === JSON.stringify(baseReq)) return [];

            var ranges = [];
            var cur = null;
            castCats.forEach(function (cats, i) {
                var sig = JSON.stringify(cats);
                if (cur && cur.sig === sig) { cur.end = i + 1; return; }
                if (cur) ranges.push(cur);
                cur = { start: i + 1, end: i + 1, categories: cats.slice(), sig: sig };
            });
            if (cur) ranges.push(cur);

            // Leere Abschnitte weglassen: "kein Bereich trifft zu" bedeutet in
            // generateTimeline ohnehin "keine CDs".
            var out = ranges.filter(function (r) { return r.categories.length > 0; })
                .map(function (r) { return { start: r.start, end: r.end, categories: r.categories }; });
            // Alles leer → ein expliziter Leer-Bereich, sonst würde beim nächsten
            // Laden wieder auf die Basis-Kategorien zurückgefallen.
            if (!out.length) out = [{ start: 1, end: castCats.length, categories: [] }];
            return out;
        }

        // ── Modal ──
        var overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[9999]';
        var modal = document.createElement('div');
        modal.className = 'bg-slate-800 border border-slate-600 rounded-lg shadow-xl w-[620px] max-w-[95vw] flex flex-col max-h-[90vh]';

        var mHead = document.createElement('div');
        mHead.className = 'p-3 border-b border-slate-700 flex justify-between items-center';
        mHead.innerHTML = '<h3 class="text-sm font-bold text-gray-200">Event-Einstellungen - '
            + (evtIcon ? evtIcon + ' ' : '') + String(evtName).replace(/</g, '&lt;') + '</h3>';

        var mBody = document.createElement('div');
        mBody.className = 'p-3 overflow-y-auto';
        mBody.appendChild(content);

        var mFoot = document.createElement('div');
        mFoot.className = 'p-3 border-t border-slate-700 flex justify-end gap-2';

        var btnCancel = document.createElement('button');
        btnCancel.className = 'px-3 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded';
        btnCancel.textContent = 'Abbrechen';
        btnCancel.onclick = function () { overlay.remove(); };

        var btnSave = document.createElement('button');
        btnSave.className = 'px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded font-bold';
        btnSave.textContent = 'Speichern';
        btnSave.onclick = function () {
            setOverride(eventKey, 'eventDuration', parseFloat(content.querySelector('#es-dur').value) || 0, true);
            setOverride(eventKey, 'overlapSec', parseFloat(content.querySelector('#es-overlap').value) || 0, true);
            setOverride(eventKey, 'resetEscalation', parseInt(content.querySelector('#es-res').value) || 0, true);
            setOverride(eventKey, 'continuousCoverage', content.querySelector('#es-cont-cov').checked, true);
            // Letzter Aufruf ohne silent → Event-Manager neu zeichnen
            setOverride(eventKey, 'escalationRanges', JSON.parse(JSON.stringify(buildRanges())));
            overlay.remove();
        };

        mFoot.appendChild(btnCancel);
        mFoot.appendChild(btnSave);

        modal.appendChild(mHead);
        modal.appendChild(mBody);
        modal.appendChild(mFoot);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    // ── Soak-Settings pro Event (Schaden / Schwelle / Swing) + Live-Preview ──
    function openEventSoakPicker(eventKey) {
        var soak = {};
        var custom = customEvents.find(function (e) { return e._key === eventKey; });
        var ov = eventOverrides[eventKey] || {};
        if (ov.soak) soak = ov.soak;
        else if (custom && custom.soak) soak = custom.soak;
        else { var cfgIdx = parseInt(eventKey.replace('cfg_', '')); soak = (config.events[cfgIdx] || {}).soak || {}; }

        var hit = soak.expectedHitDmg != null ? soak.expectedHitDmg : 1800000;
        var hpV = soak.tankHp != null ? soak.tankHp : 800000;
        var thr = soak.threshold != null ? soak.threshold : 0.50;
        var swing = soak.swingSec != null ? soak.swingSec : 1.5;
        var curOverlap = soak.overlapSec != null ? soak.overlapSec : 1.0;
        var curTank = soak.tankTarget || null;
        var curSafety = soak.safetySpellId || "";
        var curSafetyOff = soak.safetyOffsetSec != null ? soak.safetyOffsetSec : 0;

        var BR = window.CD_BLOODRAGE;
        var tanks = (BR && BR.getTanks) ? BR.getTanks() : [];
        function safetyOptionsFor(tankName) {
            if (!BR || !BR.getSafetyOptions) return [];
            var raw = BR.getSafetyOptions(null, tankName), seen = {}, list = [];
            raw.forEach(function (s) { if (!seen[s.spellId]) { seen[s.spellId] = true; list.push(s); } });
            return list;
        }
        function tankOpts() {
            if (!tanks.length) return '<option value="">(kein Tank gefunden)</option>';
            return tanks.map(function (t) { return '<option value="' + t + '"' + ((curTank === t || (!curTank && tanks[0] === t)) ? ' selected' : '') + '>' + t + '</option>'; }).join('');
        }
        function safetyOpts(tankName) {
            var opts = '<option value="">- kein Safety -</option>';
            safetyOptionsFor(tankName).forEach(function (s) { opts += '<option value="' + s.spellId + '"' + (curSafety === s.spellId ? ' selected' : '') + '>' + s.dbName + ' (' + s.player + ')</option>'; });
            return opts;
        }

        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';
        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:580px;width:92%;max-height:85vh;overflow-y:auto;';
        modal.innerHTML =
            '<h4 class="text-lg font-bold text-white mb-1">Tank-Soak Einstellungen</h4>'
            + '<div class="text-xs text-gray-400 mb-3">Werte gelten nur für dieses Event und werden mit dem Plan gespeichert.</div>'
            + '<div class="flex flex-wrap items-end gap-3 mb-3">'
            + '<label class="text-xs text-amber-300">Soakender Tank<select id="sk-tank" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-100">' + tankOpts() + '</select></label>'
            + '<label class="text-xs text-amber-300">P2 Schaden / Hit (unmit.)<input id="sk-hit" type="number" value="' + hit + '" step="50000" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-32 text-gray-100"></label>'
            + '<label class="text-xs text-amber-300">Tank-HP<input id="sk-hp" type="number" value="' + hpV + '" step="50000" min="0" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-28 text-gray-100" title="HP des soakenden Tanks – markiert tödliche Hits"></label>'
            + '<label class="text-xs text-amber-300">Min. DR<select id="sk-thr" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-100">'
            + ['0.50', '0.55', '0.60', '0.65', '0.70'].map(function (v) { return '<option value="' + v + '"' + (Math.abs(thr - parseFloat(v)) < 1e-6 ? ' selected' : '') + '>' + Math.round(v * 100) + '%</option>'; }).join('') + '</select></label>'
            + '<label class="text-xs text-amber-300">Swing (s)<input id="sk-swing" type="number" value="' + swing + '" step="0.1" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-16 text-gray-100"></label>'
            + '<label class="text-xs text-amber-300">Überlappung (s)<input id="sk-overlap" type="number" value="' + curOverlap + '" step="0.5" min="0" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-16 text-gray-100" title="Lead-Time: Folge-CDs starten so viel früher (Reaktionszeit)"></label>'
            + '</div>'
            + '<div class="flex flex-wrap items-end gap-3 mb-3 p-2 rounded border border-violet-700/40 bg-violet-900/10">'
            + '<label class="text-xs text-violet-300">Optionaler Safety-CD (kein DR)<select id="sk-safety" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-100">' + safetyOpts(curTank || tanks[0]) + '</select></label>'
            + '<label class="text-xs text-violet-300">Safety bei (s)<input id="sk-safetyoff" type="number" value="' + curSafetyOff + '" step="1" min="0" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-16 text-gray-100"></label>'
            + '<button id="sk-refresh" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Vorschau</button>'
            + '</div>'
            + '<div id="sk-preview" class="mb-4"></div>'
            + '<div class="flex justify-between gap-2">'
            + '<button id="sk-off" class="bg-rose-700 hover:bg-rose-800 text-white px-3 py-1.5 rounded text-sm">Soak aus (→ Shield)</button>'
            + '<div class="flex gap-2"><button id="sk-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            + '<button id="sk-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button></div>'
            + '</div>';
        overlay.appendChild(modal); document.body.appendChild(overlay);

        function readVals() {
            var ovv = parseFloat(modal.querySelector('#sk-overlap').value);
            return {
                expectedHitDmg: parseInt(modal.querySelector('#sk-hit').value) || 1800000,
                tankHp: parseInt(modal.querySelector('#sk-hp').value) || 800000,
                threshold: parseFloat(modal.querySelector('#sk-thr').value) || 0.50,
                swingSec: parseFloat(modal.querySelector('#sk-swing').value) || 1.5,
                overlapSec: isNaN(ovv) ? 1.0 : ovv,
                tankTarget: modal.querySelector('#sk-tank').value || null,
                safetySpellId: modal.querySelector('#sk-safety').value || null,
                safetyOffsetSec: parseFloat(modal.querySelector('#sk-safetyoff').value) || 0
            };
        }
        function preview() {
            var mount = modal.querySelector('#sk-preview');
            if (!window.CD_BLOODRAGE) { mount.innerHTML = '<div style="background:#3a1f1d;border:1px solid #c5524c;color:#f0c4c1;padding:10px;border-radius:6px;font-size:13px">⚠ Add-on CD_BLOODRAGE nicht geladen.</div>'; return; }
            try {
                var v = readVals();
                var p = window.CD_BLOODRAGE.plan({
                    expectedHitDmg: v.expectedHitDmg, tankHp: v.tankHp, threshold: v.threshold,
                    swingSec: v.swingSec, overlapSec: v.overlapSec, windowSec: 22.5,
                    tankTarget: v.tankTarget, safetySpellId: v.safetySpellId, safetyOffsetSec: v.safetyOffsetSec
                });
                window.CD_BLOODRAGE.renderPreview(p, mount);
            } catch (err) { mount.innerHTML = '<div style="background:#3a1f1d;border:1px solid #c5524c;color:#f0c4c1;padding:10px;border-radius:6px;font-size:13px">Fehler: ' + (err && err.message) + '</div>'; }
        }
        modal.querySelector('#sk-tank').addEventListener('change', function () {
            curSafety = modal.querySelector('#sk-safety').value;
            modal.querySelector('#sk-safety').innerHTML = safetyOpts(modal.querySelector('#sk-tank').value);
            preview();
        });
        ['#sk-hit', '#sk-hp', '#sk-swing', '#sk-safetyoff', '#sk-overlap'].forEach(function (s) { modal.querySelector(s).addEventListener('input', preview); });
        ['#sk-thr', '#sk-safety'].forEach(function (s) { modal.querySelector(s).addEventListener('change', preview); });
        modal.querySelector('#sk-refresh').addEventListener('click', preview);
        preview();

        modal.querySelector('#sk-save').addEventListener('click', function () { setOverride(eventKey, 'soak', readVals()); document.body.removeChild(overlay); });
        modal.querySelector('#sk-off').addEventListener('click', function () {
            var reqNow = (function () {
                if (custom) return (custom.requiredCDs || []).slice();
                if (ov.requiredCDs !== undefined) return ov.requiredCDs.slice();
                var i = parseInt(eventKey.replace('cfg_', '')); return ((config.events[i] || {}).requiredCDs || []).slice();
            })().filter(function (k) {
                var spec = parseCatSpec(k);
                return !spec || spec.key !== 'tank_soak_phys';
            });
            setOverride(eventKey, 'requiredCDs', reqNow);
            document.body.removeChild(overlay);
        });
        modal.querySelector('#sk-cancel').addEventListener('click', function () { document.body.removeChild(overlay); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) document.body.removeChild(overlay); });
    }


    // ── Kategorie-Picker pro Event ──
    // ══════════════════════════════════════════════════════════════
    // EVENT-EINTEILUNG KOPIEREN
    // Überträgt die komplette CD-Einteilung eines Events (alle Casts)
    // auf ein anderes Event - z.B. „Kreischen P1" → „Kreischen P2".
    // Cast #1 landet auf Cast #1, #2 auf #2 usw.; die kopierten CDs werden
    // als manuelle Zuweisungen gesetzt (gelb), damit Auto-Assign sie nicht
    // wieder überschreibt.
    // ══════════════════════════════════════════════════════════════

    // Zuweisungen eines Events einsammeln: Cast-POSITION (1,2,3...) innerhalb des
    // Events → { slotKey: overrideObj }.
    //
    // Bewusst NICHT row.castNum als Schlüssel: das ist ein globaler Zähler pro
    // Event-NAME (siehe generateTimeline). Zwei gleichnamige Event-Blöcke teilen
    // ihn sich, der zweite Block fängt dann z.B. bei #5 an - beim Kopieren fand
    // dadurch kein einziger Cast seinen Partner. Die Position innerhalb des
    // Events ist dagegen immer 1..n und passt auf beiden Seiten zusammen.
    function collectEventSlots(eventKey) {
        var byPos = {};
        var pos = 0;
        (assignments || []).forEach(function (r) {
            // Continuous-Coverage-Folgezeilen werden beim Ziel automatisch neu
            // erzeugt - die dürfen nicht mitkopiert werden.
            if (r.eventKey !== eventKey || r._isContinuous) return;
            pos++;
            var slots = {};
            Object.keys(r.slots || {}).forEach(function (sk) {
                var s = r.slots[sk];
                if (!s || s.isExtraPlaceholder || s.unavailable || s.spreadGap || s.notInRoster) return;
                // „Kein CD nötig" ist eine bewusste Planungs-Entscheidung und
                // gehört mit ins Ziel - sonst weist Auto-Assign dort wieder zu.
                if (s.skipped || s.player === '__SKIP__') {
                    slots[sk] = { player: '__SKIP__', dbName: '__SKIP__', skip: true };
                    return;
                }
                if (s.isVirtual) {
                    slots[sk] = {
                        player: s.player, dbName: '__VIRTUAL__',
                        isVirtualCategoryKey: s.isVirtualCategoryKey || baseCatKey(sk)
                    };
                    return;
                }
                if (s.player && s.dbName) {
                    slots[sk] = {
                        player: s.player, dbName: s.dbName,
                        dbClass: s.dbClass, spellId: s.spellId,
                        cooldownSec: s.cooldownSec, durationSec: s.durationSec
                    };
                }
            });
            // Auch leere Casts eintragen, damit die Positionen 1:1 durchzählen.
            byPos[pos] = slots;
        });
        return byPos;
    }

    // Anzahl Casts eines Events in der aktuellen Vorschau
    function countEventCasts(eventKey) {
        return (assignments || []).filter(function (r) {
            return r.eventKey === eventKey && !r._isContinuous;
        }).length;
    }

    // Eskalations-Einstellungen eines Events (mit Overrides) auslesen
    function eventEscalation(eventKey) {
        var evtObj = {};
        if (String(eventKey).indexOf('cfg_') === 0) {
            evtObj = (config.events || [])[parseInt(String(eventKey).replace('cfg_', ''))] || {};
        } else {
            evtObj = customEvents.find(function (e) { return e._key === eventKey; }) || {};
        }
        var ov = eventOverrides[eventKey] || {};
        return {
            ranges: (ov.escalationRanges !== undefined ? ov.escalationRanges : (evtObj.escalationRanges || [])) || [],
            reset: (ov.resetEscalation !== undefined ? ov.resetEscalation : (evtObj.resetEscalation || 0)) || 0
        };
    }

    function eventDisplayName(eventKey) {
        var evt = getEffectiveEvents().find(function (e) { return e._key === eventKey; });
        if (evt) return (evt.icon ? evt.icon + ' ' : '') + evt.name;
        return eventKey;
    }

    // requiredCDs eines Events (mit Overrides) auslesen
    function eventRequiredCDs(eventKey) {
        var custom = customEvents.find(function (e) { return e._key === eventKey; });
        if (custom) return (custom.requiredCDs || []).slice();
        var ov = eventOverrides[eventKey] || {};
        if (ov.requiredCDs !== undefined) return ov.requiredCDs.slice();
        var idx = parseInt(String(eventKey).replace('cfg_', ''));
        return (((config.events || [])[idx] || {}).requiredCDs || []).slice();
    }

    // Kern der Kopier-Funktion (ohne UI, damit testbar).
    // opts: { categories: bool, overwrite: bool, pinSource: bool }
    // Rückgabe: { cds, casts, missingCasts, cleared, pinned, conflicts, conflictExamples }
    function copyEventAssignments(srcKey, dstKey, opts) {
        opts = opts || {};
        var srcSlots = collectEventSlots(srcKey);
        var srcCount = Object.keys(srcSlots).length;
        var srcRows = (assignments || []).filter(function (r) {
            return r.eventKey === srcKey && !r._isContinuous;
        });
        var dstRows = (assignments || []).filter(function (r) {
            return r.eventKey === dstKey && !r._isContinuous;
        });

        // Wann wird welcher CD nach dem Kopieren gezogen? Daraus lassen sich
        // Doppelbelegungen innerhalb der Cooldown-Zeit melden.
        var usage = {};
        function noteUsage(ov, time) {
            if (!ov || !ov.player || !ov.dbName || ov.skip || ov.dbName === '__VIRTUAL__') return;
            var k = ov.player + '::' + ov.dbName;
            if (!usage[k]) usage[k] = { cd: ov.cooldownSec || 180, times: [] };
            usage[k].times.push(time);
        }

        var copiedCds = 0, copiedCasts = 0, clearedCds = 0, pinnedCds = 0;
        dstRows.forEach(function (r, i) {
            var src = srcSlots[i + 1];   // Cast-Position, nicht castNum
            if (!src) return;
            var prefix = rowOverridePrefix(r) + '-';

            // Beim Überschreiben zuerst die bestehenden manuellen Zuweisungen der
            // Ziel-Zeile wegräumen. Sonst bleiben Slots stehen, die es in der
            // Quelle gar nicht gibt, und das Ergebnis ist eine Mischung aus
            // beiden Einteilungen statt einer Kopie.
            if (opts.overwrite !== false) {
                Object.keys(manualOverrides).forEach(function (oKey) {
                    if (oKey.indexOf(prefix) !== 0) return;
                    // Overrides der Continuous-Coverage-Folgezeilen ("...-c1-cat")
                    // gehören dieser Zeile nicht.
                    if (/^c\d+-/.test(oKey.substring(prefix.length))) return;
                    delete manualOverrides[oKey];
                    clearedCds++;
                });
            }

            var any = false;
            Object.keys(src).forEach(function (sk) {
                if (opts.overwrite === false && manualOverrides[prefix + sk]) return;
                manualOverrides[prefix + sk] = JSON.parse(JSON.stringify(src[sk]));
                noteUsage(src[sk], r.absTime);
                copiedCds++;
                any = true;
            });
            if (any) copiedCasts++;
        });

        // Die Quelle mit festhalten: die kopierten CDs sind im Ziel jetzt manuell
        // und blockieren dort die Cooldowns. Bliebe die Quelle automatisch, würde
        // Auto-Assign sie beim nächsten Lauf neu verteilen - es sähe aus, als hätte
        // das Kopieren die falsche Seite verändert.
        if (opts.pinSource !== false) {
            srcRows.forEach(function (r, i) {
                var s = srcSlots[i + 1];
                if (!s) return;
                var p = rowOverridePrefix(r) + '-';
                Object.keys(s).forEach(function (sk) {
                    noteUsage(s[sk], r.absTime);
                    if (manualOverrides[p + sk]) return;   // war schon manuell
                    manualOverrides[p + sk] = JSON.parse(JSON.stringify(s[sk]));
                    pinnedCds++;
                });
            });
        }

        // Doppelbelegungen innerhalb der Cooldown-Zeit sammeln
        var conflicts = 0, conflictExamples = [];
        Object.keys(usage).forEach(function (k) {
            var u = usage[k];
            var times = u.times.slice().sort(function (a, b) { return a - b; });
            for (var i = 1; i < times.length; i++) {
                if (times[i] - times[i - 1] < u.cd) {
                    conflicts++;
                    if (conflictExamples.length < 3) {
                        conflictExamples.push(k.replace('::', ' – ') + ' (' + fmt(times[i - 1]) + ' & ' + fmt(times[i]) + ')');
                    }
                }
            }
        });

        if (opts.categories) {
            // silent=true: kein Zwischen-Rerender, der Aufrufer startet Auto-Assign
            setOverride(dstKey, 'requiredCDs', eventRequiredCDs(srcKey), true);
            // Die Eskalation gehört zur Einteilung dazu - ohne sie bekäme das Ziel
            // bei 28 Casts überall dieselben Kategorien statt des geplanten Aufbaus.
            var srcEsc = eventEscalation(srcKey);
            setOverride(dstKey, 'escalationRanges', JSON.parse(JSON.stringify(srcEsc.ranges)), true);
            setOverride(dstKey, 'resetEscalation', srcEsc.reset, true);
        }

        return {
            cds: copiedCds,
            casts: copiedCasts,
            cleared: clearedCds,
            pinned: pinnedCds,
            conflicts: conflicts,
            conflictExamples: conflictExamples,
            missingCasts: Math.max(0, srcCount - dstRows.length)
        };
    }

    function openEventCopyPicker(srcKey) {
        var srcSlots = collectEventSlots(srcKey);
        var srcCasts = Object.keys(srcSlots);
        var srcCdCount = srcCasts.reduce(function (n, c) { return n + Object.keys(srcSlots[c]).length; }, 0);

        if (!assignments || !assignments.length) {
            if (window.showModal) window.showModal('Erst „Auto-Zuweisen" ausführen - es gibt noch keine Einteilung zum Kopieren.');
            return;
        }
        if (srcCdCount === 0) {
            if (window.showModal) window.showModal('Dieses Event hat keine zugewiesenen CDs zum Kopieren.');
            return;
        }

        var srcRequired = eventRequiredCDs(srcKey);
        var srcEscCount = (eventEscalation(srcKey).ranges || []).length;

        // Mögliche Ziele: alle aktiven Events außer der Quelle und den
        // automatisch erzeugten Lust/Banner-Hilfsevents.
        var targets = getEffectiveEvents().filter(function (e) {
            return e._key !== srcKey && String(e._key).indexOf('auto_') !== 0;
        });
        if (!targets.length) {
            if (window.showModal) window.showModal('Es gibt kein anderes aktives Event, auf das kopiert werden könnte.');
            return;
        }

        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';
        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1e293b;padding:20px;border-radius:8px;border:1px solid #475569;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;';

        var srcCastCount = countEventCasts(srcKey);
        var optHtml = targets.map(function (e) {
            var n = countEventCasts(e._key);
            var warn = (n < srcCastCount) ? '  ⚠ nur ' + n + ' von ' + srcCastCount : '';
            return '<option value="' + e._key + '">' + (e.icon ? e.icon + ' ' : '') + String(e.name).replace(/</g, '&lt;')
                + ' (' + n + ' Cast' + (n === 1 ? '' : 's') + ')' + warn + '</option>';
        }).join('');

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-1">CD-Einteilung kopieren</h4>'
            + '<div class="text-xs text-gray-400 mb-3">Von <span class="text-cyan-300 font-bold">' + String(eventDisplayName(srcKey)).replace(/</g, '&lt;') + '</span>'
            + ' - <b>' + srcCastCount + '</b> Casts mit insgesamt <b>' + srcCdCount + '</b> CDs.</div>'
            + '<label class="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Ziel-Event</label>'
            + '<select id="cp-target" class="w-full bg-slate-900 border border-slate-700 text-white text-xs px-2 py-1.5 rounded mb-3">' + optHtml + '</select>'
            + '<label class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded cursor-pointer">'
            + '<input type="checkbox" id="cp-cats" checked style="accent-color:#22d3ee;">'
            + '<span class="text-xs text-gray-300">Kategorien + Eskalation mit übernehmen '
            + '<span class="text-gray-500">(' + (srcRequired.length ? srcRequired.join(', ') : '-')
            + (srcEscCount ? ', ' + srcEscCount + ' Eskalations-Phasen' : '') + ')</span></span></label>'
            + '<label class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded cursor-pointer">'
            + '<input type="checkbox" id="cp-overwrite" checked style="accent-color:#22d3ee;">'
            + '<span class="text-xs text-gray-300">Vorhandene Zuweisungen im Ziel überschreiben</span></label>'
            + '<label class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded cursor-pointer">'
            + '<input type="checkbox" id="cp-pin" checked style="accent-color:#22d3ee;">'
            + '<span class="text-xs text-gray-300">Quelle festhalten '
            + '<span class="text-gray-500">(sonst verteilt Auto-Assign die Quelle danach neu)</span></span></label>'
            + '<div class="text-[10px] text-gray-500 mt-2 mb-3 leading-relaxed">Der 1. Cast der Quelle landet auf dem 1. Cast des Ziels, der 2. auf dem 2. usw. '
            + 'Hat das Ziel weniger Casts, wird nur so weit kopiert, wie es reicht. '
            + 'Mit „überschreiben" wird das Ziel vorher geleert, sonst bleiben dort vorhandene Zuweisungen stehen. '
            + 'Die kopierten CDs gelten danach als <span class="text-yellow-400">manuell</span> (gelb) - Auto-Assign überschreibt sie nicht mehr. '
            + 'Liegen beide Events so dicht beieinander, dass ein CD nicht wieder bereit ist, wird das danach als '
            + '<b>Doppelbelegung</b> gemeldet - kopiert wird trotzdem.</div>'
            + '<div class="flex justify-end gap-2">'
            + '<button id="cp-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            + '<button id="cp-ok" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm font-bold">Kopieren</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
        modal.querySelector('#cp-cancel').addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

        modal.querySelector('#cp-ok').addEventListener('click', function () {
            var dstKey = modal.querySelector('#cp-target').value;
            var takeCats = modal.querySelector('#cp-cats').checked;
            var overwrite = modal.querySelector('#cp-overwrite').checked;
            var pinSource = modal.querySelector('#cp-pin').checked;
            close();

            var res = copyEventAssignments(srcKey, dstKey, {
                categories: takeCats, overwrite: overwrite, pinSource: pinSource
            });

            markDirty();
            runAutoAssign();

            var msg = res.cds + ' CDs auf ' + res.casts + ' Casts von „' + eventDisplayName(srcKey)
                + '" nach „' + eventDisplayName(dstKey) + '" kopiert.';
            if (res.cleared > 0) {
                msg += '\n(' + res.cleared + ' vorherige Zuweisung(en) im Ziel wurden dabei ersetzt.)';
            }
            if (res.pinned > 0) {
                msg += '\n(' + res.pinned + ' CDs der Quelle wurden festgehalten, damit sie sich nicht neu verteilen.)';
            }
            if (res.missingCasts > 0) {
                msg += '\n\n⚠ ' + res.missingCasts + ' Cast(s) konnten nicht übertragen werden - das Ziel-Event hat weniger Casts.'
                    + '\nErhöhe dort „Casts", wenn du die auch brauchst.';
            }
            if (res.conflicts > 0) {
                msg += '\n\n⚠ ' + res.conflicts + ' Doppelbelegung(en): derselbe CD wird zweimal gezogen, bevor er wieder bereit ist.'
                    + '\n' + res.conflictExamples.join('\n')
                    + '\nDas ist so gewollt beim Kopieren - prüfe die gelben Zellen und tausche, wo es nicht passt.';
            }
            msg += '\n\nNicht vergessen: „Plan speichern".';
            if (window.showModal) window.showModal(msg);
        });
    }

    function openEventCategoryPicker(eventKey) {
        // aktuelle requiredCDs holen
        var current = [];
        var custom = customEvents.find(function (e) { return e._key === eventKey; });
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

        // Aktuelle Auswahl inkl. Anzahl parsen ("any_dr:2" → any_dr, 2×)
        var currentMap = {};
        current.forEach(function (entry) {
            var spec = parseCatSpec(entry);
            if (spec && spec.key) currentMap[spec.key] = Math.max(currentMap[spec.key] || 0, spec.count);
        });

        var rows = Object.entries(categories).map(function (entry) {
            var key = entry[0], cat = entry[1];
            var checked = currentMap[key] !== undefined;
            var count = currentMap[key] || 1;
            var countSel = '<select class="cat-pick-count" data-key="' + key + '" title="Wie viele CDs dieser Kategorie GLEICHZEITIG pro Cast? (z.B. 2× = zwei DR-CDs zusammen ziehen)" style="background:#0f172a;color:#cbd5e1;border:1px solid #334155;border-radius:3px;font-size:11px;padding:1px 3px;cursor:pointer;' + (checked ? '' : 'visibility:hidden;') + '">'
                + [1, 2, 3].map(function (n) { return '<option value="' + n + '"' + (n === count ? ' selected' : '') + '>' + n + '×</option>'; }).join('')
                + '</select>';
            return '<div class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded">'
                + '<label class="flex items-center gap-2 flex-1 cursor-pointer">'
                + '<input type="checkbox" class="cat-pick-cb" value="' + key + '"' + (checked ? ' checked' : '') + ' style="accent-color:' + cat.color + ';">'
                + '<span class="flex-1 text-sm" style="color:' + cat.color + ';">' + cat.name + '</span>'
                + '</label>'
                + countSel
                + '<span class="text-[9px] text-gray-500 font-mono">' + (cat.spells ? cat.spells.length : 0) + ' Spells</span>'
                + '</div>';
        }).join('');

        modal.innerHTML = '<h4 class="text-lg font-bold text-white mb-3">Kategorien für dieses Event</h4>'
            + '<div class="text-xs text-gray-400 mb-3">Welche CD-Kategorien sollen bei diesem Event automatisch gesucht werden? Mit dem Zähler rechts ziehst du mehrere CDs derselben Kategorie <b>gleichzeitig</b> (z.B. 2× Schadensreduktion pro Cast).</div>'
            + '<div class="space-y-1 mb-4">' + rows + '</div>'
            + '<div class="flex justify-end gap-2">'
            + '<button id="cat-pick-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            + '<button id="cat-pick-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Zähler nur zeigen, wenn Kategorie angehakt ist
        modal.querySelectorAll('.cat-pick-cb').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var cnt = modal.querySelector('.cat-pick-count[data-key="' + cb.value + '"]');
                if (cnt) cnt.style.visibility = cb.checked ? '' : 'hidden';
            });
        });

        modal.querySelector('#cat-pick-save').addEventListener('click', function () {
            var selected = [];
            modal.querySelectorAll('.cat-pick-cb').forEach(function (cb) {
                if (!cb.checked) return;
                var cntSel = modal.querySelector('.cat-pick-count[data-key="' + cb.value + '"]');
                var cnt = cntSel ? (parseInt(cntSel.value) || 1) : 1;
                selected.push(cnt > 1 ? cb.value + ':' + cnt : cb.value);
            });
            setOverride(eventKey, 'requiredCDs', selected);
            document.body.removeChild(overlay);
        });
        modal.querySelector('#cat-pick-cancel').addEventListener('click', function () {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    function updateStatus(msg) {
        var el = document.getElementById('auto-planner-status');
        if (el) el.textContent = config.name + ' - ' + msg;
    }

    // ══════════════════════════════════════════════════════════════
    // EXPORT → CD-PLANER
    // Trigger = Event-Typ | Condition = # | Zeit = Delay | CD = DB-Name
    // ══════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════
    // MATRIX ↔ CD-PLANER: gemeinsame Zuordnung
    // ══════════════════════════════════════════════════════════════
    // Export und Import müssen dieselbe Antwort auf die Frage geben: welche
    // Planer-Zeile (Auslöser + #) gehört zu welcher Matrix-Zeile? Deshalb
    // berechnet BEIDE Richtungen dieselbe Funktion. Läuft das auseinander,
    // schreibt der Import CDs in den falschen Cast.

    // Alle exportfähigen Slots einer Zeile (Kategorie-Slots, Mehrfach-Instanzen
    // "any_dr@2" und Zusatz-CDs "extra_1").
    function collectExportableSlots(row) {
        var validSlots = [];
        Object.keys(row.slots || {}).forEach(function (slotKey) {
            var slot = row.slots[slotKey];
            if (!slot || slot.skipped || slot.isExtraPlaceholder || slot.notInRoster || slot.spreadGap) return;
            if (!slot.isVirtual && (!slot.player || !slot.dbName || slot.player === '__SKIP__')) return;
            slot._catKey = slotKey; // Store slotKey for later use
            validSlots.push(slot);
        });
        return validSlots;
    }

    // Auslöser / NPC / # / Zeit einer Matrix-Zeile, so wie sie im CD-Planer
    // landen. triggerCounts wird mitgezählt und MUSS über alle Zeilen in
    // derselben Reihenfolge laufen.
    function computeRowTrigger(row, triggerCounts) {
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
                        var found = TRIGGER_OPTIONS.find(function (t) { return t.val && t.val.indexOf('HEALTH') !== -1; });
                        if (found) healthTrigger = found.val;
                    }
                } catch (e) { /* ignore */ }
                if (!healthTrigger && window.TRIGGER_OPTIONS) {
                    var found2 = window.TRIGGER_OPTIONS.find(function (t) { return t.val && t.val.indexOf('HEALTH') !== -1; });
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
        } else if (row._isContinuous) {
            conditionVal = String(triggerCounts[triggerVal] || 1);
        } else {
            triggerCounts[triggerVal] = (triggerCounts[triggerVal] || 0) + 1;
            conditionVal = String(triggerCounts[triggerVal]);
        }

        var timeVal;
        if (isEncStartTrigger) {
            var cOff = row._continuousOffset || 0;
            timeVal = String(Math.round((row.absTime || 0) + (row.delay || 0) - cOff));
        } else {
            timeVal = String(row.delay || 0);
        }

        return {
            trigger: triggerVal,
            npc: (isHealthTrigger && npcVal) ? npcVal : '',
            isHealthTrigger: isHealthTrigger,
            isEncStartTrigger: isEncStartTrigger,
            condition: conditionVal,
            time: timeVal
        };
    }

    // Ein Durchlauf über alle Matrix-Zeilen in Export-Reihenfolge.
    // Liefert [{ row, validSlots, trig }] - Basis für Export UND Import.
    function buildExportIndex() {
        var triggerCounts = {};
        var out = [];
        assignments.forEach(function (row) {
            var validSlots = collectExportableSlots(row);
            if (validSlots.length === 0) return;
            out.push({ row: row, validSlots: validSlots, trig: computeRowTrigger(row, triggerCounts) });
        });
        return out;
    }

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

        // BATCH-MODE aktivieren: keine change-Events → keine setDoc-Calls aus handleAssignmentChange
        window._suspendAssignListeners = true;

        // Alle Änderungen sammeln für EINEN einzigen setDoc
        var batchPayload = {};
        // Logische Zeilen zuerst sammeln (vor dem Schreiben), damit identische
        // Einträge (gleicher Trigger/Key, Spieler, CD, Delay) zusammengefasst und
        // ihre #-Conditions zu z.B. "1,3" gemerged werden können.
        var entries = [];
        var currentManager = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('currentManager')) || 'Unbekannt';
        var serverTs = null;
        if (window.firebaseTools && window.firebaseTools.serverTimestamp) {
            serverTs = window.firebaseTools.serverTimestamp();
        }

        function addToBatch(fieldId, data) {
            batchPayload[fieldId] = data;
        }

        try {
            buildExportIndex().forEach(function (item) {
                var row = item.row;
                var validSlots = item.validSlots;
                var trig = item.trig;

                validSlots.forEach(function (slot) {
                    // Logische Zeile sammeln (noch nicht schreiben -> Merge erfolgt danach)
                    var entry = {
                        trigger: trig.trigger,
                        npc: trig.npc,
                        isHealthTrigger: trig.isHealthTrigger,
                        condition: trig.condition,
                        time: trig.time,
                        isVirtual: !!slot.isVirtual,
                        player: slot.player
                    };
                    if (slot.isVirtual) {
                        var virtCat = categories[slot.isVirtualCategoryKey] || categories[baseCatKey(slot._catKey)];
                        entry.cooldown = virtCat ? virtCat.name : 'Virtuell';
                        entry.virtColor = virtCat ? virtCat.color : '#fff';
                        entry.note = slot.note || '';
                        entry.tts = slot.tts || '';
                        entry.varname = slot.varname || '';
                        entry.icon = slot.icon || '';
                    } else {
                        entry.cooldown = slot.dbName;
                        entry.spellId = slot.spellId;
                    }
                    entries.push(entry);
                });
            });

            // ── MERGE: identische Zeilen (gleicher Trigger/Key, NPC, Spieler, CD,
            //    Delay) zusammenfassen und ihre #-Conditions zu "1,3" verbinden.
            //    Die WeakAura interpretiert mehrere Conditions korrekt. ──
            var mergedMap = {};
            var mergedOrder = [];
            entries.forEach(function (e) {
                var key = [
                    e.trigger, e.npc, e.player, e.cooldown, e.time,
                    e.isVirtual ? 'V' : 'R',
                    e.note || '', e.tts || '', e.varname || '', e.icon || ''
                ].join('||');
                if (!mergedMap[key]) {
                    var copy = {};
                    for (var k in e) { if (e.hasOwnProperty(k)) copy[k] = e[k]; }
                    copy._conds = [];
                    mergedMap[key] = copy;
                    mergedOrder.push(key);
                }
                var m = mergedMap[key];
                if (m._conds.indexOf(e.condition) === -1) m._conds.push(e.condition);
            });
            mergedOrder.forEach(function (key) {
                var m = mergedMap[key];
                var conds = m._conds.slice();
                // Numerisch sortieren, wenn alle Werte Ganzzahlen sind → "1,3" statt "3,1"
                if (conds.every(function (c) { return /^-?\d+$/.test(c); })) {
                    conds.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
                }
                m.condition = conds.join(',');
            });

            // ── SCHREIBEN der gemergten Zeilen ──
            mergedOrder.forEach(function (key) {
                var e = mergedMap[key];
                if (rowNum > 300) return;
                var rowPrefix = prefix + '-planner-row' + rowNum;

                // DOM aktualisieren (für sofortige Anzeige, aber OHNE change-Events)
                setPlannerSelect(rowPrefix + '-trigger', e.trigger, true);
                addToBatch(rowPrefix + '-trigger', { player: e.trigger, editor: currentManager, timestamp: serverTs });

                if (e.isHealthTrigger && e.npc) {
                    setPlannerInput(rowPrefix + '-npc', e.npc, true);
                    addToBatch(rowPrefix + '-npc', { player: e.npc, editor: currentManager, timestamp: serverTs });
                }

                setPlannerInput(rowPrefix + '-condition', e.condition, true);
                addToBatch(rowPrefix + '-condition', { text: e.condition, editor: currentManager, timestamp: serverTs });

                setPlannerInput(rowPrefix + '-time', e.time, true);
                addToBatch(rowPrefix + '-time', { text: e.time, editor: currentManager, timestamp: serverTs });

                if (e.isVirtual) {
                    setPlannerSelect(rowPrefix + '-player', e.player, true);
                    addToBatch(rowPrefix + '-player', { player: e.player, editor: currentManager, timestamp: serverTs });

                    // Stelle sicher, dass die Option im Select existiert, sonst wird es leer angezeigt
                    var sel = document.querySelector('[data-assignment-id="' + rowPrefix + '-cooldown"]');
                    if (sel) {
                        var exists = Array.from(sel.options).some(function (o) { return o.value === e.cooldown; });
                        if (!exists) {
                            var opt = document.createElement('option');
                            opt.value = e.cooldown;
                            opt.textContent = e.cooldown;
                            opt.dataset.color = e.virtColor || '#fff';
                            sel.appendChild(opt);
                        }
                    }

                    setPlannerSelect(rowPrefix + '-cooldown', e.cooldown, true);
                    addToBatch(rowPrefix + '-cooldown', { cooldown: e.cooldown, editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-note', e.note || "", true);
                    addToBatch(rowPrefix + '-note', { text: e.note || "", editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-tts', e.tts || "", true);
                    addToBatch(rowPrefix + '-tts', { text: e.tts || "", editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-varname', e.varname || "", true);
                    addToBatch(rowPrefix + '-varname', { text: e.varname || "", editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-icon', e.icon || "", true);
                    addToBatch(rowPrefix + '-icon', { text: e.icon || "", editor: currentManager, timestamp: serverTs });

                    exported++;
                } else {
                    setPlannerSelect(rowPrefix + '-player', e.player, true);
                    addToBatch(rowPrefix + '-player', { player: e.player, editor: currentManager, timestamp: serverTs });

                    var ok = setPlannerSelect(rowPrefix + '-cooldown', e.cooldown, true);
                    addToBatch(rowPrefix + '-cooldown', { cooldown: e.cooldown, editor: currentManager, timestamp: serverTs });

                    if (ok) exported++; else {
                        skipped++;
                        console.warn('[Auto-Planner] CD nicht gefunden: "' + e.cooldown + '" (' + e.spellId + ')');
                    }
                }
                rowNum++;
            });

            // ── Alle Zeilen NACH dem geschriebenen Block leeren ──
            // Früher wurde nur bis entries.length dieses Exports geleert. War ein
            // vorheriger Export länger (mehr Events aktiv, weniger Merges), blieben
            // dessen Zeilen dahinter stehen und tauchten in der Übersicht als
            // Geister-Einträge auf (z.B. ein zweites "Kampfbeginn" mit falscher #).
            // Deshalb bis zur letzten tatsächlich befüllten Zeile aufräumen.
            var lastUsedRow = 0;
            for (var probe = 1; probe <= 300; probe++) {
                var probeEl = document.querySelector('[data-assignment-id="' + prefix + '-planner-row' + probe + '-trigger"]');
                if (probeEl && probeEl.value) lastUsedRow = probe;
            }
            var clearFields = ['trigger', 'npc', 'condition', 'time', 'player', 'cooldown', 'note', 'tts', 'varname', 'icon'];
            for (var clr = rowNum; clr <= lastUsedRow; clr++) {
                var clrPrefix = prefix + '-planner-row' + clr;
                clearFields.forEach(function (f) {
                    var fieldId = clrPrefix + '-' + f;
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
                    // Alle potenziellen Keys leeren, um Rückstände zu vermeiden (wie clearPlannerOnly)
                    addToBatch(fieldId, { player: '', text: '', cooldown: '', editor: currentManager, timestamp: serverTs });
                });
            }

            // In Chunks schreiben, um das 500-Field-Transforms-Limit von Firestore zu umgehen
            if (firebaseRef && firebaseRef.setDoc && Object.keys(batchPayload).length > 0) {
                var bossDocId = "boss-" + (config.id || prefix.toLowerCase());
                var payloadKeys = Object.keys(batchPayload);
                for (var c = 0; c < payloadKeys.length; c += 400) {
                    var chunk = {};
                    for (var j = 0; j < 400 && c + j < payloadKeys.length; j++) {
                        var key = payloadKeys[c + j];
                        chunk[key] = batchPayload[key];
                    }
                    await firebaseRef.setDoc(
                        firebaseRef.doc(firebaseRef.db, "raid-tool-data", bossDocId),
                        chunk,
                        { merge: true }
                    );
                }
            }
        } finally {
            window._suspendAssignListeners = false;
        }

        if (window.updatePlannerSummary) setTimeout(window.updatePlannerSummary, 200);
        var msg = exported + ' Zeilen exportiert!';
        if (skipped > 0) msg += '\n⚠ ' + skipped + ' CDs nicht im Dropdown.';
        if (window.showModal) window.showModal(msg);
    }

    // ══════════════════════════════════════════════════════════════
    // IMPORT ← CD-PLANER
    // Liest die Zeilen des Advanced CD Planners und trägt sie als manuelle
    // Einträge in die Matrix ein. Gegenstück zu exportToPlanner: die Zuordnung
    // Planer-Zeile → Matrix-Zeile läuft über dieselbe Auslöser/#-Berechnung.
    // ══════════════════════════════════════════════════════════════

    // Alle Kategorien, in denen dieser Cooldown vorkommt (Reihenfolge = Kategorie-
    // Reihenfolge). Damit landet ein importierter CD in seiner "richtigen" Spalte
    // statt in einer Zusatzspalte.
    function categoriesContainingCd(dbName) {
        var hits = [];
        Object.keys(categories).forEach(function (catKey) {
            var cat = categories[catKey];
            if (!cat || cat.isVirtual || !Array.isArray(cat.spells)) return;
            var found = resolveCategory(catKey).some(function (sp) { return sp.dbName === dbName; });
            if (found) hits.push(catKey);
        });
        return hits;
    }

    // Virtuelle Kategorie anhand ihres Anzeigenamens (so exportiert exportToPlanner sie)
    function virtualCategoryByName(name) {
        var hit = null;
        Object.keys(categories).forEach(function (catKey) {
            var cat = categories[catKey];
            if (cat && cat.isVirtual && cat.name === name && !hit) hit = catKey;
        });
        return hit;
    }

    // Sucht in einer Matrix-Zeile den Slot, in den dieser CD gehört.
    // taken = bereits in diesem Import belegte Slot-Keys dieser Zeile.
    function pickSlotKeyForImport(row, dbName, player, taken) {
        var requiredKeys = slotKeysForRequired(row.requiredCDs);
        var candidateCats = categoriesContainingCd(dbName);

        // 1) Exakt dieselbe Zuweisung ist schon da -> diesen Slot wiederverwenden
        var exact = Object.keys(row.slots || {}).find(function (k) {
            var s = row.slots[k];
            return s && s.dbName === dbName && s.player === player && taken.indexOf(k) === -1;
        });
        if (exact) return exact;

        // 2) Passende Kategorie-Spalte, die frei ist oder denselben CD hält
        var ordered = requiredKeys.filter(function (k) { return candidateCats.indexOf(baseCatKey(k)) !== -1; });
        var free = ordered.find(function (k) {
            if (taken.indexOf(k) !== -1) return false;
            var s = row.slots[k];
            return !s || !s.player || s.unavailable || s.spreadGap || s.dbName === dbName;
        });
        if (free) return free;

        // 3) Kategorie passt, ist aber am Event nicht gefordert -> eigene Spalte
        var extraCat = candidateCats.find(function (c) { return taken.indexOf(c) === -1 && !(row.slots[c] && row.slots[c].player); });
        if (extraCat) return extraCat;

        // 4) Zusatz-Slot. Nummer so wählen, dass nichts überschrieben wird.
        for (var n = 1; n <= 40; n++) {
            var k = 'extra_' + n;
            if (taken.indexOf(k) !== -1) continue;
            var s = row.slots[k];
            if (!s || !s.player) return k;
        }
        return null;
    }

    // Liest alle befüllten Zeilen des Advanced CD Planners aus dem DOM.
    function readPlannerRows(prefix) {
        var out = [];
        for (var i = 1; i <= 300; i++) {
            var rp = prefix + '-planner-row' + i;
            var triggerEl = document.querySelector('[data-assignment-id="' + rp + '-trigger"]');
            if (!triggerEl) continue;
            var playerEl = document.querySelector('[data-assignment-id="' + rp + '-player"]');
            var cdEl = document.querySelector('[data-assignment-id="' + rp + '-cooldown"]');
            if (!triggerEl.value) continue;
            if (!playerEl || !cdEl || !playerEl.value || !cdEl.value) continue;

            var get = function (f) {
                var el = document.querySelector('[data-assignment-id="' + rp + '-' + f + '"]');
                return el && el.value ? el.value.trim() : '';
            };
            out.push({
                rowNum: i,
                trigger: triggerEl.value,
                npc: get('npc'),
                condition: get('condition') || '0',
                time: get('time') || '0',
                player: playerEl.value,
                cooldown: cdEl.value,
                note: get('note'),
                tts: get('tts'),
                varname: get('varname'),
                icon: get('icon')
            });
        }
        return out;
    }

    async function importFromPlanner() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
        if (!assignments.length) {
            return window.showModal && window.showModal("Die Matrix ist leer - erst „Auto-Zuweisen“ ausführen, damit es Zeilen zum Zuordnen gibt.");
        }
        var container = document.querySelector('[id$="-planner-container"]');
        if (!container) return window.showModal && window.showModal("CD-Planer nicht gefunden.");
        var prefix = container.id.replace('-planner-container', '');

        var plannerRows = readPlannerRows(prefix);
        if (plannerRows.length === 0) {
            return window.showModal && window.showModal("Im Advanced CD Planner stehen keine vollständigen Zeilen (Auslöser + Spieler + Cooldown).");
        }

        // Index über die Matrix aufbauen: "TRIGGER|#" → alle Zeilen dieses Casts.
        // Mehrere Zeilen pro Schlüssel sind normal (Soak-Rotation: alle
        // Rotationszeilen hängen am selben Cast, unterscheiden sich aber in der
        // Zeit). Deshalb wird unten zusätzlich über die Zeit ausgewählt.
        var index = {};
        buildExportIndex().forEach(function (item) {
            var key = item.trig.trigger + '|' + item.trig.condition;
            if (!index[key]) index[key] = [];
            index[key].push(item);
        });

        // Wohin gehört eine Planer-Zeile? Kandidaten sind alle Matrix-Zeilen mit
        // demselben Auslöser + #, sortiert nach Zeit-Nähe (bei der Soak-Rotation
        // hängen mehrere Zeilen am selben Cast und unterscheiden sich nur darin).
        // Eine Zeile, die diese Zuweisung bereits enthält, gewinnt immer - so
        // bleibt Export → Import identisch und legt keine Dubletten an.
        function pickPlacement(candidates, pr, takenPerRow) {
            if (!candidates || candidates.length === 0) return null;
            var want = parseFloat(pr.time);
            if (isNaN(want)) want = 0;

            var sorted = candidates.slice().sort(function (a, b) {
                var ta = parseFloat(a.trig.time); if (isNaN(ta)) ta = 0;
                var tb = parseFloat(b.trig.time); if (isNaN(tb)) tb = 0;
                return Math.abs(ta - want) - Math.abs(tb - want);
            });

            // 1) Zeile, in der Spieler + CD schon genau so stehen
            for (var i = 0; i < sorted.length; i++) {
                var row = sorted[i].row;
                var taken = takenPerRow[rowOverridePrefix(row)] || [];
                var exact = Object.keys(row.slots || {}).find(function (k) {
                    var s = row.slots[k];
                    return s && s.dbName === pr.cooldown && s.player === pr.player && taken.indexOf(k) === -1;
                });
                if (exact) return { row: row, slotKey: exact };
            }

            // 2) Sonst die zeitlich nächste Zeile, in der noch ein Slot frei ist
            for (var j = 0; j < sorted.length; j++) {
                var r2 = sorted[j].row;
                var t2 = takenPerRow[rowOverridePrefix(r2)] || [];
                var sk = pickSlotKeyForImport(r2, pr.cooldown, pr.player, t2);
                if (sk) return { row: r2, slotKey: sk };
            }
            return null;
        }

        // Vorschau rechnen, damit der Bestätigungsdialog sagen kann, was passiert
        var planned = [];      // { row, slotKey, override }
        var unmatched = [];    // Planer-Zeilen ohne passende Matrix-Zeile
        var noSlot = [];       // zugeordnet, aber kein Platz in der Zeile
        var takenPerRow = {};  // rowPrefix → belegte Slot-Keys

        plannerRows.forEach(function (pr) {
            // "1,3" → mehrere Casts
            var conds = pr.condition.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
            if (conds.length === 0) conds = ['0'];

            var matchedAny = false;
            conds.forEach(function (cond) {
                var candidates = index[pr.trigger + '|' + cond];
                if (!candidates || candidates.length === 0) return;
                matchedAny = true;

                var placement = pickPlacement(candidates, pr, takenPerRow);
                if (!placement) { noSlot.push(pr); return; }
                var row = placement.row;

                var rowPrefix = rowOverridePrefix(row);
                if (!takenPerRow[rowPrefix]) takenPerRow[rowPrefix] = [];
                var taken = takenPerRow[rowPrefix];

                // Virtuelle Kategorie (Marker, Ansagen ...) wieder als solche eintragen
                var virtKey = virtualCategoryByName(pr.cooldown);
                if (virtKey) {
                    var vSlotKey = taken.indexOf(virtKey) === -1 ? virtKey : null;
                    if (!vSlotKey) { noSlot.push(pr); return; }
                    taken.push(vSlotKey);
                    planned.push({
                        row: row, slotKey: vSlotKey,
                        override: { player: pr.player, dbName: '__VIRTUAL__', isVirtualCategoryKey: virtKey }
                    });
                    return;
                }

                var slotKey = placement.slotKey;
                taken.push(slotKey);

                var dbEntry = cooldownsDB.find(function (cd) { return cd.name === pr.cooldown; });
                var catSpell = resolveCategory(baseCatKey(slotKey)).find(function (sp) { return sp.dbName === pr.cooldown; });
                planned.push({
                    row: row, slotKey: slotKey,
                    override: {
                        player: pr.player,
                        dbName: pr.cooldown,
                        dbClass: dbEntry ? dbEntry.class : 'UNKNOWN',
                        spellId: dbEntry ? dbEntry.spellId : '',
                        cooldownSec: (catSpell && catSpell.cooldownSec) || parseInt(dbEntry && dbEntry.cooldownSec) || 180,
                        durationSec: (catSpell && catSpell.durationSec) || parseInt(dbEntry && dbEntry.durationSec) || 0
                    }
                });
            });
            if (!matchedAny) unmatched.push(pr);
        });

        if (planned.length === 0) {
            var hint = "Keine Planer-Zeile konnte einer Matrix-Zeile zugeordnet werden.\n\n"
                + "Der Import ordnet über Auslöser + # zu - genau so, wie der Export sie schreibt. "
                + "Passt beides nicht zusammen (z.B. weil die Events seitdem geändert wurden), "
                + "hilft ein „In CD-Planer exportieren“ als gemeinsamer Ausgangspunkt.";
            return window.showModal && window.showModal(hint);
        }

        // Was steht in einer angefassten Matrix-Zeile, kommt aber im Plan nicht
        // vor? Der Import löscht nichts - der Nutzer soll aber wissen, dass die
        // Matrix danach mehr enthält als sein Plan.
        var leftovers = 0;
        var touchedRows = [];
        planned.forEach(function (pl) {
            if (touchedRows.indexOf(pl.row) === -1) touchedRows.push(pl.row);
        });
        touchedRows.forEach(function (row) {
            var taken = takenPerRow[rowOverridePrefix(row)] || [];
            Object.keys(row.slots || {}).forEach(function (k) {
                var sl = row.slots[k];
                if (!sl || !sl.player || sl.player === '__SKIP__' || sl.skipped) return;
                if (sl.notInRoster || sl.isExtraPlaceholder) return;
                if (taken.indexOf(k) === -1) leftovers++;
            });
        });

        var msg = "Advanced CD-Plan in die Matrix übernehmen?\n\n"
            + "• " + planned.length + " Einträge werden als manuelle CDs gesetzt\n";
        if (unmatched.length > 0) {
            msg += "• " + unmatched.length + " Planer-Zeilen ohne passende Matrix-Zeile (bleiben unberührt)\n";
        }
        if (noSlot.length > 0) {
            msg += "• " + noSlot.length + " Zeilen ohne freien Platz in ihrer Matrix-Zeile\n";
        }
        if (leftovers > 0) {
            msg += "• " + leftovers + " CDs stehen in der Matrix, aber nicht im Plan - die bleiben stehen\n";
        }
        msg += "\nBestehende Matrix-Einträge werden dabei überschrieben, nichts wird gelöscht.\nFortfahren?";

        var ok = true;
        if (typeof window.showModal === 'function') {
            var r = window.showModal(msg, true);
            if (r && typeof r.then === 'function') ok = await r;
        } else {
            ok = confirm(msg);
        }
        if (!ok) return;

        planned.forEach(function (p) {
            manualOverrides[rowOverridePrefix(p.row) + '-' + p.slotKey] = p.override;
        });

        markDirty();
        await runAutoAssign();

        var done = planned.length + ' Einträge übernommen.';
        if (unmatched.length > 0) done += '\n⚠ ' + unmatched.length + ' Zeilen nicht zugeordnet (Auslöser/# ohne Gegenstück).';
        if (noSlot.length > 0) done += '\n⚠ ' + noSlot.length + ' Zeilen ohne freien Slot.';
        if (leftovers > 0) done += '\n⚠ ' + leftovers + ' CDs in der Matrix stehen nicht im Plan (unverändert gelassen).';
        done += '\n\nZum dauerhaften Sichern noch „Plan speichern“ klicken.';
        if (window.showModal) window.showModal(done);
    }

    function setPlannerSelect(id, value, suppressEvent) {
        var el = document.querySelector('[data-assignment-id="' + id + '"]');
        if (!el) return false;
        var exists = Array.from(el.options).some(function (o) { return o.value === value; });
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
                    assignments: assignments.map(function (r) {
                        var slots = {};
                        Object.entries(r.slots).forEach(function (e) {
                            // „Kein CD nötig" mitspeichern, sonst sieht ein geladener
                            // Plan (z.B. in der Nur-Lese-Ansicht) an der Stelle so aus,
                            // als hätte schlicht kein Cooldown gepasst.
                            if (e[1] && e[1].skipped) {
                                slots[e[0]] = { player: '__SKIP__', dbName: '__SKIP__', skipped: true, auto: false };
                                return;
                            }
                            if (e[1].player && e[1].player !== '__SKIP__' && !e[1].notInRoster) {
                                slots[e[0]] = { player: e[1].player, dbName: e[1].dbName, auto: e[1].auto };
                            }
                        });
                        return {
                            eventName: r.eventName,
                            eventKey: r.eventKey,
                            eventIdx: r.eventIdx,
                            castIdx: r.castIdx || r.castNum,
                            castNum: r.castNum,
                            absTime: r.absTime,
                            delay: r.delay || 0,
                            slots: slots,
                            eventDuration: r.eventDuration || 0,
                            overlapSec: r.overlapSec || 0,
                            _isContinuous: r._isContinuous || false,
                            _contIdx: r._contIdx || 0,
                            _continuousOffset: r._continuousOffset || 0,
                            _sourceTriggerMap: r._sourceTriggerMap || null,
                            soak: r.soak || null,
                            // Soak-Rotationszeilen: Nummer + die tatsächlich für
                            // DIESE Zeile geltenden Kategorien mitspeichern. Ohne
                            // beides zeigte die geladene Ansicht auf jeder
                            // Rotationszeile alle Event-Kategorien (also lauter
                            // leere Spalten) statt nur den Soak.
                            _bloodrageExpanded: r._bloodrageExpanded || false,
                            _soakIdx: r._soakIdx || 0,
                            requiredCDs: r._bloodrageExpanded ? (r.requiredCDs || []) : null
                        };
                    })
                }, { merge: false }
            );
            clearDirty();
            if (window.showModal) window.showModal("Matrix-Plan gespeichert!");
        } catch (e) { if (window.showModal) window.showModal("Fehler: " + e.message); }
    }

    async function loadPlan() {
        if (!firebaseRef) return false;
        try {
            var snap = await firebaseRef.getDoc(firebaseRef.doc(firebaseRef.db, "auto-planner", config.id));
            if (snap.exists()) {
                var data = snap.data();
                manualOverrides = data.manualOverrides || {};
                eventOverrides = data.eventOverrides || {};
                customEvents = data.customEvents || [];
                if (data.assignStrategy && typeof data.assignStrategy === 'object') {
                    assignStrategy.spread = !!data.assignStrategy.spread;
                    assignStrategy.prioritizeCategories = !!data.assignStrategy.prioritizeCategories;
                    assignStrategy.roundRobin = !!data.assignStrategy.roundRobin;
                    assignStrategy.preferHeal = !!data.assignStrategy.preferHeal;
                    assignStrategy.strictClassBalance = !!data.assignStrategy.strictClassBalance;
                }
                if (data.assignments && Array.isArray(data.assignments)) {
                    var roster = window.effectiveRoster || window.rosterData || [];
                    // Build eventKey→eventIdx lookup for reconstructing eventIdx from saved data
                    var effectiveEvts = getEffectiveEvents();
                    var eventKeyToIdx = {};
                    effectiveEvts.forEach(function (evt, idx) {
                        if (evt._key) eventKeyToIdx[evt._key] = idx;
                    });
                    assignments = data.assignments.map(function (r) {
                        var evtObj = null;
                        if (r.eventKey && r.eventKey.startsWith('cfg_')) {
                            var idx = parseInt(r.eventKey.replace('cfg_', ''));
                            evtObj = config.events[idx] || {};
                        } else {
                            evtObj = customEvents.find(function (e) { return e._key === r.eventKey; }) || {};
                        }
                        var ov = eventOverrides[r.eventKey] || {};
                        r.icon = ov.icon !== undefined ? ov.icon : (evtObj.icon || '');

                        // Expandierte Soak-Zeilen bringen ihre eigenen Kategorien mit
                        // (nur der Soak, bei der ersten Zeile zusätzlich der Rest des
                        // Events). Die dürfen nicht vom Event überschrieben werden.
                        var isExpandedSoak = !!r._bloodrageExpanded && Array.isArray(r.requiredCDs);
                        if (!isExpandedSoak) {
                            r.requiredCDs = ov.requiredCDs !== undefined ? ov.requiredCDs : (evtObj.requiredCDs || []);
                        }

                        // Eskalation genauso auswerten wie generateTimeline, sonst
                        // bekäme jeder Cast des Events dieselben Kategorien - in der
                        // geladenen (Nur-Lese-)Ansicht stünde dann überall „kein CD
                        // frei", wo bewusst gar keiner geplant war.
                        var escR = ov.escalationRanges !== undefined ? ov.escalationRanges : (evtObj.escalationRanges || []);
                        if (!isExpandedSoak && escR && escR.length) {
                            var resetN = ov.resetEscalation !== undefined ? ov.resetEscalation : (evtObj.resetEscalation || 0);
                            var cn = r.castIdx || r.castNum || 1;
                            if (resetN) cn = ((cn - 1) % resetN) + 1;
                            var mR = escR.find(function (x) { return cn >= x.start && cn <= x.end; });
                            r.requiredCDs = mR ? (mR.categories || []) : [];
                        }

                        // Reconstruct eventIdx if missing (not saved in older plans)
                        if (r.eventIdx === undefined || r.eventIdx === null) {
                            r.eventIdx = (r.eventKey && eventKeyToIdx[r.eventKey] !== undefined)
                                ? eventKeyToIdx[r.eventKey]
                                : 0;
                        }

                        if (r.slots) {
                            Object.keys(r.slots).forEach(function (catKey) {
                                var slot = r.slots[catKey];
                                if (slot && slot.player && slot.player !== '__SKIP__') {
                                    var cd = cooldownsDB.find(function (c) { return c.name === slot.dbName; });
                                    if (cd) {
                                        slot.dbClass = cd.class;
                                        slot.durationSec = cd.durationSec || '';
                                        slot.cooldownSec = cd.cooldownSec || '';
                                    }
                                    var p = roster.find(function (x) { return x.name === slot.player; });
                                    if (p && p.class) slot.dbClass = p.class;
                                }
                            });
                        }

                        return r;
                    });

                    // Doppelt gespeicherte Eskalations-Bereiche aufräumen (Altlast
                    // eines früheren Bugs). Die Bereiche selbst stehen in
                    // eventOverrides - aus den gespeicherten Zeilen lassen sie sich
                    // nicht rekonstruieren, savePlan schreibt requiredCDs gar nicht mit.
                    Object.keys(eventOverrides).forEach(function (k) {
                        var eo = eventOverrides[k];
                        if (eo && eo.escalationRanges && eo.escalationRanges.length > 0) {
                            var unique = [];
                            var seen = {};
                            eo.escalationRanges.forEach(function (r) {
                                var sig = r.start + '-' + r.end + '-' + JSON.stringify(r.categories || []);
                                if (!seen[sig]) {
                                    seen[sig] = true;
                                    unique.push(r);
                                }
                            });
                            eo.escalationRanges = unique;
                        }
                    });
                }
                clearDirty();
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
            _catsDirty = false;
            refreshCategoriesDirty();
            if (window.showModal) window.showModal("Kategorien gespeichert!");
        } catch (e) {
            console.error("[Auto-Planner]", e);
            if (window.showModal) window.showModal("Kategorien konnten NICHT gespeichert werden: " + e.message);
        }
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
                Object.keys(DEFAULT_CATEGORIES).forEach(function (k) {
                    if (!dbCats[k]) dbCats[k] = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES[k]));
                });
                categories = dbCats;
                return;
            }
        } catch (e) { console.error("[Auto-Planner]", e); }
        categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    }

    // ── Kategorien: ungespeicherte Änderungen sichtbar machen ──
    var _catsDirty = false;
    function markCategoriesDirty() {
        _catsDirty = true;
        refreshCategoriesDirty();
    }
    function refreshCategoriesDirty() {
        var btn = document.getElementById('btn-save-categories');
        if (btn) {
            btn.classList.toggle('cd-save-dirty', _catsDirty);
            btn.title = _catsDirty
                ? 'Ungespeicherte Änderungen an den CD-Kategorien.'
                : 'Kategorien und Prioritäten in der Datenbank speichern (gilt für alle Bosse).';
        }
        var hint = document.getElementById('cd-cat-dirty-hint');
        if (hint) hint.style.display = _catsDirty ? '' : 'none';
    }

    // Alt-Buttons aus den Boss-HTMLs entfernen.
    // Dort steckte der Speichern-Button teils mit style="display:none" (dann war
    // er nie zu sehen), teils gleich zweimal mit derselben ID (dann bekam die
    // unsichtbare erste Kopie den Klick-Handler und die sichtbare zweite tat
    // nichts). Der Editor rendert sich seinen Button unten selbst.
    function dropLegacySaveCategoriesButtons() {
        Array.from(document.querySelectorAll('[id="btn-save-categories"]')).forEach(function (b) {
            if (b.parentNode) b.parentNode.removeChild(b);
        });
    }

    function renderCategoriesAdmin() {
        var el = document.getElementById('cd-categories-container');
        if (!el) return;

        dropLegacySaveCategoriesButtons();

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
                '#cd-categories-container::-webkit-scrollbar-track { background: #1e293b; }' +
                // Der Editor scrollt bei vielen Kategorien lang - die Kopfzeile mit
                // „Speichern" bleibt deshalb oben stehen statt wegzuscrollen.
                '#cd-cat-toolbar { position: sticky; top: 0; z-index: 5; background: #0f172a; ' +
                'border-bottom: 1px solid #334155; padding: 6px 0; margin: 0 0 12px 0; }' +
                '@keyframes cdSaveBlink { 0%,100% { box-shadow:0 0 0 0 rgba(250,204,21,0); } 50% { box-shadow:0 0 0 3px rgba(250,204,21,0.95); } }' +
                '.cd-save-dirty { animation:cdSaveBlink 1s ease-in-out infinite; }';
            document.head.appendChild(styleTag);
        }

        // Speichern-Button gehört fest zur Kopfzeile des Editors - er wird bei
        // jedem Rendern mit erzeugt und in attachEditorListeners frisch verdrahtet.
        var addCatBtn = '<div id="cd-cat-toolbar" class="flex items-center gap-2 flex-wrap">'
            + '<button id="btn-add-category" class="bg-emerald-700 hover:bg-emerald-800 text-white text-xs py-1.5 px-3 rounded border border-emerald-500">+ Neue Kategorie</button>'
            + '<button id="btn-save-categories" class="bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold py-1.5 px-3 rounded border border-amber-400">💾 Kategorien speichern</button>'
            + '<span id="cd-cat-dirty-hint" class="text-[10px] text-amber-400" style="display:none;">ungespeicherte Änderungen</span>'
            + '</div>';

        var catsHtml = Object.entries(categories).map(function (entry) {
            var key = entry[0], cat = entry[1];

            if (cat.isVirtual) {
                var playerVal = cat.defaultPlayer || 'ALL';
                var playerOptions = [
                    { val: 'ALL', label: 'Alle' },
                    { val: 'TANKS', label: 'Tanks' },
                    { val: 'HEALERS', label: 'Heiler' },
                    { val: 'MELEEDPS', label: 'Melee' },
                    { val: 'RANGEDDPS', label: 'Range' },
                    { val: 'PRIEST', label: 'Priest' },
                    { val: 'PALADIN', label: 'Paladin' },
                    { val: 'MAGE', label: 'Mage' },
                    { val: 'WARLOCK', label: 'Warlock' },
                    { val: 'ROGUE', label: 'Rogue' },
                    { val: 'DRUID', label: 'Druid' },
                    { val: 'HUNTER', label: 'Hunter' },
                    { val: 'SHAMAN', label: 'Shaman' },
                    { val: 'WARRIOR', label: 'Warrior' },
                    { val: 'DEATHKNIGHT', label: 'Death Knight' },
                    { val: 'MONK', label: 'Monk' }
                ].map(function (opt) {
                    return '<option value="' + opt.val + '"' + (playerVal === opt.val || playerVal === opt.label ? ' selected' : '') + '>' + opt.label + '</option>';
                }).join('');

                return '<div class="bg-slate-750 p-3 rounded border border-slate-600 mb-2" data-cat-key="' + key + '">'
                    + '<div class="flex items-center gap-2 mb-2">'
                    + '<input type="color" class="cat-color-input w-6 h-6 bg-transparent border-0 cursor-pointer" data-cat="' + key + '" value="' + cat.color + '" title="Farbe">'
                    + '<input type="text" class="cat-name-input text-sm font-bold bg-slate-900 text-white px-2 py-1 rounded border border-slate-600 flex-1" data-cat="' + key + '" value="' + cat.name + '" placeholder="Anzeigename">'
                    + '<input type="text" class="cat-short-input text-xs bg-slate-900 text-gray-300 px-2 py-1 rounded border border-slate-600 w-24" data-cat="' + key + '" value="' + (cat.shortName || '') + '" placeholder="Kurzname">'
                    + '<span class="bg-indigo-600/30 text-indigo-300 border border-indigo-500/50 text-[10px] px-1.5 py-0.5 rounded font-bold" title="TTS/Text-Warnung ohne RaidCD">VIRTUELL</span>'
                    + '<span class="text-[10px] text-gray-500 font-mono">' + key + '</span>'
                    + '<button class="delete-cat-btn text-red-400 hover:text-red-300 text-lg px-1" data-cat="' + key + '" title="Kategorie löschen">🗑</button>'
                    + '</div>'
                    + '<div class="flex flex-col gap-1 pl-8 bg-slate-800/50 p-2 rounded text-xs">'
                    + '<div class="flex gap-2 items-center"><label class="w-24 text-gray-400 text-right">Zielgruppe:</label><select class="cat-virtual-input bg-slate-900 border border-slate-600 rounded px-2 py-0.5 flex-1" data-field="defaultPlayer" data-cat="' + key + '">' + playerOptions + '</select></div>'
                    + '<div class="flex gap-2 items-center"><label class="w-24 text-gray-400 text-right">Sprachausgabe:</label><input type="text" class="cat-virtual-input bg-slate-900 border border-slate-600 rounded px-2 py-0.5 flex-1" data-field="defaultTts" data-cat="' + key + '" value="' + (cat.defaultTts || '') + '"></div>'
                    + '<div class="flex gap-2 items-center"><label class="w-24 text-gray-400 text-right">Zusatztext:</label><input type="text" class="cat-virtual-input bg-slate-900 border border-slate-600 rounded px-2 py-0.5 flex-1" data-field="defaultNote" data-cat="' + key + '" value="' + (cat.defaultNote || '') + '"></div>'
                    + '<div class="flex gap-2 items-center"><label class="w-24 text-gray-400 text-right">Spalten-Name:</label><input type="text" class="cat-virtual-input bg-slate-900 border border-slate-600 rounded px-2 py-0.5 flex-1" data-field="defaultName" data-cat="' + key + '" value="' + (cat.defaultName || '') + '"></div>'
                    + '<div class="flex gap-2 items-center"><label class="w-24 text-gray-400 text-right">Icon-ID:</label><input type="text" class="cat-virtual-input bg-slate-900 border border-slate-600 rounded px-2 py-0.5 w-32" data-field="defaultIcon" data-cat="' + key + '" value="' + (cat.defaultIcon || '') + '"></div>'
                    + '</div>'
                    + '</div>';
            }

            var resolved = resolveCategory(key);
            var rows = cat.spells.map(function (sp, idx) {
                var r = resolved.find(function (x) { return String(x.spellId) === String(sp.spellId); });
                var found = !!r;
                var name = r ? r.dbName : 'SpellID ' + sp.spellId;
                var cls = r ? r.dbClass : '?';
                var color = found ? getClassColor(cls) : '#ef4444';
                var cdS = r ? r.cooldownSec : sp.cooldownSec;
                var durS = r ? r.durationSec : (sp.durationSec || 0);
                var role = sp.requiredRole || '';
                var roleOptions = ['', 'heal', 'tank', 'dps'].map(function (r) {
                    return '<option value="' + r + '"' + (role === r ? ' selected' : '') + '>' + (r || 'alle') + '</option>';
                }).join('');

                // Spec-Anzeige: Lesbare Labels mit Klassen-Kontext
                var specList = Array.isArray(sp.requiredSpec) ? sp.requiredSpec : (sp.requiredSpec ? [sp.requiredSpec] : []);
                var specDisplay = '';
                if (specList.length === 0) {
                    specDisplay = '<span class="text-gray-500 italic">alle Specs</span>';
                } else if (specList.length <= 2) {
                    specDisplay = specList.map(function (s) { return getSpecLabel(s); }).join(', ');
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
                    + '<span class="opacity-60">Specs:</span> ' + specDisplay
                    + '</button>'
                    + '<span class="text-gray-600 font-mono" title="Wirkdauer">' + durS + 's</span>'
                    + '<span class="text-gray-600 font-mono" title="Cooldown">' + cdS + 's CD</span>'
                    + '<span class="text-gray-700 font-mono text-[9px] w-12">' + sp.spellId + '</span>'
                    + '<button class="remove-spell-btn text-red-400 hover:text-red-300 px-1" data-cat="' + key + '" data-idx="' + idx + '" title="Spell entfernen">✕</button>'
                    + '</div>';
            }).join('');

            var catRoleOptions = ['', 'heal', 'tank', 'dps'].map(function (r) {
                return '<option value="' + r + '"' + ((cat.requiredRole || '') === r ? ' selected' : '') + '>' + (r || 'alle') + '</option>';
            }).join('');

            return '<div class="bg-slate-750 p-3 rounded border border-slate-600 mb-2" data-cat-key="' + key + '">'
                + '<div class="flex items-center gap-2 mb-2">'
                + '<input type="color" class="cat-color-input w-6 h-6 bg-transparent border-0 cursor-pointer" data-cat="' + key + '" value="' + cat.color + '" title="Farbe">'
                + '<input type="text" class="cat-name-input text-sm font-bold bg-slate-900 text-white px-2 py-1 rounded border border-slate-600 flex-1" data-cat="' + key + '" value="' + cat.name + '" placeholder="Anzeigename">'
                + '<input type="text" class="cat-short-input text-xs bg-slate-900 text-gray-300 px-2 py-1 rounded border border-slate-600 w-24" data-cat="' + key + '" value="' + (cat.shortName || '') + '" placeholder="Kurzname">'
                + '<select class="cat-role-select bg-slate-900 text-gray-400 text-[10px] px-1 py-1 rounded border border-slate-600" data-cat="' + key + '" title="Rolle für gesamte Kategorie">' + catRoleOptions + '</select>'
                + '<span class="text-[10px] text-gray-500 font-mono">' + key + '</span>'
                + '<button class="delete-cat-btn text-red-400 hover:text-red-300 text-lg px-1" data-cat="' + key + '" title="Kategorie löschen">🗑</button>'
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
        // Speichern - der Button wird bei jedem Rendern neu erzeugt, also hier
        // auch jedes Mal neu verdrahtet.
        var saveCatBtn = document.getElementById('btn-save-categories');
        if (saveCatBtn) {
            saveCatBtn.addEventListener('click', function () { saveCategories(); });
        }
        refreshCategoriesDirty();

        // Add category
        var addBtn = document.getElementById('btn-add-category');
        if (addBtn) {
            addBtn.addEventListener('click', function () {
                var isVirt = confirm('Soll dies eine Virtuelle TTS-Kategorie (ohne Spieler-Zuordnung) werden? OK = Ja, Abbrechen = Nein (Normale Kategorie)');
                var key = prompt('Eindeutiger Key für neue Kategorie (z.B. "dispel_magic" oder "gesundheitssteine"):');
                if (!key) return;
                if (categories[key]) { alert('Key existiert bereits!'); return; }
                var name = prompt('Anzeigename:', key);
                if (!name) return;

                if (isVirt) {
                    categories[key] = {
                        name: name, shortName: name.substring(0, 10), color: '#8b5cf6',
                        isVirtual: true,
                        defaultPlayer: "Alle",
                        defaultNote: "Warnung!",
                        defaultTts: "achtung",
                        defaultName: "Warnung",
                        defaultIcon: "1",
                        spells: []
                    };
                } else {
                    categories[key] = {
                        name: name, shortName: name.substring(0, 10), color: '#8b5cf6',
                        spells: []
                    };
                }
                markCategoriesDirty();
                renderCategoriesAdmin();
            });
        }

        // Delete category
        document.querySelectorAll('.delete-cat-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                var cat = e.target.dataset.cat;
                if (!confirm('Kategorie "' + categories[cat].name + '" wirklich löschen?')) return;
                delete categories[cat];
                markCategoriesDirty();
                renderCategoriesAdmin();
            });
        });

        // Name/Shortname/Color änderungen
        document.querySelectorAll('.cat-name-input').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                categories[e.target.dataset.cat].name = e.target.value;
                markCategoriesDirty();
            });
        });
        document.querySelectorAll('.cat-short-input').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                categories[e.target.dataset.cat].shortName = e.target.value;
                markCategoriesDirty();
            });
        });
        document.querySelectorAll('.cat-color-input').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                categories[e.target.dataset.cat].color = e.target.value;
                markCategoriesDirty();
            });
        });

        // Virtuelle Felder
        document.querySelectorAll('.cat-virtual-input').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                categories[e.target.dataset.cat][e.target.dataset.field] = e.target.value;
                markCategoriesDirty();
            });
        });

        // Kategorie-Role
        document.querySelectorAll('.cat-role-select').forEach(function (sel) {
            sel.addEventListener('change', function (e) {
                var v = e.target.value;
                if (v) categories[e.target.dataset.cat].requiredRole = v;
                else delete categories[e.target.dataset.cat].requiredRole;
                markCategoriesDirty();
            });
        });

        // Spell-Role
        document.querySelectorAll('.spell-role-select').forEach(function (sel) {
            sel.addEventListener('change', function (e) {
                var cat = e.target.dataset.cat;
                var idx = parseInt(e.target.dataset.idx);
                var v = e.target.value;
                if (v) categories[cat].spells[idx].requiredRole = v;
                else delete categories[cat].spells[idx].requiredRole;
                markCategoriesDirty();
            });
        });

        // Spell-Spec (Button öffnet Popup mit Checkbox-Liste)
        document.querySelectorAll('.spell-spec-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                var cat = e.currentTarget.dataset.cat;
                var idx = parseInt(e.currentTarget.dataset.idx);
                openSpecPicker(cat, idx);
            });
        });

        // Spell entfernen
        document.querySelectorAll('.remove-spell-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                var cat = e.target.dataset.cat;
                var idx = parseInt(e.target.dataset.idx);
                categories[cat].spells.splice(idx, 1);
                markCategoriesDirty();
                renderCategoriesAdmin();
            });
        });

        // Spell hinzufügen
        document.querySelectorAll('.add-spell-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
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
        document.querySelectorAll('.spell-row').forEach(function (row) {
            row.addEventListener('dragstart', function (e) {
                dragged = e.currentTarget;
                e.currentTarget.style.opacity = '0.4';
                e.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragend', function (e) {
                e.currentTarget.style.opacity = '';
            });
            row.addEventListener('dragover', function (e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            row.addEventListener('drop', function (e) {
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
                markCategoriesDirty();
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
            var cd = cooldownsDB.find(function (c) { return String(c.spellId) === String(sp.spellId); });
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

        var checkboxesHtml = specs.map(function (spec) {
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
            + '<label class="flex items-center gap-2 p-2 hover:bg-slate-700/40 rounded cursor-pointer border-b border-slate-700">'
            + '<input type="checkbox" id="spec-pick-all" class="spec-pick-cb-all">'
            + '<span class="flex-1 text-xs italic text-gray-300">Alle Specs (kein Filter)</span>'
            + '</label>'
            + checkboxesHtml
            + '</div>'
            + '<div class="flex justify-end gap-2">'
            + '<button id="spec-pick-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            + '<button id="spec-pick-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // "Alle Specs" Checkbox-Logik
        var allCb = modal.querySelector('#spec-pick-all');
        var specCbs = modal.querySelectorAll('.spec-pick-cb');

        // Initialzustand: "Alle" wenn nichts selektiert
        allCb.checked = currentSpecs.length === 0;

        allCb.addEventListener('change', function () {
            if (allCb.checked) {
                specCbs.forEach(function (cb) { cb.checked = false; });
            }
        });

        specCbs.forEach(function (cb) {
            cb.addEventListener('change', function () {
                if (cb.checked) allCb.checked = false;
            });
        });

        // Save
        modal.querySelector('#spec-pick-save').addEventListener('click', function () {
            var selected = [];
            if (!allCb.checked) {
                specCbs.forEach(function (cb) {
                    if (cb.checked) selected.push(cb.value);
                });
            }
            if (selected.length === 0) {
                delete categories[catKey].spells[spellIdx].requiredSpec;
            } else {
                categories[catKey].spells[spellIdx].requiredSpec = selected;
            }
            document.body.removeChild(overlay);
            markCategoriesDirty();
            renderCategoriesAdmin();
        });

        // Cancel
        modal.querySelector('#spec-pick-cancel').addEventListener('click', function () {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function (e) {
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
        categories[catKey].spells.forEach(function (s) {
            var sid = String(s.spellId);
            existingCounts[sid] = (existingCounts[sid] || 0) + 1;
        });
        // Alle Spells aus der DB anzeigen - Duplikate explizit erlaubt für spec-spezifische Prio
        var availableCDs = cooldownsDB.filter(function (cd) {
            return cd.name && cd.spellId && cd.name.indexOf('---') !== 0 && cd.name.indexOf('-- ') !== 0;
        });

        // Gruppiere nach Klasse
        var byClass = {};
        availableCDs.forEach(function (cd) {
            var cls = cd.class || 'UNKNOWN';
            if (!byClass[cls]) byClass[cls] = [];
            byClass[cls].push(cd);
        });

        var classSections = Object.entries(byClass).sort().map(function (entry) {
            var cls = entry[0], cds = entry[1];
            var color = getClassColor(cls);
            var rows = cds.map(function (cd) {
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
        searchInp.addEventListener('input', function (e) {
            var q = e.target.value.toLowerCase();
            modal.querySelectorAll('.picker-row').forEach(function (row) {
                var txt = row.textContent.toLowerCase();
                row.style.display = txt.indexOf(q) !== -1 ? '' : 'none';
            });
        });
        searchInp.focus();

        // Pick
        modal.querySelectorAll('.picker-row').forEach(function (row) {
            row.addEventListener('click', function (e) {
                var spellId = row.dataset.spellid;
                var cd = cooldownsDB.find(function (c) { return String(c.spellId) === spellId; });
                categories[catKey].spells.push({
                    spellId: spellId,
                    cooldownSec: parseInt(cd && cd.cooldownSec) || 180,
                    durationSec: parseInt(cd && cd.durationSec) || 0
                });
                document.body.removeChild(overlay);
                markCategoriesDirty();
                renderCategoriesAdmin();
            });
        });

        // Cancel
        modal.querySelector('#picker-cancel').addEventListener('click', function () {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', function (e) {
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
            updateStatus("Matrix-Plan geleert (Zuweisungen entfernt, Events beibehalten).");
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
        Object.keys(categories).forEach(function (k) {
            categories[k].spells.forEach(function (s) { total++; if (resolveSpell(s.spellId)) found++; });
        });

        // ══════════════════════════════════════════════════════════
        // MANAGER-UI - Editoren nur für Gildenräte aufbauen.
        // Läuft der Login erst NACH dem Init durch, holt der Watcher weiter
        // unten das nach (früher blieben die Panels dann für immer weg).
        // ══════════════════════════════════════════════════════════
        // Alt-Buttons aus dem Boss-HTML sofort wegräumen - auch für Gäste, damit
        // nirgends ein toter „Kategorien speichern"-Button stehen bleibt.
        dropLegacySaveCategoriesButtons();

        var _managerUiBuilt = false;
        function buildManagerUI() {
            if (_managerUiBuilt || !window.isManager) return;
            _managerUiBuilt = true;

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

            injectResetEventsButton();
            injectImportButton();
            injectClearPlannerButton();
            injectWipeButton();
        }

        buildManagerUI();

        // ══════════════════════════════════════════════════════════
        // MANAGER-SCHUTZ - Nur Gildenräte können den Matrix-Plan ändern.
        // Gäste sehen den fertigen Plan trotzdem: Tabelle, Ein-/Ausklappen
        // und Tooltips funktionieren ganz normal, nur Bearbeiten ist gesperrt.
        // ══════════════════════════════════════════════════════════
        var MANAGER_ONLY_IDS = [
            'btn-auto-assign', 'btn-export-to-planner', 'btn-save-auto-plan',
            'btn-clear-auto', 'btn-save-categories', 'btn-clear-planner',
            'btn-reset-events', 'btn-wipe-db', 'planner-danger-zone', 'btn-import-from-planner',
            'cd-categories-admin', 'auto-planner-strategy'
        ];

        function showReadOnlyHint(show) {
            var timelineEl = document.getElementById('auto-planner-timeline');
            if (!timelineEl || !timelineEl.parentNode) return;
            var hint = document.getElementById('auto-planner-readonly-hint');
            if (!show) { if (hint) hint.style.display = 'none'; return; }
            if (!hint) {
                hint = document.createElement('div');
                hint.id = 'auto-planner-readonly-hint';
                hint.className = 'text-[11px] text-slate-400 bg-slate-900/40 border border-slate-700/60 rounded px-3 py-2 mb-3';
                hint.innerHTML = '👁️ <b class="text-slate-300">Nur-Lese-Ansicht.</b> '
                    + 'Du siehst die gespeicherte Einteilung. Event-Blöcke lassen sich über die Pfeile '
                    + 'in der Tabelle ein- und ausklappen; zum Bearbeiten als Gildenrat einloggen.';
                timelineEl.parentNode.insertBefore(hint, timelineEl);
            }
            hint.style.display = '';
        }

        function applyManagerProtection() {
            var isManager = !!window.isManager;
            var timelineEl = document.getElementById('auto-planner-timeline');
            if (!timelineEl) return;
            var container = timelineEl.parentNode;

            // Alt-Bestand aufräumen: die frühere „UNDER CONSTRUCTION"-Tafel und das
            // pauschale Ausblenden aller Geschwister-Elemente gibt es nicht mehr.
            var ucBanner = document.getElementById('auto-planner-under-construction');
            if (ucBanner && ucBanner.parentNode) ucBanner.parentNode.removeChild(ucBanner);
            Array.from(container.children).forEach(function (child) {
                if (child.dataset.originalDisplay !== undefined) {
                    child.style.display = child.dataset.originalDisplay;
                    delete child.dataset.originalDisplay;
                }
            });

            MANAGER_ONLY_IDS.forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.style.display = isManager ? '' : 'none';
            });

            var evtPanel = document.getElementById('auto-planner-events');
            if (evtPanel) {
                var evtWrap = evtPanel.closest('details') || evtPanel;
                evtWrap.style.display = isManager ? '' : 'none';
            }

            // Tabelle nur lesbar schalten: Dropdowns und Delay-Felder sperren,
            // Inhalt (Spieler + CD) bleibt sichtbar.
            timelineEl.querySelectorAll('select.auto-plan-select').forEach(function (sel) {
                sel.disabled = !isManager;
                sel.style.pointerEvents = isManager ? '' : 'none';
            });
            timelineEl.querySelectorAll('input.auto-plan-delay').forEach(function (inp) {
                inp.disabled = !isManager;
                inp.style.opacity = isManager ? '' : '0.45';
            });

            showReadOnlyHint(!isManager);
        }

        // Initial anwenden
        applyManagerProtection();

        // Bei Re-Renders (z.B. nach Auto-Assign) erneut anwenden
        window._autoPlannerApplyProtection = applyManagerProtection;

        // Polling: bei isManager-Status-Wechsel (Login/Logout) erneut anwenden
        var lastManagerState = !!window.isManager;
        var managerWatcher = setInterval(function () {
            var current = !!window.isManager;
            if (current !== lastManagerState) {
                lastManagerState = current;
                buildManagerUI();
                // Neu zeichnen: die Delay-Spalte gibt es nur für Gildenräte.
                if (assignments && assignments.length) renderTimeline(assignments);
                applyManagerProtection();
            }
        }, 1500);
        // Stop bei Page-Unload (verhindert Memory Leaks)
        window.addEventListener('beforeunload', function () { clearInterval(managerWatcher); });

        document.getElementById('btn-auto-assign').addEventListener('click', function () {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            runAutoAssign();
        });
        document.getElementById('btn-export-to-planner').addEventListener('click', function () {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            exportToPlanner();
        });
        document.getElementById('btn-save-auto-plan').addEventListener('click', function () {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            savePlan();
        });
        // „Kategorien speichern" wird vom Kategorie-Editor selbst gerendert und
        // verdrahtet (siehe renderCategoriesAdmin/attachEditorListeners).
        document.getElementById('btn-clear-auto').addEventListener('click', handleClearAutoPlan);

        // Manager-Buttons (Reset/Clear/Wipe) hängen an buildManagerUI() - sie
        // werden auch dann noch nachgezogen, wenn der Login später durchläuft.
        applyManagerProtection();

        // Wenn ein gespeicherter Plan existiert, geladene Assignments direkt anzeigen
        if (hasSavedPlan) {
            if (assignments && assignments.length > 0) {
                renderTimeline(assignments);
            }
            updateStatus(window.isManager
                ? 'Gespeicherter Plan geladen. Klicke auf "Auto-Zuweisen", um bei Roster-Änderungen neu zu berechnen.'
                : 'Gespeicherte CD-Einteilung - Nur-Lese-Ansicht.');
        } else if (!window.isManager) {
            updateStatus('Für diesen Boss ist noch keine CD-Einteilung gespeichert.');
        } else {
            updateStatus('Bereit. ' + found + '/' + total + ' Spells in DB. Roster: ' + rosterRef.length + ' Spieler.');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // STRATEGIE-PANEL - UI für die 3 Verteilungs-Toggles
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
            '<div class="font-semibold text-gray-200">A - Spread (Lookahead)</div>' +
            '<div class="text-[10px] text-gray-400">Bei Knappheit Casts gleichmäßig über die Zeit verteilen statt am Anfang ballen. Lücken werden als "geplante Lücken" markiert.</div>' +
            '</div>' +
            '</label>' +
            '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
            '<input type="checkbox" id="strat-prio" class="mt-1 accent-cyan-500" ' + (s.prioritizeCategories ? 'checked' : '') + '>' +
            '<div>' +
            '<div class="font-semibold text-gray-200">B - Kategorien-Priorisierung</div>' +
            '<div class="text-[10px] text-gray-400">Legt fest, <b>welche Kategorie zuerst einen Spieler bekommt</b>, wenn mehrere Kategorien im selben Event dieselben Spieler brauchen. Reihenfolge = wie die Kategorien am Event hinterlegt sind (die erste zuerst). Beispiel: Ein Paladin könnte „Aura“ oder „Handauflegung“ geben - mit B bekommt die zuerst gelistete Kategorie ihn, die andere bleibt in diesem Cast leer. <b>Ohne</b> B entscheidet die globale Kategorie-Reihenfolge. Wirkt nur bei Spieler-Knappheit.</div>' +
            '</div>' +
            '</label>' +
            '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
            '<input type="checkbox" id="strat-rr" class="mt-1 accent-cyan-500" ' + (s.roundRobin ? 'checked' : '') + '>' +
            '<div>' +
            '<div class="font-semibold text-gray-200">C - Round-Robin</div>' +
            '<div class="text-[10px] text-gray-400">Spieler reihum nutzen statt immer den ersten. Bringt Fairness, hilft bei Lücken nur wenn Spieler-CD &lt; Event-Abstand ist.</div>' +
            '</div>' +
            '</label>' +
            '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
            '<input type="checkbox" id="strat-prefer-heal" class="mt-1 accent-cyan-500" ' + (s.preferHeal ? 'checked' : '') + '>' +
            '<div>' +
            '<div class="font-semibold text-gray-200">D - Bevorzuge Heiler</div>' +
            '<div class="text-[10px] text-gray-400">Zieht reine Heiler-Klassen für defensiven CDs heran, bevor Utility-Heals (z.B. Vampirumarmung) der DDs genutzt werden.</div>' +
            '</div>' +
            '</label>' +
            '<label class="flex items-start gap-2 cursor-pointer hover:bg-slate-700/30 p-2 rounded">' +
            '<input type="checkbox" id="strat-strict-class" class="mt-1 accent-cyan-500" ' + (s.strictClassBalance ? 'checked' : '') + '>' +
            '<div>' +
            '<div class="font-semibold text-gray-200">E - Strikte Klassen-Rotation</div>' +
            '<div class="text-[10px] text-gray-400">Verhindert, dass eine Klasse mehrfach hintereinander ihre Cooldowns ziehen muss, selbst wenn sie verfügbar wäre.</div>' +
            '</div>' +
            '</label>' +
            '<div class="text-[10px] text-gray-500 italic pt-1 border-t border-slate-700">Änderungen werden mit dem nächsten "Auto-Assign" wirksam und beim Speichern persistiert.</div>' +
            '</div>';

        wrapper.parentNode.insertBefore(panel, wrapper);

        function bind(id, key) {
            var el = panel.querySelector('#' + id);
            if (!el) return;
            el.addEventListener('change', function () {
                assignStrategy[key] = !!el.checked;
                markDirty();
                runAutoAssign();
            });
        }
        bind('strat-spread', 'spread');
        bind('strat-prio', 'prioritizeCategories');
        bind('strat-rr', 'roundRobin');
        bind('strat-prefer-heal', 'preferHeal');
        bind('strat-strict-class', 'strictClassBalance');
    }

    // Klick-Handler für "Matrix-Plan leeren". Als benannte Funktion, damit die
    // Danger-Zone den Button bei Bedarf neu aufbauen und wieder verdrahten kann.
    function handleClearAutoPlan() {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
        var msg = "Matrix-Plan Zuweisungen leeren?\n\nLöscht alle Zuweisungen im Matrix-Plan, behält aber die Event-Anpassungen (Häkchen) bei.\nDie CD-Planer-Einträge im Raidplan bleiben unangetastet.";
        if (typeof window.showModal === 'function') {
            var r = window.showModal(msg, true);
            if (r && typeof r.then === 'function') { r.then(function (ok) { if (ok) clearPlan(); }); }
            else clearPlan();
        } else { if (confirm(msg)) clearPlan(); }
    }

    // ── Dynamischer Events-Reset-Button ──
    function injectResetEventsButton() {
        if (!window.isManager) return;
        if (document.getElementById('btn-reset-events')) return;

        var eventsArea = document.getElementById('auto-planner-events');
        if (!eventsArea) return;

        var dangerZone = document.getElementById('planner-danger-zone');
        if (!dangerZone) {
            dangerZone = document.createElement('div');
            dangerZone.id = 'planner-danger-zone';
            dangerZone.className = "mx-3 mb-3 pt-4 border-t border-slate-700 flex flex-wrap items-center gap-2";

            var title = document.createElement('div');
            title.className = 'w-full text-xs font-bold text-slate-300 mb-1 uppercase tracking-wide';
            title.innerHTML = '⚙️ Daten verwalten & Zurücksetzen';
            dangerZone.appendChild(title);

            var clearAutoBtn = document.getElementById('btn-clear-auto');
            if (!clearAutoBtn) {
                clearAutoBtn = document.createElement('button');
                clearAutoBtn.id = 'btn-clear-auto';
                clearAutoBtn.addEventListener('click', handleClearAutoPlan);
            }
            clearAutoBtn.className = 'bg-red-800 hover:bg-red-900 text-white font-bold py-1.5 px-3 rounded text-xs border border-red-600';
            clearAutoBtn.innerHTML = '🗑️ Matrix-Plan leeren';
            dangerZone.appendChild(clearAutoBtn);

            // WICHTIG: NEBEN #auto-planner-events einhängen, nicht hinein.
            // renderEventManager() setzt bei jeder Event-Änderung das innerHTML
            // dieses Containers neu - lag die Danger-Zone darin, verschwand sie
            // (inklusive des hierher verschobenen "Matrix-Plan leeren"-Buttons)
            // und kam erst nach einem Reload zurück.
            (eventsArea.parentNode || eventsArea).appendChild(dangerZone);
        }

        var resetBtn = document.createElement('button');
        resetBtn.id = 'btn-reset-events';
        resetBtn.className = 'bg-orange-700 hover:bg-orange-800 text-white font-bold py-1.5 px-3 rounded text-xs border border-orange-500 mr-2';
        resetBtn.innerHTML = '🔄 Events Reset';
        resetBtn.title = 'Setzt alle Event-Anpassungen (Häkchen und eigene Events) auf Standard zurück';

        dangerZone.appendChild(resetBtn);

        resetBtn.addEventListener('click', function () {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            var msg = "Events zurücksetzen?\n\nSetzt alle Häkchen und manuell hinzugefügten Events auf die Standardwerte des Bosses zurück.\nBereits zugewiesene CDs bleiben in der Tabelle stehen (Auto-Assign erforderlich, um sie neu zu verteilen).";
            if (typeof window.showModal === 'function') {
                var r = window.showModal(msg, true);
                if (r && typeof r.then === 'function') {
                    r.then(function (ok) { if (ok) resetEventsOnly(); });
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

    // ── Dynamischer Import-Button (CD-Planer → Matrix) ──
    // Sitzt direkt neben dem Export, damit beide Richtungen beieinander liegen.
    function injectImportButton() {
        if (!window.isManager) return;
        if (document.getElementById('btn-import-from-planner')) return;

        var exportBtn = document.getElementById('btn-export-to-planner');
        if (!exportBtn || !exportBtn.parentNode) return;

        var importBtn = document.createElement('button');
        importBtn.id = 'btn-import-from-planner';
        importBtn.className = 'bg-amber-600 hover:bg-amber-700 text-white font-bold py-1.5 px-3 rounded text-xs border border-amber-400';
        importBtn.innerHTML = '⬆️ Aus CD-Planer importieren';
        importBtn.title = 'Übernimmt die Zeilen des Advanced CD Planners als manuelle CDs in die Matrix. '
            + 'Zugeordnet wird über Auslöser + # - also genau umgekehrt zum Export.';

        exportBtn.parentNode.insertBefore(importBtn, exportBtn.nextSibling);

        importBtn.addEventListener('click', function () {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            importFromPlanner();
        });
    }

    // ── Dynamischer Clear-Button für Advanced CD-Plan ──
    function injectClearPlannerButton() {
        if (!window.isManager) return;
        if (document.getElementById('btn-clear-planner')) return;  // Schon da

        var exportBtn = document.getElementById('btn-export-to-planner');
        if (!exportBtn || !exportBtn.parentNode) return;

        var clearBtn = document.createElement('button');
        clearBtn.id = 'btn-clear-planner';
        clearBtn.className = 'bg-slate-700 hover:bg-slate-800 text-white font-bold py-1.5 px-3 rounded text-xs border border-slate-500';
        clearBtn.innerHTML = '🧹 Advanced CD-Plan leeren';
        clearBtn.title = 'Leert ALLE 200 Zeilen des Advanced CD-Plans dieses Bosses (Matrix-Plan bleibt unangetastet)';

        exportBtn.parentNode.insertBefore(clearBtn, exportBtn.nextSibling);
        clearBtn.style.marginLeft = '0.5rem';

        clearBtn.addEventListener('click', function () {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            var msg = "Advanced CD-Plan leeren?\n\nLöscht ALLE 200 Zeilen des CD-Planers dieses Bosses (Trigger, Spieler, Cooldowns, Zeiten, Texte).\nDer Matrix-Plan bleibt unangetastet.\n\nFortfahren?";
            if (typeof window.showModal === 'function') {
                var r = window.showModal(msg, true);
                if (r && typeof r.then === 'function') {
                    r.then(function (ok) { if (ok) clearPlannerOnly(); });
                } else {
                    clearPlannerOnly();
                }
            } else {
                if (confirm(msg)) clearPlannerOnly();
            }
        });
    }

    // ── Leert ALLE 200 Zeilen des Advanced CD-Plans (DOM + Firestore) ──
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
        var fields = ['trigger', 'npc', 'condition', 'time', 'player', 'cooldown', 'note', 'tts', 'varname', 'icon'];

        try {
            // DOM leeren + Batch füllen
            for (var i = 1; i <= 200; i++) {
                var rowPrefix = prefix + '-planner-row' + i;
                fields.forEach(function (f) {
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
                    // Korrektes DB-Feld ermitteln, genau wie in planner-bosses.js handleAssignmentChange
                    var dbField = 'player';
                    if (el && el.tagName === 'INPUT') {
                        dbField = 'text';
                    } else if (!el) {
                        // Fallback falls Element nicht im DOM, aber wir es leeren wollen
                        if (['npc', 'condition', 'time', 'note', 'tts', 'varname', 'icon'].includes(f)) {
                            dbField = 'text';
                        } else if (f === 'cooldown') {
                            dbField = 'cooldown';
                        } else {
                            dbField = 'player'; // trigger, player
                        }
                    } else if (f === 'cooldown') {
                        dbField = 'cooldown';
                    }

                    var update = { editor: currentManager, timestamp: serverTs };
                    // Alle potenziellen Keys explizit leeren, um Rückstände zu vermeiden
                    update['player'] = '';
                    update['text'] = '';
                    update['cooldown'] = '';

                    batchPayload[fieldId] = update;
                });
            }

            // Firestore-Write in Chunks (Firestore Limit: 500 Field-Transforms)
            if (firebaseRef && firebaseRef.setDoc && Object.keys(batchPayload).length > 0) {
                var bossDocId = "boss-" + (config.id || prefix.toLowerCase());
                try {
                    var payloadKeys = Object.keys(batchPayload);
                    for (var c = 0; c < payloadKeys.length; c += 400) {
                        var chunk = {};
                        for (var j = 0; j < 400 && c + j < payloadKeys.length; j++) {
                            var key = payloadKeys[c + j];
                            chunk[key] = batchPayload[key];
                        }
                        await firebaseRef.setDoc(
                            firebaseRef.doc(firebaseRef.db, "raid-tool-data", bossDocId),
                            chunk,
                            { merge: true }
                        );
                    }
                } catch (e) {
                    console.error("[Auto-Planner] clearPlannerOnly DB-Error:", e);
                    if (window.showModal) window.showModal("CD-Plan lokal geleert, DB-Fehler: " + e.message);
                    return;
                }
            }

            // Logbuch
            if (typeof window.logHistory === 'function') {
                window.logHistory('Matrix Planer', 'Advanced CD-Plan geleert für Boss "' + config.name + '"',
                    '200 Zeilen', currentManager);
            }

            updateStatus("Advanced CD-Plan geleert (200 Zeilen, lokal + DB).");
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

        var dangerZone = document.getElementById('planner-danger-zone');
        if (!dangerZone) return;

        var wipeBtn = document.createElement('button');
        wipeBtn.id = 'btn-wipe-db';
        wipeBtn.className = 'bg-red-900 hover:bg-red-950 text-white font-bold py-1.5 px-3 rounded text-xs border border-red-700';
        wipeBtn.innerHTML = '☢️ DB-Einträge löschen';
        wipeBtn.title = 'Löscht ALLE Datenbank-Einträge für diesen Boss (CD-Planer + Matrix Planer)';
        dangerZone.appendChild(wipeBtn);

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
                "• Den CD-Planer (alle 200 Zeilen)\n" +
                "• Den Matrix Planer (gespeicherter Plan + Overrides + Custom-Events)\n" +
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
            window.logHistory('Matrix Planer', 'DB-Wipe für Boss "' + config.name + '"',
                deleted.join(", ") || "(nichts gelöscht)", mgr);
        }

        // Lokalen State leeren
        clearPlan();

        // Auch CD-Planer-Felder im DOM leeren wenn vorhanden
        var plannerContainer = document.querySelector('[id$="-planner-container"]');
        if (plannerContainer) {
            plannerContainer.querySelectorAll('select, input').forEach(function (el) {
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
        setTimeout(function () {
            if (confirm("Empfehlung: Seite neu laden für sauberen Zustand. Jetzt reloaden?")) {
                location.reload();
            }
        }, 500);
    }

    return {
        init: function (bossConfig) {
            var w = setInterval(function () {
                if (window.rosterData && window.firebaseTools && window.allCooldowns && window.allCooldowns.length) {
                    clearInterval(w);
                    doInit(bossConfig);
                }
            }, 500);
            setTimeout(function () { clearInterval(w); }, 15000);
        },

        // Diagnose-Helper: in der Browser-Konsole `CD_AUTO_PLANNER.debugRoster()` aufrufen,
        // um zu sehen, welche class/spec/roles-Werte die Spieler tatsächlich haben.
        // Zeigt auch, wie normalizeSpec sie interpretiert.
        debugRoster: function (filterClass) {
            var roster = window.effectiveRoster || window.rosterData || [];
            var rows = roster
                .filter(function (p) { return !filterClass || (p.class || '').toUpperCase() === filterClass.toUpperCase(); })
                .map(function (p) {
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
        debugMatch: function (cls, spec) {
            var players = getPlayersOfClass(cls, null, spec ? [spec] : null);
            console.log('Treffer für', cls, spec || '(alle)', '→', players);

            // Detail-Analyse: warum matcht/matcht nicht jeder Spieler der Klasse?
            var roster = window.effectiveRoster || window.rosterData || [];
            var detail = roster
                .filter(function (p) { return (p.class || '').toUpperCase() === (cls || '').toUpperCase(); })
                .map(function (p) {
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
