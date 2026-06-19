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
        // MANA (NEU — für Hymn of Hope / Mana Tide)
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
        // TANK EXTERNAL (NEU — Einzel-Target Tank-CDs)
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
        // P2 TANK-SOAK (NUR PHYSISCH) — Malkorók Blutrausch
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
            var disabled = ov.disabled !== undefined ? ov.disabled : isMythic;
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
                    var matchRange = event.escalationRanges.find(function(r) { return evaluateCastNum >= r.start && evaluateCastNum <= r.end; });
                    if (matchRange) {
                        effectiveReqCDs = matchRange.categories || [];
                    } else {
                        effectiveReqCDs = [];
                    }
                }

                timeline.push({
                    eventIdx: eventIdx,
                    eventKey: event._key,
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
        timeline.forEach(function(row) {
            nameCounters[row.eventName] = (nameCounters[row.eventName] || 0) + 1;
            row.castNum = nameCounters[row.eventName];
        });

        return timeline;
    }

    function getUniqueCategoryKeys() {
        var keys = [];
        var effectiveEvents = getEffectiveEvents();
        effectiveEvents.forEach(function (e) {
            (e.requiredCDs || []).forEach(function (k) {
                if (keys.indexOf(k) === -1) keys.push(k);
            });
            (e.escalationRanges || []).forEach(function(r) {
                (r.categories || []).forEach(function (k) {
                    if (keys.indexOf(k) === -1) keys.push(k);
                });
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

        var allCatKeys = getUniqueCategoryKeys();
        var manualReservations = {};
        timeline.forEach(function (row) {
            allCatKeys.forEach(function(catKey) {
                var oKey = row.eventIdx + '-' + row.castNum + '-' + catKey;
                var ov = manualOverrides[oKey];
                if (ov && ov.player && ov.dbName && !ov.skip && !ov.isVirtualCategoryKey) {
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
            var groups = {};
            timeline.forEach(function (row) {
                allCatKeys.forEach(function (catKey) {
                    var isReq = (row.requiredCDs || []).indexOf(catKey) !== -1;
                    if (!isReq) return;
                    var key = row.eventIdx + '||' + catKey;
                    if (!groups[key]) groups[key] = [];
                    groups[key].push(row);
                });
            });

            Object.keys(groups).forEach(function (gKey) {
                var rows = groups[gKey];
                if (rows.length <= 1) {
                    rows.forEach(function (r) {
                        spreadAllow[r.eventIdx + '-' + r.castNum + '-' + r._catKey] = true;
                    });
                    return;
                }
                var parts = gKey.split('||');
                var catKey = parts[1];
                var spells = getResolvedCategory(catKey);

                // Capacity = wieviele verschiedene Player+Spell Kombinationen verfügbar?
                var totalPlayers = 0;
                spells.forEach(function (spell) {
                    totalPlayers += getPlayersOfClass(spell.dbClass, spell.requiredRole, spell.requiredSpec).length;
                });
                if (totalPlayers === 0) return;

                // Wie oft kann jeder Spieler im Event-Span casten?
                var minCd = spells.length ? Math.min.apply(null, spells.map(function (s) { return s.cooldownSec || 180; })) : 180;
                var firstT = rows[0].absTime;
                var lastT = rows[rows.length - 1].absTime;
                var span = lastT - firstT;
                var castsPerPlayer = 1 + Math.floor(span / minCd);
                var capacity = Math.max(1, totalPlayers * castsPerPlayer);

                if (capacity >= rows.length) {
                    // Alles abgedeckt → jeder Cast erlaubt
                    rows.forEach(function (r) {
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
                    rows.forEach(function (r, ri) {
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
                await new Promise(function(r) { setTimeout(r, 0); });
            }

            // Alle Kategorien initial mit leeren Slots vorbelegen,
            // damit die UI-Spalten stimmen.
            allCatKeys.forEach(function (catKey) {
                if (!row.slots[catKey]) row.slots[catKey] = {};
            });

            // Reihenfolge: bei prioritizeCategories die Boss-Reihenfolge
            // aus requiredCDs verwenden, sonst die globale Liste.
            var iterCats = assignStrategy.prioritizeCategories
                ? (row.requiredCDs || []).slice()
                : allCatKeys;

            iterCats.forEach(function (catKey) {
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

                    if (ov.isVirtualCategoryKey) {
                        var vCat = categories[ov.isVirtualCategoryKey];
                        if (vCat) {
                            row.slots[catKey] = {
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
                            return;
                        }
                    }

                    row.slots[catKey] = JSON.parse(JSON.stringify(ov));
                    row.slots[catKey].auto = false;
                    if (ov.player && ov.dbName) {
                        markUsed(ov.player, ov.dbName, ov.cooldownSec || 180, row.absTime);
                    }
                    return;
                }

                if (!isRequired) return;

                var catConfig = categories[catKey];
                if (catConfig && catConfig.isVirtual) {
                    row.slots[catKey] = {
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

                // Continuous Coverage Logic
                if (assigned && row.continuousCoverage && row.eventDuration > 0 && row.slots[catKey].durationSec) {
                    var dur = row.slots[catKey].durationSec;
                    var remaining = row.eventDuration - dur;
                    if (remaining > 0) {
                        var nextAbsTime = row.absTime + dur + (row.overlapSec || 0);
                        var nextDelay = row.delay + dur + (row.overlapSec || 0);

                        // Push a new timeline event specifically for this category
                        timeline.push({
                            eventIdx: row.eventIdx,
                            eventKey: row.eventKey,
                            castNum: row.castNum, // keep same castNum or mark as subcast? Keep same so manual overrides can't easily target it without care, but we just want auto filler.
                            absTime: nextAbsTime,
                            delay: nextDelay,
                            eventName: row.eventName + ' (Forts. ' + catKey + ')',
                            eventDuration: remaining,
                            continuousCoverage: true,
                            overlapSec: row.overlapSec || 0,
                            icon: row.icon || '',
                            requiredCDs: [catKey], // ONLY this category needs coverage now
                            slots: {},
                            _sourceTriggerMap: row._sourceTriggerMap,
                            _isContinuous: true,
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

    function renderTimeline(timeline) {
        var thead = document.getElementById('auto-planner-thead');
        var tbody = document.getElementById('auto-planner-tbody');
        if (!thead || !tbody) return;
        var catKeys = getUniqueCategoryKeys();

        // Thead
        var thCols = catKeys.map(function (k) {
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
        var cachedOptions = {};
        catKeys.forEach(function (catKey) {
            cachedOptions[catKey] = buildDropdownOptions(catKey);
        });

        var rows = timeline.map(function (row, rowIdx) {
            var isNew = row.eventName !== lastEvt;
            lastEvt = row.eventName;

            var cells = catKeys.map(function (catKey) {
                var slot = row.slots[catKey];
                var isReq = row.requiredCDs.indexOf(catKey) !== -1;
                var options = cachedOptions[catKey];

                // Skipped
                if (slot && slot.skipped) {
                    return '<td class="py-1 px-1 bg-slate-900/40 border border-red-900/20">'
                        + '<select class="auto-plan-select w-full bg-transparent text-[11px] border-none outline-none cursor-pointer" data-row="' + rowIdx + '" data-cat="' + catKey + '" style="color:#ef4444;">'
                        + '<option value="">-- Cooldown --</option>'
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
                    + '<option value="">-- Cooldown --</option>'
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
        timeline.forEach(function (row, rowIdx) {
            catKeys.forEach(function (catKey) {
                var slot = row.slots[catKey];
                if (!slot || !slot.player || (!slot.dbName && !slot.isVirtual)) return;
                var sel = tbody.querySelector('select[data-row="' + rowIdx + '"][data-cat="' + catKey + '"]');
                if (!sel) return;

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
                    var displayCatName = slot.isVirtual ? (categories[slot.isVirtualCategoryKey || catKey].name) : slot.dbName;
                    var opt = new Option(slot.player + ' → ' + displayCatName, val);
                    opt.style.color = getClassColor(slot.dbClass || 'General');
                    sel.appendChild(opt);
                }
                sel.value = val;
                sel.style.color = getClassColor(slot.dbClass || 'General');
            });
        });

        // Listeners: Dropdown
        tbody.querySelectorAll('.auto-plan-select').forEach(function (sel) {
            sel.addEventListener('change', function (e) {
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

                    if (dbName === '__VIRTUAL__') {
                        var virtKey = parts[2];
                        manualOverrides[oKey] = {
                            player: player, dbName: '__VIRTUAL__',
                            isVirtualCategoryKey: virtKey
                        };
                    } else {
                        var dbEntry = cooldownsDB.find(function (cd) { return cd.name === dbName; });
                        var catSpell = resolveCategory(ck).find(function (s) { return s.dbName === dbName; });
                        manualOverrides[oKey] = {
                            player: player, dbName: dbName,
                            dbClass: dbEntry ? dbEntry.class : 'UNKNOWN',
                            spellId: dbEntry ? dbEntry.spellId : '',
                            cooldownSec: (catSpell && catSpell.cooldownSec) || parseInt(dbEntry && dbEntry.cooldownSec) || 180,
                            durationSec: (catSpell && catSpell.durationSec) || parseInt(dbEntry && dbEntry.durationSec) || 0
                        };
                    }
                }
                runAutoAssign();
            });
        });

        // Listeners: Delay
        tbody.querySelectorAll('.auto-plan-delay').forEach(function (inp) {
            inp.addEventListener('change', function (e) {
                var ri = parseInt(e.target.dataset.row);
                if (assignments[ri]) assignments[ri].delay = parseInt(e.target.value) || 0;
            });
        });

        var missing = timeline.filter(function (r) {
            return Object.values(r.slots).some(function (s) { return s.unavailable; });
        }).length;
        updateStatus(timeline.length + ' Events, ' + missing + ' ohne CD');
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
                recommended.forEach(function (s) {
                    if (!byClassR[s.dbClass]) byClassR[s.dbClass] = [];
                    if (!byClassR[s.dbClass].some(function (x) { return x.dbName === s.dbName; })) byClassR[s.dbClass].push(s);
                });
                Object.entries(byClassR).forEach(function (entry) {
                    var cls = entry[0], spells = entry[1];
                    var color = getClassColor(cls);
                    var anyRendered = false;
                    spells.forEach(function (s) {
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
                            var labels = specs.map(function (v) { return getSpecLabel(v).replace(/\s*\([^)]+\)/, ''); });
                            specMark = ' [' + labels.join('/') + ']';
                        } else if (s.requiredRole) {
                            specMark = ' (' + s.requiredRole + ')';
                        }
                        players.forEach(function (p) {
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
        (config.events || []).forEach(function (evt, idx) {
            var key = 'cfg_' + idx;
            var ov = eventOverrides[key] || {};
            var isMythic = evt.name && (evt.name.indexOf('(HC)') !== -1 || evt.name.indexOf('(Mythisch)') !== -1 || evt.name.indexOf('(Mythic)') !== -1 || evt.name.indexOf('(M)') !== -1);
            var disabled = ov.disabled !== undefined ? ov.disabled : isMythic;
            allRows.push({
                _key: key, _isCustom: false,
                disabled: !!disabled,
                name: ov.name !== undefined ? ov.name : evt.name,
                firstCast: ov.firstCast !== undefined ? ov.firstCast : evt.firstCast,
                cooldown: ov.cooldown !== undefined ? ov.cooldown : (evt.cooldown || 0),
                maxCasts: ov.maxCasts !== undefined ? ov.maxCasts : (evt.maxCasts || 1),
                requiredCDs: ov.requiredCDs !== undefined ? ov.requiredCDs : (evt.requiredCDs || []),
                icon: ov.icon !== undefined ? ov.icon : (evt.icon || ''),
                triggerOverride: ov.triggerOverride
            });
        });
        customEvents.forEach(function (evt) {
            var ov = eventOverrides[evt._key] || {};
            allRows.push({
                _key: evt._key, _isCustom: true,
                disabled: !!ov.disabled,
                name: evt.name, firstCast: evt.firstCast, cooldown: evt.cooldown || 0,
                maxCasts: evt.maxCasts || 1, requiredCDs: evt.requiredCDs || [], icon: evt.icon || '',
                triggerOverride: ov.triggerOverride
            });
        });

        var header = '<div class="evt-row evt-header"><span></span><span>Ikon</span><span>Zeit</span><span>Name</span><span title="Cooldown zwischen Casts">CD</span><span title="Anzahl Casts">Casts</span><span title="Verzögerung">Delay</span><span>Kategorien</span><span title="Trigger-Modus für Export">Trigger</span><span></span></div>';

        var html = allRows.map(function (r) {
            var catLabels = (r.requiredCDs || []).map(function (k) {
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
                + '<input type="number" class="evt-delay" data-key="' + r._key + '" value="' + ((eventOverrides[r._key] && eventOverrides[r._key].delay !== undefined) ? eventOverrides[r._key].delay : (r._isCustom ? (customEvents.find(function (c) { return c._key === r._key; }) || {}).delay || 0 : ((config.events[parseInt(r._key.replace("cfg_", ""))] || {}).delay || 0))) + '" step="1" title="Verzögerung (neg=vorher)">'
                + (function () {
                    var soakActive = (r.requiredCDs || []).indexOf('tank_soak_phys') !== -1;
                    return '<div style="display:flex;gap:4px;min-width:0;">'
                        + '<button class="evt-cat-btn" data-key="' + r._key + '" title="Klicken um Kategorien zu ändern" style="flex:1;min-width:0;">' + catLabels + ' ' + customBadge + '</button>'
                        + (soakActive ? '<button class="evt-soak-btn" data-key="' + r._key + '" title="Soak-Einstellungen" style="flex:0 0 auto;background:#0f172a;border:1px solid #c8aa6e;color:#c8aa6e;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;">🛡</button>' : '')
                        + '<button class="evt-settings-btn" data-key="' + r._key + '" title="Event-Dauer & Eskalations-Phasen" style="flex:0 0 auto;background:#0f172a;border:1px solid #64748b;color:#94a3b8;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;">⚙️</button>'
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
    }

    function attachEventManagerListeners() {
        // Aktiv-Toggle
        document.querySelectorAll('.evt-enabled').forEach(function (cb) {
            cb.addEventListener('change', function (e) {
                var key = e.target.dataset.key;
                if (!eventOverrides[key]) eventOverrides[key] = {};
                eventOverrides[key].disabled = !e.target.checked;
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
        
        if (!silent) {
            // Event-Änderungen NICHT mehr sofort in die Vorschau verteilen — erst auf
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
                + '<option value="">— Aus triggerMap (Default) —</option>'
                + triggerOptions.map(function (t) {
                    return '<option value="' + t.val + '"' + (currentTrigger === t.val ? ' selected' : '') + ' title="' + t.val + '">' + t.text + '</option>';
                }).join('')
                + '</select>';
        }

        // NPC-Dropdown (nur wenn HEALTH-Trigger)
        var npcDropdown = '';
        if (npcOptions.length) {
            npcDropdown = '<select id="trg-pick-npc" class="w-full bg-slate-900 text-white p-2 rounded border border-slate-600 text-sm">'
                + '<option value="">— NPC wählen —</option>'
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

    function openEventSettingsPicker(eventKey) {
        var evtObj = null;
        if (eventKey.startsWith('cfg_')) {
            evtObj = config.events[parseInt(eventKey.replace('cfg_', ''))] || {};
        } else {
            evtObj = customEvents.find(function(e) { return e._key === eventKey; }) || {};
        }
        var ov = eventOverrides[eventKey] || {};

        var evtDur = ov.eventDuration !== undefined ? ov.eventDuration : (evtObj.eventDuration || 0);
        var overlap = ov.overlapSec !== undefined ? ov.overlapSec : (evtObj.overlapSec || 0);
        var resEsc = ov.resetEscalation !== undefined ? ov.resetEscalation : (evtObj.resetEscalation || 0);
        var contCov = ov.continuousCoverage !== undefined ? ov.continuousCoverage : (evtObj.continuousCoverage || false);
        
        var rawRanges = ov.escalationRanges !== undefined ? ov.escalationRanges : (evtObj.escalationRanges || []);
        var escRanges = JSON.parse(JSON.stringify(rawRanges));

        var html = '<div class="mb-4 space-y-3">'
            + '<div class="flex gap-4">'
            +   '<div class="flex-1"><label class="block text-[10px] text-gray-400 mb-1">Event-Dauer (Sek)</label><input type="number" id="es-dur" class="w-full bg-slate-900 border border-slate-700 text-white text-xs px-2 py-1 rounded" value="' + evtDur + '" step="0.5"></div>'
            +   '<div class="flex-1"><label class="block text-[10px] text-gray-400 mb-1" title="Wie viel Sek. vor Ablauf des vorherigen CD soll der nächste gezogen werden?">Overlap (Sek)</label><input type="number" id="es-overlap" class="w-full bg-slate-900 border border-slate-700 text-white text-xs px-2 py-1 rounded" value="' + overlap + '" step="0.5"></div>'
            + '</div>'
            + '<div><label class="block text-[10px] text-gray-400 mb-1" title="Nach wie vielen Casts fängt die Eskalation wieder bei 1 an? (0 = Nie)">Reset Eskalation nach Cast-Count (z.B. nach dem 3. Cast wieder bei 1 anfangen)</label><input type="number" id="es-res" class="w-full bg-slate-900 border border-slate-700 text-white text-xs px-2 py-1 rounded" value="' + resEsc + '"></div>'
            + '<div class="flex items-center gap-2 mt-2"><input type="checkbox" id="es-cont-cov" ' + (contCov ? 'checked' : '') + ' style="accent-color:#10b981;"><label for="es-cont-cov" class="text-[10px] text-gray-400 cursor-pointer">Continuous Coverage (Folge-CDs automatisch anreihen, falls Event länger dauert)</label></div>'
            + '</div>'
            
            + '<div class="text-[11px] font-bold text-gray-300 mb-2">Eskalations-Phasen (Nach Cast-Nummer)</div>'
            + '<div class="text-[10px] text-gray-500 mb-2">Die Zahlen unten stehen für die Nummer des Casts (z.B. Cast 1 bis 3). Für jede Phase können individuelle Kategorien (CDs) festgelegt werden.</div>'
            + '<div id="es-ranges-container" class="space-y-2 mb-2"></div>'
            + '<button id="es-add-range" class="w-full py-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-[10px] text-gray-300">+ Phase hinzufügen</button>';

        var content = document.createElement('div');
        content.innerHTML = html;

        var rCont = content.querySelector('#es-ranges-container');
        
        function renderRanges() {
            var htmlStr = '';
            var allCats = Object.keys(categories);
            escRanges.forEach(function(r, idx) {
                var rCats = r.categories || [];
                var catHtml = '';
                allCats.forEach(function(catKey) {
                    var cat = categories[catKey];
                    var isChecked = rCats.indexOf(catKey) !== -1;
                    catHtml += '<label class="flex items-center gap-2 p-1 hover:bg-slate-700/50 rounded cursor-pointer text-[10px]">'
                        + '<input type="checkbox" data-idx="' + idx + '" value="' + catKey + '" ' + (isChecked ? 'checked' : '') + ' style="accent-color:' + cat.color + ';">'
                        + '<span style="color:' + cat.color + '">' + cat.name + '</span>'
                        + '</label>';
                });

                htmlStr += '<div class="flex flex-col gap-2 bg-slate-900 p-2 border border-slate-700 rounded" data-idx="' + idx + '">'
                    + '<div class="flex gap-2 items-center">'
                    + '<span class="text-[10px] text-gray-400">Cast</span>'
                    + '<input type="number" class="w-12 bg-slate-800 border border-slate-600 text-[10px] px-1 py-1 rounded text-center es-r-start" data-idx="' + idx + '" value="' + r.start + '" title="Start-Cast (Nummer)">'
                    + '<span class="text-[10px] text-gray-500">bis</span>'
                    + '<input type="number" class="w-12 bg-slate-800 border border-slate-600 text-[10px] px-1 py-1 rounded text-center es-r-end" data-idx="' + idx + '" value="' + r.end + '" title="End-Cast (Nummer)">'
                    + '<div class="flex-1"></div>'
                    + '<button class="text-red-400 hover:text-red-300 px-1 es-r-del" data-idx="' + idx + '" title="Phase löschen">✕</button>'
                    + '</div>'
                    + '<div class="bg-slate-800 border border-slate-600 rounded p-1 max-h-32 overflow-y-auto">'
                    + catHtml
                    + '</div>'
                    + '</div>';
            });
            rCont.innerHTML = htmlStr;
        }

        rCont.addEventListener('change', function(e) {
            var target = e.target;
            var idx = parseInt(target.getAttribute('data-idx'));
            if (isNaN(idx)) return;
            var r = escRanges[idx];
            if (!r) return;

            if (target.type === 'checkbox') {
                var catKey = target.value;
                if (target.checked) {
                    if (r.categories.indexOf(catKey) === -1) r.categories.push(catKey);
                } else {
                    var i = r.categories.indexOf(catKey);
                    if (i !== -1) r.categories.splice(i, 1);
                }
            } else if (target.classList.contains('es-r-start')) {
                r.start = parseInt(target.value) || 1;
            } else if (target.classList.contains('es-r-end')) {
                r.end = parseInt(target.value) || 99;
            }
        });

        rCont.addEventListener('click', function(e) {
            var target = e.target.closest('.es-r-del');
            if (target) {
                var idx = parseInt(target.getAttribute('data-idx'));
                if (!isNaN(idx)) {
                    escRanges.splice(idx, 1);
                    renderRanges();
                }
            }
        });

        renderRanges();

        content.querySelector('#es-add-range').addEventListener('click', function() {
            var lastEnd = escRanges.length > 0 ? escRanges[escRanges.length-1].end : 0;
            escRanges.push({start: lastEnd + 1, end: lastEnd + 1, categories: []});
            renderRanges();
        });

        var overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[9999]';
        var modal = document.createElement('div');
        modal.className = 'bg-slate-800 border border-slate-600 rounded-lg shadow-xl w-[400px] max-w-full flex flex-col max-h-[90vh]';
        
        var mHead = document.createElement('div');
        mHead.className = 'p-3 border-b border-slate-700 flex justify-between items-center';
        mHead.innerHTML = '<h3 class="text-sm font-bold text-gray-200">Event-Einstellungen</h3>';
        
        var mBody = document.createElement('div');
        mBody.className = 'p-3 overflow-y-auto';
        mBody.appendChild(content);

        var mFoot = document.createElement('div');
        mFoot.className = 'p-3 border-t border-slate-700 flex justify-end gap-2';
        
        var btnCancel = document.createElement('button');
        btnCancel.className = 'px-3 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded';
        btnCancel.textContent = 'Abbrechen';
        btnCancel.onclick = function() { overlay.remove(); };

        var btnSave = document.createElement('button');
        btnSave.className = 'px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded font-bold';
        btnSave.textContent = 'Speichern';
        btnSave.onclick = function() {
            setOverride(eventKey, 'eventDuration', parseFloat(content.querySelector('#es-dur').value) || 0, true);
            setOverride(eventKey, 'overlapSec', parseFloat(content.querySelector('#es-overlap').value) || 0, true);
            setOverride(eventKey, 'resetEscalation', parseInt(content.querySelector('#es-res').value) || 0, true);
            setOverride(eventKey, 'continuousCoverage', content.querySelector('#es-cont-cov').checked, true);
            // Deep copy der Ranges um Proxy-Probleme zu vermeiden
            var cleanRanges = JSON.parse(JSON.stringify(escRanges));
            setOverride(eventKey, 'escalationRanges', cleanRanges); // Last call triggers the UI rebuild
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
            var opts = '<option value="">— kein Safety —</option>';
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
          +   '<label class="text-xs text-amber-300">Soakender Tank<select id="sk-tank" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-100">' + tankOpts() + '</select></label>'
          +   '<label class="text-xs text-amber-300">P2 Schaden / Hit (unmit.)<input id="sk-hit" type="number" value="' + hit + '" step="50000" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-32 text-gray-100"></label>'
          +   '<label class="text-xs text-amber-300">Tank-HP<input id="sk-hp" type="number" value="' + hpV + '" step="50000" min="0" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-28 text-gray-100" title="HP des soakenden Tanks – markiert tödliche Hits"></label>'
          +   '<label class="text-xs text-amber-300">Min. DR<select id="sk-thr" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-100">'
          +     ['0.50','0.55','0.60','0.65','0.70'].map(function(v){return '<option value="'+v+'"'+(Math.abs(thr-parseFloat(v))<1e-6?' selected':'')+'>'+Math.round(v*100)+'%</option>';}).join('') + '</select></label>'
          +   '<label class="text-xs text-amber-300">Swing (s)<input id="sk-swing" type="number" value="' + swing + '" step="0.1" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-16 text-gray-100"></label>'
          +   '<label class="text-xs text-amber-300">Überlappung (s)<input id="sk-overlap" type="number" value="' + curOverlap + '" step="0.5" min="0" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-16 text-gray-100" title="Lead-Time: Folge-CDs starten so viel früher (Reaktionszeit)"></label>'
          + '</div>'
          + '<div class="flex flex-wrap items-end gap-3 mb-3 p-2 rounded border border-violet-700/40 bg-violet-900/10">'
          +   '<label class="text-xs text-violet-300">Optionaler Safety-CD (kein DR)<select id="sk-safety" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-100">' + safetyOpts(curTank || tanks[0]) + '</select></label>'
          +   '<label class="text-xs text-violet-300">Safety bei (s)<input id="sk-safetyoff" type="number" value="' + curSafetyOff + '" step="1" min="0" class="block mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm w-16 text-gray-100"></label>'
          +   '<button id="sk-refresh" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Vorschau</button>'
          + '</div>'
          + '<div id="sk-preview" class="mb-4"></div>'
          + '<div class="flex justify-between gap-2">'
          +   '<button id="sk-off" class="bg-rose-700 hover:bg-rose-800 text-white px-3 py-1.5 rounded text-sm">Soak aus (→ Shield)</button>'
          +   '<div class="flex gap-2"><button id="sk-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
          +   '<button id="sk-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button></div>'
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
        ['#sk-hit','#sk-hp','#sk-swing','#sk-safetyoff','#sk-overlap'].forEach(function (s) { modal.querySelector(s).addEventListener('input', preview); });
        ['#sk-thr','#sk-safety'].forEach(function (s) { modal.querySelector(s).addEventListener('change', preview); });
        modal.querySelector('#sk-refresh').addEventListener('click', preview);
        preview();

        modal.querySelector('#sk-save').addEventListener('click', function () { setOverride(eventKey, 'soak', readVals()); document.body.removeChild(overlay); });
        modal.querySelector('#sk-off').addEventListener('click', function () {
            var reqNow = (function () {
                if (custom) return (custom.requiredCDs || []).slice();
                if (ov.requiredCDs !== undefined) return ov.requiredCDs.slice();
                var i = parseInt(eventKey.replace('cfg_', '')); return ((config.events[i] || {}).requiredCDs || []).slice();
            })().filter(function (k) { return k !== 'tank_soak_phys'; });
            setOverride(eventKey, 'requiredCDs', reqNow);
            document.body.removeChild(overlay);
        });
        modal.querySelector('#sk-cancel').addEventListener('click', function () { document.body.removeChild(overlay); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) document.body.removeChild(overlay); });
    }


    // ── Kategorie-Picker pro Event ──
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

        var rows = Object.entries(categories).map(function (entry) {
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
            + '<button id="cat-pick-cancel" class="bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded text-sm">Abbrechen</button>'
            + '<button id="cat-pick-save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-sm">Übernehmen</button>'
            + '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector('#cat-pick-save').addEventListener('click', function () {
            var selected = [];
            modal.querySelectorAll('.cat-pick-cb').forEach(function (cb) {
                if (cb.checked) selected.push(cb.value);
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
        assignments.forEach(function (row) {
            var validSlots = [];
            catKeys.forEach(function (catKey) {
                var slot = row.slots[catKey];
                if (!slot || slot.skipped) return;
                if (!slot.isVirtual && (!slot.player || !slot.dbName || slot.player === '__SKIP__')) return;
                slot._catKey = catKey; // Store catKey for later use
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

            validSlots.forEach(function (slot) {
                if (rowNum > 300) return;
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

                if (slot.isVirtual) {
                    setPlannerSelect(rowPrefix + '-player', slot.player, true);
                    addToBatch(rowPrefix + '-player', { player: slot.player, editor: currentManager, timestamp: serverTs });

                    var virtCat = categories[slot.isVirtualCategoryKey] || categories[slot._catKey];
                    var catName = virtCat ? virtCat.name : 'Virtuell';

                    // Stelle sicher, dass die Option im Select existiert, sonst wird es leer angezeigt
                    var sel = document.querySelector('[data-assignment-id="' + rowPrefix + '-cooldown"]');
                    if (sel) {
                        var exists = Array.from(sel.options).some(function (o) { return o.value === catName; });
                        if (!exists) {
                            var opt = document.createElement('option');
                            opt.value = catName;
                            opt.textContent = catName;
                            opt.dataset.color = virtCat ? virtCat.color : '#fff';
                            sel.appendChild(opt);
                        }
                    }

                    setPlannerSelect(rowPrefix + '-cooldown', catName, true);
                    addToBatch(rowPrefix + '-cooldown', { cooldown: catName, editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-note', slot.note || "", true);
                    addToBatch(rowPrefix + '-note', { text: slot.note || "", editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-tts', slot.tts || "", true);
                    addToBatch(rowPrefix + '-tts', { text: slot.tts || "", editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-varname', slot.varname || "", true);
                    addToBatch(rowPrefix + '-varname', { text: slot.varname || "", editor: currentManager, timestamp: serverTs });

                    setPlannerInput(rowPrefix + '-icon', slot.icon || "", true);
                    addToBatch(rowPrefix + '-icon', { text: slot.icon || "", editor: currentManager, timestamp: serverTs });

                    exported++;
                } else {
                    setPlannerSelect(rowPrefix + '-player', slot.player, true);
                    addToBatch(rowPrefix + '-player', { player: slot.player, editor: currentManager, timestamp: serverTs });

                    var ok = setPlannerSelect(rowPrefix + '-cooldown', slot.dbName, true);
                    addToBatch(rowPrefix + '-cooldown', { cooldown: slot.dbName, editor: currentManager, timestamp: serverTs });

                    if (ok) exported++; else {
                        skipped++;
                        console.warn('[Auto-Planner] CD nicht gefunden: "' + slot.dbName + '" (' + slot.spellId + ')');
                    }
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
                        if (e[1].player && e[1].player !== '__SKIP__') {
                            slots[e[0]] = { player: e[1].player, dbName: e[1].dbName, auto: e[1].auto };
                        }
                    });
                    return { 
                        eventName: r.eventName, 
                        eventKey: r.eventKey,
                        castNum: r.castNum, 
                        absTime: r.absTime, 
                        delay: r.delay || 0, 
                        slots: slots,
                        eventDuration: r.eventDuration || 0,
                        overlapSec: r.overlapSec || 0,
                        _isContinuous: r._isContinuous || false,
                        _continuousOffset: r._continuousOffset || 0,
                        _sourceTriggerMap: r._sourceTriggerMap || null,
                        soak: r.soak || null
                    };
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
            eventOverrides = data.eventOverrides || {};
            customEvents = data.customEvents || [];
            if (data.assignStrategy && typeof data.assignStrategy === 'object') {
                assignStrategy.spread = !!data.assignStrategy.spread;
                assignStrategy.prioritizeCategories = !!data.assignStrategy.prioritizeCategories;
                assignStrategy.roundRobin = !!data.assignStrategy.roundRobin;
            }
            if (data.assignments && Array.isArray(data.assignments)) {
                var roster = window.effectiveRoster || window.rosterData || [];
                assignments = data.assignments.map(function(r) {
                    var evtObj = null;
                    if (r.eventKey && r.eventKey.startsWith('cfg_')) {
                        var idx = parseInt(r.eventKey.replace('cfg_', ''));
                        evtObj = config.events[idx] || {};
                    } else {
                        evtObj = customEvents.find(function(e) { return e._key === r.eventKey; }) || {};
                    }
                    var ov = eventOverrides[r.eventKey] || {};
                    r.icon = ov.icon !== undefined ? ov.icon : (evtObj.icon || '');
                    r.requiredCDs = ov.requiredCDs !== undefined ? ov.requiredCDs : (evtObj.requiredCDs || []);
                    
                    if (r.slots) {
                        Object.keys(r.slots).forEach(function(catKey) {
                            var slot = r.slots[catKey];
                            if (slot && slot.player && slot.player !== '__SKIP__') {
                                var cd = cooldownsDB.find(function(c) { return c.name === slot.dbName; });
                                if (cd) {
                                    slot.dbClass = cd.class;
                                    slot.durationSec = cd.durationSec || '';
                                    slot.cooldownSec = cd.cooldownSec || '';
                                }
                                var p = roster.find(function(x) { return x.name === slot.player; });
                                if (p && p.class) slot.dbClass = p.class;
                            }
                        });
                    }

                    return r;
                });

                // Migration: Reconstruct lost escalationRanges from saved assignments
                var reconstructed = {};
                assignments.forEach(function(r) {
                    if (!r.eventKey || !r.requiredCDs || !r.castNum) return;
                    if (!reconstructed[r.eventKey]) reconstructed[r.eventKey] = {};
                    // Deduplicate by castNum since assignments contains one row per slot
                    reconstructed[r.eventKey][r.castNum] = r.requiredCDs;
                });

                var recoveredCount = 0;
                
                // Cleanup buggy duplicated ranges that might have been saved previously
                Object.keys(eventOverrides).forEach(function(k) {
                    var ov = eventOverrides[k];
                    if (ov && ov.escalationRanges && ov.escalationRanges.length > 0) {
                        var unique = [];
                        var seen = {};
                        ov.escalationRanges.forEach(function(r) {
                            var sig = r.start + '-' + r.end + '-' + JSON.stringify(r.categories || []);
                            if (!seen[sig]) {
                                seen[sig] = true;
                                unique.push(r);
                            }
                        });
                        ov.escalationRanges = unique;
                    }
                });

                Object.keys(reconstructed).forEach(function(key) {
                    var evtObj = null;
                    if (key.startsWith('cfg_')) {
                        evtObj = config.events[parseInt(key.replace('cfg_', ''))] || {};
                    } else {
                        evtObj = customEvents.find(function(e) { return e._key === key; }) || {};
                    }
                    var baseCatsStr = JSON.stringify(evtObj.requiredCDs || []);

                    var castMap = reconstructed[key];
                    var casts = Object.keys(castMap).map(function(num) {
                        return { castNum: parseInt(num), categories: castMap[num] };
                    });
                    casts.sort(function(a,b) { return a.castNum - b.castNum; });
                    
                    var ranges = [];
                    var currentRange = null;
                    casts.forEach(function(c) {
                        var catStr = JSON.stringify(c.categories);
                        if (!currentRange) {
                            currentRange = { start: c.castNum, end: c.castNum, categories: c.categories, catStr: catStr };
                        } else {
                            if (currentRange.catStr === catStr && c.castNum === currentRange.end + 1) {
                                currentRange.end = c.castNum;
                            } else {
                                ranges.push({ start: currentRange.start, end: currentRange.end, categories: currentRange.categories });
                                currentRange = { start: c.castNum, end: c.castNum, categories: c.categories, catStr: catStr };
                            }
                        }
                    });
                    if (currentRange) ranges.push({ start: currentRange.start, end: currentRange.end, categories: currentRange.categories });

                    var isTrivial = ranges.length === 1 && JSON.stringify(ranges[0].categories) === baseCatsStr;
                    var isBaseEscalation = evtObj.escalationRanges && JSON.stringify(ranges) === JSON.stringify(evtObj.escalationRanges);
                    
                    if (!isTrivial && !isBaseEscalation) {
                        var ov = eventOverrides[key] || {};
                        if (!ov.escalationRanges || ov.escalationRanges.length === 0) {
                            if (!eventOverrides[key]) eventOverrides[key] = {};
                            eventOverrides[key].escalationRanges = ranges;
                            recoveredCount++;
                        }
                    }
                });
                
                if (recoveredCount > 0) {
                    console.log("[Auto-Planner] Recovered " + recoveredCount + " lost escalation ranges.");
                    setTimeout(function() {
                        if (typeof updateStatus === 'function') {
                            updateStatus("✨ " + recoveredCount + " verlorene Phasen-Einstellungen automatisch aus alten Einteilungen wiederhergestellt!", "text-emerald-400");
                        }
                    }, 1000);
                }
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
            Object.keys(DEFAULT_CATEGORIES).forEach(function (k) {
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

    var addCatBtn = '<div class="mb-3 flex items-center gap-2"><button id="btn-add-category" class="bg-emerald-700 hover:bg-emerald-800 text-white text-xs py-1.5 px-3 rounded border border-emerald-500">+ Neue Kategorie</button></div>';

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
    // Add category
    var addBtn = document.getElementById('btn-add-category');
    if (addBtn) {
        var saveCatBtn = document.getElementById('btn-save-categories');
        if (saveCatBtn) {
            saveCatBtn.classList.remove('hidden');
            saveCatBtn.classList.remove('lg:block');
            addBtn.parentNode.appendChild(saveCatBtn);
        }
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
            renderCategoriesAdmin();
        });
    }

    // Delete category
    document.querySelectorAll('.delete-cat-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            var cat = e.target.dataset.cat;
            if (!confirm('Kategorie "' + categories[cat].name + '" wirklich löschen?')) return;
            delete categories[cat];
            renderCategoriesAdmin();
        });
    });

    // Name/Shortname/Color änderungen
    document.querySelectorAll('.cat-name-input').forEach(function (inp) {
        inp.addEventListener('change', function (e) {
            categories[e.target.dataset.cat].name = e.target.value;
        });
    });
    document.querySelectorAll('.cat-short-input').forEach(function (inp) {
        inp.addEventListener('change', function (e) {
            categories[e.target.dataset.cat].shortName = e.target.value;
        });
    });
    document.querySelectorAll('.cat-color-input').forEach(function (inp) {
        inp.addEventListener('change', function (e) {
            categories[e.target.dataset.cat].color = e.target.value;
        });
    });

    // Virtuelle Felder
    document.querySelectorAll('.cat-virtual-input').forEach(function (inp) {
        inp.addEventListener('change', function (e) {
            categories[e.target.dataset.cat][e.target.dataset.field] = e.target.value;
        });
    });

    // Kategorie-Role
    document.querySelectorAll('.cat-role-select').forEach(function (sel) {
        sel.addEventListener('change', function (e) {
            var v = e.target.value;
            if (v) categories[e.target.dataset.cat].requiredRole = v;
            else delete categories[e.target.dataset.cat].requiredRole;
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
    // Alle Spells aus der DB anzeigen — Duplikate explizit erlaubt für spec-spezifische Prio
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
    Object.keys(categories).forEach(function (k) {
        categories[k].spells.forEach(function (s) { total++; if (resolveSpell(s.spellId)) found++; });
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
        managerOnlyButtons.forEach(function (btnId) {
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
            tbody.querySelectorAll('select, input, button').forEach(function (el) {
                el.disabled = !isManager;
            });
        }

        // 3. Event-Manager-Bereich: alle Steuer-Elemente deaktivieren
        var eventArea = document.getElementById('auto-planner-events');
        if (eventArea) {
            eventArea.querySelectorAll('input, button, select').forEach(function (el) {
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
    var managerWatcher = setInterval(function () {
        var current = !!window.isManager;
        if (current !== lastManagerState) {
            lastManagerState = current;
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
    var btnSaveCategories = document.getElementById('btn-save-categories');
    if (btnSaveCategories) {
        btnSaveCategories.addEventListener('click', function () {
            if (!window.isManager) {
                if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
                return;
            }
            saveCategories();
        });
    }
    document.getElementById('btn-clear-auto').addEventListener('click', function () {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
        var msg = "Auto-Plan Zuweisungen leeren?\n\nLöscht alle Zuweisungen im Auto-Plan, behält aber die Event-Anpassungen (Häkchen) bei.\nDie CD-Planer-Einträge im Raidplan bleiben unangetastet.";
        if (typeof window.showModal === 'function') {
            var r = window.showModal(msg, true);
            if (r && typeof r.then === 'function') { r.then(function (ok) { if (ok) clearPlan(); }); }
            else clearPlan();
        } else { if (confirm(msg)) clearPlan(); }
    });

    // ── Events-Reset-Button dynamisch einfügen (nur für Manager) ──
    injectResetEventsButton();

    // ── Clear-Planner-Button dynamisch einfügen (nur für Manager) ──
    injectClearPlannerButton();

    // ── DB-Wipe Button dynamisch einfügen (nur für Manager) ──
    injectWipeButton();

    // Wenn ein gespeicherter Plan existiert, geladene Assignments direkt anzeigen
    if (hasSavedPlan) {
        if (assignments && assignments.length > 0) {
            renderTimeline(assignments);
        }
        updateStatus('Gespeicherter Plan geladen. Klicke auf "Auto-Zuweisen", um bei Roster-Änderungen neu zu berechnen.');
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
        el.addEventListener('change', function () {
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

    var eventsArea = document.getElementById('auto-planner-events');
    if (!eventsArea) return;

    var dangerZone = document.getElementById('planner-danger-zone');
    if (!dangerZone) {
        dangerZone = document.createElement('div');
        dangerZone.id = 'planner-danger-zone';
        dangerZone.className = "mt-4 pt-4 border-t border-slate-700 flex flex-wrap items-center gap-2";
        
        var title = document.createElement('div');
        title.className = 'w-full text-xs font-bold text-slate-300 mb-1 uppercase tracking-wide';
        title.innerHTML = '⚙️ Daten verwalten & Zurücksetzen';
        dangerZone.appendChild(title);
        
        var clearAutoBtn = document.getElementById('btn-clear-auto');
        if (clearAutoBtn) {
            clearAutoBtn.classList.replace('bg-slate-700', 'bg-red-800');
            clearAutoBtn.classList.replace('hover:bg-slate-800', 'hover:bg-red-900');
            clearAutoBtn.innerHTML = '🗑️ Auto-CD Plan leeren';
            dangerZone.appendChild(clearAutoBtn);
        }
        
        eventsArea.appendChild(dangerZone);
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
    clearBtn.title = 'Leert ALLE 200 Zeilen des Advanced CD-Plans dieses Bosses (Auto-Plan bleibt unangetastet)';
    
    exportBtn.parentNode.insertBefore(clearBtn, exportBtn.nextSibling);
    clearBtn.style.marginLeft = '0.5rem';

    clearBtn.addEventListener('click', function () {
        if (!window.isManager) {
            if (window.showModal) window.showModal("Nur Gildenräte können diese Aktion ausführen.");
            return;
        }
        var msg = "Advanced CD-Plan leeren?\n\nLöscht ALLE 200 Zeilen des CD-Planers dieses Bosses (Trigger, Spieler, Cooldowns, Zeiten, Texte).\nDer Auto-CD-Plan bleibt unangetastet.\n\nFortfahren?";
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
    wipeBtn.title = 'Löscht ALLE Datenbank-Einträge für diesen Boss (CD-Planer + Auto-Planer)';
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
}) ();
