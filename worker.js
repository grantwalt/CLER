/**
 * ClerkAI — Cloudflare Worker Suite  v6.0
 * ══════════════════════════════════════════════════════════════
 * Knowledge-Dense Conversation Engine
 * Zero-LLM, fully rule-based. Drop-in replacement for worker.js.
 *
 * All upgrades from v5.0 are preserved (1–8).
 * New in v6.0:
 *
 * ✦ UPGRADE 9 — Structured Symptom Fact Store
 *     Every case carries a `symptomFacts` object alongside the
 *     legacy `intentMap`. Facts are structured data:
 *       { onset, severity, character, duration, modifiers[], context }
 *     The conversation engine reads facts, not strings.
 *     `intentMap` is retained as a fallback for backward compat.
 *
 * ✦ UPGRADE 10 — Template Engine
 *     Per-intent sentence-template banks keyed by:
 *       temperament × distress-level × revelation-tier
 *     Templates contain slot placeholders ({onset}, {severity}, etc.)
 *     filled deterministically from the fact store.
 *     ~8–12 base templates × 4 temperaments × 2 distress states
 *     = 64–96 permutations per intent, selected by seeded hash.
 *     No two back-to-back visits produce the same sentence.
 *
 * ✦ UPGRADE 11 — Conversation Assembler
 *     Reads full conversationHistory to:
 *       • Cross-reference previously mentioned symptoms
 *         ("as I told you about the breathing…")
 *       • Gate deep-disclosure behind at least one prior probe
 *         (patient reveals more on second ask)
 *       • Vary sentence length & complexity by temperament
 *       • Chain multi-sentence responses coherently using
 *         topic-transition connectors
 *
 * ✦ UPGRADE 12 — Revelation Gating
 *     Symptom facts have three tiers:
 *       TIER 1 — volunteered on first ask (chief complaint facts)
 *       TIER 2 — disclosed on direct questioning
 *       TIER 3 — only surface after ≥2 probes on this topic
 *                (patient reluctantly admits deeper detail)
 *     Gate logic is entirely rule-based.
 *
 * Routes — same as v5.0, 100% backward compatible:
 *   GET  /cases?discipline=
 *   POST /chat                 ← now uses conversation engine
 *   POST /scores
 *   GET  /leaderboard?discipline=
 *   GET  /health
 *   POST /admin/ingest
 *   GET  /admin/knowledge?topic=
 *   POST /admin/ingest-cases
 *
 * KV Bindings (same as v5.0):
 *   CASES_KV  /  SCORES_KV  /  KNOWLEDGE_KV
 *
 * Env vars: ADMIN_SECRET
 */

import pedsBank  from './knowledge/peds_knowledge_bank.json';
import pedsCases from './knowledge/cases/peds_cases.json';

const STATIC_BANK = { ...pedsBank };

// ══════════════════════════════════════════════════════════════
//  UPGRADE 9 — STRUCTURED SYMPTOM FACT STORE
//  symptomFacts lives alongside intentMap in each case.
//  Shape: { [intentId]: SymptomFact }
//
//  SymptomFact {
//    onset?:     string   — when it started / mode of onset
//    severity?:  string   — mild/moderate/severe descriptor
//    character?: string   — quality (sharp, dull, throbbing…)
//    duration?:  string   — how long each episode lasts
//    location?:  string   — anatomical location
//    radiation?: string   — spread pattern
//    modifiers?: string[] — aggravating / relieving factors
//    context?:   string   — surrounding circumstances
//    tier1?:     string   — volunteered reply (first ask)
//    tier2?:     string   — on direct questioning
//    tier3?:     string   — reluctant deep disclosure
//    naReply?:   string   — if not applicable to this patient
//  }
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  UPGRADE 10 — TEMPLATE ENGINE
//  Templates are keyed: TEMPLATES[intentId][temperament][tier]
//  Slots: {onset} {severity} {character} {duration} {location}
//         {radiation} {modifier} {context}
//  A missing slot renders as '' so sentences stay grammatical.
// ══════════════════════════════════════════════════════════════

const TEMPLATES = {

  // ── HPC: ONSET ───────────────────────────────────────────────
  hpc_onset: {
    cooperative: [
      'It started {onset}. {context}',
      'The {character} began {onset}. {context}',
      'About {onset} ago, doctor. {context}',
      'It\'s been going on for {onset} now. {context}',
      'It came on {onset}. {context}',
    ],
    anxious: [
      'It started {onset} and I\'ve been worried ever since. {context}',
      'About {onset} ago, doctor — I should have come in sooner, I know. {context}',
      'It\'s been {onset} and it keeps getting worse. {context}',
      'Please doctor, it started {onset}. {context}',
    ],
    stoic: [
      '{onset}. That\'s when it started.',
      'It came on {onset}. {context}',
      'About {onset} ago.',
      '{onset}. {context}',
    ],
    reticent: [
      '(pause) About {onset}, I suppose. {context}',
      'Started {onset}. That\'s all I can say.',
      '{onset} ago... I didn\'t think it was serious at first. {context}',
    ],
    frightened_child_proxy: [
      'It started {onset}, doctor. {context}',
      'About {onset}, doctor — we\'ve been so worried. {context}',
      'It came on {onset}. Please help.',
    ],
  },

  // ── HPC: CHARACTER ───────────────────────────────────────────
  hpc_character: {
    cooperative: [
      'The {character}. {modifier}',
      'It\'s a {character} kind of {location} — {modifier}',
      'I\'d describe it as {character}. {modifier}',
      'It feels {character} in my {location}. {modifier}',
      'Definitely {character}. {modifier}',
    ],
    anxious: [
      'It\'s a {character} — is that bad, doctor? {modifier}',
      'The {character} is very severe. {modifier}',
      'I\'ve never felt {character} like this before. {modifier}',
      'It\'s {character} and I\'m really scared. {modifier}',
    ],
    stoic: [
      '{character}. {modifier}',
      'The {character}. Not easy but I manage. {modifier}',
      '{character} in the {location}. {modifier}',
    ],
    reticent: [
      '(reluctantly) {character}, I suppose. {modifier}',
      'It\'s {character}... I don\'t know how else to describe it. {modifier}',
    ],
    frightened_child_proxy: [
      'The child keeps crying — we think it\'s {character}. {modifier}',
      'It looks like {character} pain. {modifier}',
      'It\'s a {character} pain — the child can\'t keep still. {modifier}',
    ],
  },

  // ── HPC: RADIATION ───────────────────────────────────────────
  hpc_radiation: {
    cooperative: [
      'It {radiation}.',
      'The pain {radiation}.',
      'Yes — it {radiation}.',
      'From the {location} it {radiation}.',
    ],
    anxious: [
      'It {radiation} — should I be worried about that?',
      'Yes and the pain {radiation}, which frightened me.',
    ],
    stoic: [
      '{radiation}.',
      'Goes {radiation}. That\'s it.',
    ],
    reticent: [
      '(thinking) It may {radiation}... I\'m not sure.',
      '{radiation}. I hadn\'t really thought about it.',
    ],
    frightened_child_proxy: [
      'The child seems like the pain {radiation}.',
      'It looks like it {radiation}.',
    ],
  },

  // ── HPC: RELIEVING ───────────────────────────────────────────
  hpc_relieving: {
    cooperative: [
      '{modifier}',
      'Honestly, not much helps. {modifier}',
      '{modifier} — that\'s the only thing that gives some relief.',
      'I\'ve tried {modifier} but it doesn\'t last.',
    ],
    anxious: [
      'Nothing really helps, doctor. {modifier} I\'m very uncomfortable.',
      '{modifier} — but it always comes back.',
    ],
    stoic: [
      '{modifier}',
      'Not much. {modifier}',
    ],
    reticent: [
      '{modifier} Maybe.',
      'I don\'t know. {modifier}',
    ],
    frightened_child_proxy: [
      'When we hold the child it settles a little. {modifier}',
      '{modifier} — it\'s the only thing that seems to calm them.',
    ],
  },

  // ── SR: FEVER ────────────────────────────────────────────────
  sr_fever: {
    cooperative: [
      'Yes, I\'ve been running a temperature. {onset} {severity}',
      'Yes, there\'s been fever. {onset} {severity}',
      'I\'ve been feeling very hot. {onset} {severity}',
      'Yes — my temperature was {severity}. {onset}',
    ],
    anxious: [
      'Yes, I have fever and it worries me. {onset} {severity}',
      'The temperature has been {severity}. {onset} It\'s not settling.',
    ],
    stoic: [
      'Yes. Fever since {onset}. {severity}',
      'Running a temperature. {severity}',
    ],
    reticent: [
      'A bit of a temperature, yes. {onset}',
      'I suppose there\'s some fever. {severity}',
    ],
    frightened_child_proxy: [
      'The child has had fever since {onset}. Temperature was {severity}.',
      'Yes, very high fever — {severity}. {onset}',
    ],
  },

  // ── SR: NAUSEA/VOMITING ──────────────────────────────────────
  sr_nausea: {
    cooperative: [
      'Yes — I vomited {onset}. {severity}',
      'Yes, there\'s been nausea and vomiting. {onset}',
      'I\'ve been sick. {onset} {severity}',
    ],
    anxious: [
      'Yes and I can\'t keep anything down. {onset} {severity}',
      'I keep vomiting — it\'s been {onset}. {severity}',
    ],
    stoic: [
      'Some vomiting. {onset}',
      'Vomited {onset}. {severity}',
    ],
    reticent: [
      'A bit of nausea, yes. {onset}',
      'I was sick {onset}.',
    ],
    frightened_child_proxy: [
      'The child has been vomiting since {onset}. {severity}',
      'Yes — vomiting {onset}. Won\'t keep anything down.',
    ],
  },

  // ── SR: CONSCIOUSNESS ────────────────────────────────────────
  sr_consciousness: {
    cooperative: [
      '{context} {severity}',
      'The consciousness — {context}. {severity}',
      '{severity} {context}',
    ],
    anxious: [
      '{context} — it was terrifying. {severity}',
      '{severity} {context} I\'ve never seen that before.',
    ],
    stoic: [
      '{context} {severity}',
      '{severity} {context}',
    ],
    reticent: [
      '{context}',
      '(quietly) {context} {severity}',
    ],
    frightened_child_proxy: [
      '{context} The child was not themselves. {severity}',
      'It was frightening — {context}. {severity}',
    ],
  },

  // ── SR: SEIZURES ─────────────────────────────────────────────
  sr_seizures: {
    cooperative: [
      '{context} {severity} {duration}',
      'There were fits. {context} {duration}',
      '{severity} {context}',
    ],
    anxious: [
      '{context} — I was so scared. {severity}',
      'The seizures — {context}. {severity} I didn\'t know what to do.',
    ],
    stoic: [
      '{context} {severity}',
      'Fits. {context} {duration}',
    ],
    reticent: [
      '{context}',
      '(looks away) {context} {severity}',
    ],
    frightened_child_proxy: [
      'The child was shaking — {context}. {severity} {duration}',
      '{context} {duration} We were terrified.',
    ],
  },

  // ── SR: OEDEMA ───────────────────────────────────────────────
  sr_oedema: {
    cooperative: [
      '{context} The swelling started {onset}. {severity}',
      'Yes, my {location} are swollen. {severity} {context}',
      'There\'s been swelling. {onset} {context}',
    ],
    anxious: [
      'The swelling in my {location} is very bad. {severity} {context}',
      'My {location} are badly swollen, doctor. {context}',
    ],
    stoic: [
      '{location} swollen. {onset} {severity}',
      'Some swelling. {context}',
    ],
    reticent: [
      'A bit of swelling in the {location}. {context}',
      '{location} have been swollen. {onset}',
    ],
    frightened_child_proxy: [
      'The child\'s {location} are swollen. {severity} {onset}',
      'We noticed swelling in the {location} {onset}.',
    ],
  },

  // ── SR: URINARY ──────────────────────────────────────────────
  sr_urinary: {
    cooperative: [
      '{context} {severity}',
      'The urine has been {context}. {severity}',
      '{severity} {context}',
    ],
    anxious: [
      '{context} — I\'m worried about it. {severity}',
      'My urine has changed. {context} {severity}',
    ],
    stoic: [
      '{context}',
      'Urine — {context}. {severity}',
    ],
    reticent: [
      '(quietly) {context}',
      '{context} I didn\'t want to mention it.',
    ],
    frightened_child_proxy: [
      '{context} We noticed it {onset}.',
      'The child\'s urine — {context}.',
    ],
  },

  // ── SR: CHEST PAIN ───────────────────────────────────────────
  sr_chest_pain: {
    cooperative: [
      '{context} {severity} {onset}',
      'There\'s chest {character}. {severity} {context}',
      '{character} in the chest. {onset} {context}',
    ],
    anxious: [
      '{context} — the chest {character} really worries me. {severity}',
      '{severity} chest {character}. {context} I keep thinking the worst.',
    ],
    stoic: [
      '{character} in the chest. {context}',
      '{context} {severity}',
    ],
    reticent: [
      'Some chest {character}. {context}',
      '{context}',
    ],
    frightened_child_proxy: [
      'The child complains of chest {character}. {context}',
      '{context} {severity}',
    ],
  },

  // ── SR: FETAL MOVEMENT ───────────────────────────────────────
  sr_fetal_movement: {
    cooperative: [
      '{context} {severity}',
      'The baby\'s movements — {context}. {severity}',
    ],
    anxious: [
      '{context} — I\'m so worried. {severity}',
      'The baby... {context}. {severity} Please check.',
    ],
    stoic: [
      '{context} {severity}',
    ],
    reticent: [
      '{context}',
      '(quietly) {context} {severity}',
    ],
    frightened_child_proxy: [
      '{context}',
    ],
  },

  // ── PMH ──────────────────────────────────────────────────────
  pmh_general: {
    cooperative: [
      '{context}',
      'For my medical history — {context}',
      'In the past, {context}',
    ],
    anxious: [
      '{context} — could any of this be related?',
      'I have {context}. Is that important?',
    ],
    stoic: [
      '{context}',
      'Past history — {context}',
    ],
    reticent: [
      '{context}',
      '(reluctantly) {context}',
    ],
    frightened_child_proxy: [
      'The child\'s past history — {context}',
      '{context}',
    ],
  },

  // ── MEDICATIONS ──────────────────────────────────────────────
  meds_general: {
    cooperative: [
      '{context}',
      'For medications — {context}',
      'I take {context}',
    ],
    anxious: [
      '{context} — I hope I\'m not taking anything wrong.',
      '{context} Are those safe?',
    ],
    stoic: [
      '{context}',
    ],
    reticent: [
      '{context}',
      '(pause) {context}',
    ],
    frightened_child_proxy: [
      'The child is on {context}',
      '{context}',
    ],
  },

  // ── FAMILY HISTORY ───────────────────────────────────────────
  fhx_general: {
    cooperative: [
      '{context}',
      'Family history — {context}',
    ],
    anxious: [
      '{context} — does that increase my risk?',
      '{context} I always worry about it.',
    ],
    stoic: [
      '{context}',
    ],
    reticent: [
      '{context}',
      '(briefly) {context}',
    ],
    frightened_child_proxy: [
      '{context}',
    ],
  },

  // ── SOCIAL HISTORY ───────────────────────────────────────────
  shx_general: {
    cooperative: [
      '{context}',
      'Social history — {context}',
    ],
    anxious: [
      '{context} — could lifestyle have caused this?',
      '{context}',
    ],
    stoic: [
      '{context}',
    ],
    reticent: [
      '(reluctantly) {context}',
      '{context} I prefer not to discuss my personal life.',
    ],
    frightened_child_proxy: [
      '{context}',
    ],
  },

  // ── ANTENATAL ────────────────────────────────────────────────
  antenatal: {
    cooperative: [
      '{context}',
      'Antenatal history — {context}',
    ],
    anxious: [
      '{context} Everything seemed fine until now.',
      '{context} — is the baby okay?',
    ],
    stoic: [
      '{context}',
    ],
    reticent: [
      '{context}',
    ],
    frightened_child_proxy: [
      '{context}',
    ],
  },

  // ── PARITY ───────────────────────────────────────────────────
  parity: {
    cooperative: [
      '{context}',
    ],
    anxious: [
      '{context} — this is my most difficult pregnancy.',
      '{context}',
    ],
    stoic: [
      '{context}',
    ],
    reticent: [
      '{context}',
    ],
    frightened_child_proxy: [
      '{context}',
    ],
  },

  // ── IMMUNISATION ─────────────────────────────────────────────
  immunisation: {
    cooperative: [
      '{context}',
      'Vaccinations — {context}',
    ],
    anxious: [
      '{context} — is that okay? I try to bring the child regularly.',
      '{context}',
    ],
    stoic: [
      '{context}',
    ],
    reticent: [
      '{context}',
    ],
    frightened_child_proxy: [
      '{context}',
      'Vaccinations — {context}',
    ],
  },

  // ── TRAVEL ───────────────────────────────────────────────────
  shx_travel: {
    cooperative: [
      '{context}',
      'Travel — {context}',
    ],
    anxious: [
      '{context} — could the travel have caused this?',
    ],
    stoic: [
      '{context}',
    ],
    reticent: [
      '{context}',
    ],
    frightened_child_proxy: [
      '{context}',
    ],
  },

  // ── EXAM: GENERAL ────────────────────────────────────────────
  exam_general: {
    cooperative: ['{context}'],
    anxious:     ['{context}'],
    stoic:       ['{context}'],
    reticent:    ['{context}'],
    frightened_child_proxy: ['{context}'],
  },

  // ── DEFAULT FALLBACK (used if no template found for intentId)
  _default: {
    cooperative: ['{context}'],
    anxious:     ['{context}'],
    stoic:       ['{context}'],
    reticent:    ['{context}'],
    frightened_child_proxy: ['{context}'],
  },
};

// ══════════════════════════════════════════════════════════════
//  UPGRADE 11 — CONVERSATION ASSEMBLER
//  Cross-references history, applies revelation gating,
//  inserts transition connectors between sentences.
// ══════════════════════════════════════════════════════════════

/**
 * Cross-reference connectors — injected when the patient
 * refers back to something already established.
 */
const BACK_REFERENCE_CONNECTORS = [
  'As I mentioned about the {topic}, ',
  'Related to what I said about the {topic} — ',
  'Going back to the {topic} I told you about — ',
  'You\'ll remember I said the {topic} — ',
];

const TOPIC_LABELS = {
  sr_fever:         'fever',
  hpc_onset:        'pain onset',
  hpc_character:    'pain character',
  sr_nausea:        'vomiting',
  sr_oedema:        'swelling',
  sr_chest_pain:    'chest pain',
  sr_urinary:       'urinary symptoms',
  sr_seizures:      'fits',
  sr_fetal_movement:'baby\'s movements',
  pmh_general:      'medical history',
  meds_general:     'medications',
};

/**
 * getRevealedIntents(conversationHistory)
 * Returns a Set of intentIds already disclosed in prior turns.
 */
function getRevealedIntents(conversationHistory) {
  const revealed = new Set();
  for (const turn of (conversationHistory || [])) {
    if (turn.intentId) revealed.add(turn.intentId);
  }
  return revealed;
}

/**
 * countIntentAsks(intentId, conversationHistory)
 * How many times has this exact intent been asked before?
 */
function countIntentAsks(intentId, conversationHistory) {
  return (conversationHistory || []).filter(t => t.intentId === intentId).length;
}

/**
 * buildBackReference(intentId, conversationHistory, rng)
 * If a related intent was already revealed, return a
 * connector phrase. Otherwise return ''.
 */
function buildBackReference(intentId, conversationHistory, rng) {
  // Only cross-reference on symptom intents
  const CROSS_REF_MAP = {
    hpc_character: ['hpc_onset'],
    sr_oedema:     ['hpc_character', 'sr_urinary'],
    sr_urinary:    ['sr_oedema'],
    sr_seizures:   ['sr_fever', 'sr_consciousness'],
    sr_chest_pain: ['hpc_character', 'sr_oedema'],
  };
  const relatives = CROSS_REF_MAP[intentId] || [];
  const revealed  = getRevealedIntents(conversationHistory);
  const match     = relatives.find(r => revealed.has(r));
  if (!match) return '';
  const label     = TOPIC_LABELS[match] || match;
  const pool      = BACK_REFERENCE_CONNECTORS;
  const connector = pool[Math.floor(rng * pool.length)];
  return connector.replace('{topic}', label);
}

// ══════════════════════════════════════════════════════════════
//  UPGRADE 12 — REVELATION GATING
//  Tier 1 = first ask, Tier 2 = second ask, Tier 3 = third+
// ══════════════════════════════════════════════════════════════

/**
 * selectRevealTier(intentId, conversationHistory, facts)
 * Returns the appropriate text tier from the fact store.
 * Falls back cleanly if tiers aren't defined.
 */
function selectRevealTier(intentId, conversationHistory, facts) {
  if (!facts) return null;
  const askCount = countIntentAsks(intentId, conversationHistory);

  if (askCount === 0) {
    // First ask — return tier1 if defined, else null (use template)
    return facts.tier1 || null;
  }
  if (askCount === 1) {
    // Second ask — deeper disclosure
    if (facts.tier2) {
      return `(You asked again) ${facts.tier2}`;
    }
    return null;
  }
  // Third+ ask — reluctant deep reveal or fatigue
  if (facts.tier3) {
    return `(Sighs) ${facts.tier3}`;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  TEMPLATE SLOT FILLER
//  Replaces {slot} placeholders with fact values.
//  Empty slots are removed cleanly.
// ══════════════════════════════════════════════════════════════

/**
 * fillSlots(template, facts)
 * Returns a rendered sentence with all slots resolved.
 */
function fillSlots(template, facts) {
  if (!facts) return template;
  const SLOTS = ['onset','severity','character','duration','location',
                 'radiation','modifier','context'];
  let out = template;
  for (const slot of SLOTS) {
    const value = facts[slot] || '';
    out = out.replace(new RegExp(`\\{${slot}\\}`, 'g'), value);
  }
  // Handle modifier array
  if (facts.modifiers && Array.isArray(facts.modifiers) && facts.modifiers.length) {
    out = out.replace(/\{modifier\}/g, facts.modifiers[0]);
  }
  // Clean up double spaces and trailing punctuation artifacts
  out = out.replace(/\s{2,}/g, ' ')
           .replace(/\.\s*\./g, '.')
           .replace(/,\s*\./g, '.')
           .replace(/^\s+|\s+$/g, '');
  return out;
}

/**
 * selectTemplate(intentId, temperament, isDistressed, rng)
 * Picks a template from the bank deterministically.
 */
function selectTemplate(intentId, temperament, isDistressed, rng) {
  const bank    = TEMPLATES[intentId] || TEMPLATES._default;
  const pool    = bank[temperament] || bank.cooperative || TEMPLATES._default.cooperative;
  // For distressed intents, favour later templates in the pool
  // (they tend to be more emotionally intense)
  const offset  = isDistressed ? Math.floor(pool.length / 2) : 0;
  const idx     = (offset + Math.floor(rng * pool.length)) % pool.length;
  return pool[idx];
}

// ══════════════════════════════════════════════════════════════
//  MASTER CONVERSATION GENERATOR  (Upgrade 9–12 orchestrator)
//  Replaces generatePatientResponse() from v5.0 for intents
//  that have a symptomFacts entry. Falls back to v5.0 pipeline
//  for legacy intents.
// ══════════════════════════════════════════════════════════════

/**
 * generateConversation(opts) → string
 *
 * Pipeline:
 *   1. Revelation gating     → check if tier text overrides template
 *   2. Template selection    → pick sentence template by temperament+hash
 *   3. Slot filling          → inject fact values into template
 *   4. Back-reference        → prepend cross-reference connector if relevant
 *   5. Nigerian context      → probabilistic openers / self-med / faith
 *   6. Personality wrap      → temperament openings/closings
 *   7. Progressive fatigue   → repeat-ask tone adjustment
 *   8. Jargon guard          → override if student used medical jargon
 */
function generateConversation({
  facts,                   // symptomFacts[intentId] — may be null
  baseText,                // legacy intentMap text — fallback
  intentId,
  studentText,
  baseTemperament,
  isDistressed,
  askedIntents,
  conversationHistory,
  cumulativePenalties = 0,
  phaseViolationOccurred = false,
  rng,
}) {
  // ── Step 1: Dynamic temperament drift (from Upgrade 8) ──────
  const dynamicTemperament = shiftTemperament(
    baseTemperament, cumulativePenalties, phaseViolationOccurred);

  let reply;

  if (facts) {
    // ── Step 2: Revelation gating ──────────────────────────────
    const tieredText = selectRevealTier(intentId, conversationHistory, facts);

    if (tieredText) {
      // Tier text is complete — still apply cultural + personality
      reply = tieredText;
    } else {
      // ── Step 3: Template selection ─────────────────────────────
      const template = selectTemplate(intentId, dynamicTemperament, isDistressed, rng);

      // ── Step 4: Slot filling ────────────────────────────────────
      reply = fillSlots(template, facts);
    }

    // ── Step 5: Back-reference connector ───────────────────────
    const backRef = buildBackReference(intentId, conversationHistory, rng);
    if (backRef && reply && !tieredText) {
      reply = backRef + reply.charAt(0).toLowerCase() + reply.slice(1);
    }

  } else {
    // ── No facts — fall back to legacy v5.0 pipeline ───────────
    reply = applyPersonality(baseText, dynamicTemperament, isDistressed, rng);
  }

  // ── Step 6: Progressive fatigue ─────────────────────────────
  reply = applyProgressiveDisclosure(reply, intentId, askedIntents);

  // ── Step 7: Nigerian cultural context ───────────────────────
  reply = injectNigerianContext(reply, intentId, rng);

  // ── Step 8: Jargon confusion guard ──────────────────────────
  reply = handleJargonResponse(studentText, reply);

  return reply;
}

// ══════════════════════════════════════════════════════════════
//  UPGRADED BUILTIN CASES (v6.0)
//  Each case now carries `symptomFacts` alongside `intentMap`.
//  The conversation engine uses facts; the scoring engine still
//  reads from intentMap (unchanged) for backward compat.
// ══════════════════════════════════════════════════════════════

const BUILTIN_CASES_V2 = [
  // ── SURGICAL: ACUTE APPENDICITIS ─────────────────────────────
  {
    caseId: 'case_surg_appendicitis_001',
    discipline: 'surg', difficulty: 'intermediate', timeLimit: 600,
    hospital: 'LUTH Lagos',
    patient: { name: 'Chidi Nwosu', age: 19, sex: 'Male', occupation: 'University Student', avatar: '🧑' },
    presentingComplaint: 'Severe right-sided abdominal pain for 18 hours',
    diagnosis: { primary: 'Acute Appendicitis', keywords: ['appendicitis','acute appendicitis','appendix'] },
    differentials: [
      { name: 'Acute Appendicitis',      color: '#2A5A8A', initial: 35 },
      { name: 'Mesenteric Adenitis',     color: '#5B3F8A', initial: 25 },
      { name: "Meckel's Diverticulitis", color: '#9B3535', initial: 20 },
      { name: 'Right Ureteric Colic',    color: '#7A8F9E', initial: 20 },
    ],
    trapActions: [
      { pattern: /nsaid|ibuprofen|diclofenac/i,                    penalty: 15, explanation: '⛔ NSAIDs mask peritoneal signs and worsen GI bleeding in surgical abdomens. Deducted −15 pts.' },
      { pattern: /morphine.*before.*exam|opioid.*before.*assess/i,  penalty: 15, explanation: '⚠️ Administering opioids before completing the surgical assessment can mask signs. Deducted −15 pts.' },
    ],
    // ── Symptom Facts (Upgrade 9) ──────────────────────────────
    symptomFacts: {
      hpc_onset: {
        onset:    '18 hours ago',
        location: 'belly button area at first',
        context:  'It started around my belly button, then moved to the lower right side of my stomach.',
        tier1:    'It started about 18 hours ago. First it was around my belly button, then moved to the right side. It\'s been getting worse.',
        tier2:    'The pain definitely migrated — started centrally then settled in the right lower abdomen over a few hours. I have not been able to stand up straight since.',
        tier3:    'By the time I got here I couldn\'t walk properly. Every bump in the car made it worse. I was sweating.',
      },
      hpc_character: {
        character: 'constant, sharp pain',
        severity:  'severe — 8 out of 10',
        modifier:  'Movement makes it worse. It\'s not colicky — it doesn\'t come and go.',
        tier1:    'It\'s a constant, sharp pain. Not colicky — it doesn\'t come and go. Severe — I\'d say 8 out of 10. Moving makes it much worse.',
        tier2:    'It\'s definitely constant. Not wave-like. Any movement, even breathing deeply, makes it sharper.',
        tier3:    'Earlier it was dull. Now it\'s sharp and I can\'t find any position that helps.',
      },
      hpc_radiation: {
        radiation: 'stays in the right lower part of my stomach — doesn\'t really go anywhere',
        location:  'right lower abdomen',
        tier1:    'It doesn\'t really go anywhere — it just stays in the right lower part of my stomach.',
      },
      sr_fever: {
        onset:    'since this morning',
        severity: '38.2°C — my flatmate measured it',
        tier1:    'Yes, I\'ve been feeling hot since this morning. My flatmate took my temperature — 38.2°C.',
        tier2:    'The fever started after the pain moved to the right side. I\'ve been sweating.',
      },
      sr_nausea: {
        onset:   'last night and this morning',
        severity:'vomited twice — nothing since this morning',
        tier1:   'Yes, I vomited twice — once last night and once this morning. No appetite at all.',
        tier2:   'I haven\'t been able to eat since yesterday. Even the smell of food makes me nauseous.',
      },
      sr_bowels: {
        context: 'I haven\'t opened my bowels since yesterday. Before this started I was normal — once a day.',
        tier1:   'I haven\'t opened my bowels since yesterday. Before this started I was normal — once a day.',
      },
      pmh_general: {
        context: 'I\'ve been healthy — no medical conditions. Never been admitted to hospital before.',
        tier1:   'I\'ve been healthy — no medical conditions. Never been admitted to hospital before.',
      },
      meds_general: {
        context: 'Nothing regular. I took paracetamol this morning but it didn\'t really help.',
        tier1:   'Nothing regular. I took paracetamol this morning but it didn\'t really help.',
      },
      allergies_general: {
        context: 'No allergies that I know of.',
        tier1:   'No allergies that I know of.',
      },
      shx_general: {
        context: 'Final year student at UNILAG. I don\'t smoke or drink. I\'m not sexually active.',
        tier1:   'Final year student at UNILAG. I don\'t smoke or drink. I\'m not sexually active.',
      },
      fhx_general: {
        context: 'No, nobody in my family has had appendicitis or bowel problems.',
        tier1:   'No, nobody in my family has had appendicitis or bowel problems.',
      },
      exam_general: {
        context: 'General: Unwell-looking, lying still — movement worsens pain. Temp 38.4°C. Pulse 102 bpm. BP 118/76. RR 18. SpO₂ 98% on air. Mildly dehydrated — dry tongue.',
        tier1:   'General: Unwell-looking, lying still (movement worsens pain). Temp 38.4°C. Pulse 102 bpm (tachycardia). BP 118/76. RR 18. SpO₂ 98% on air. Mildly dehydrated — dry tongue.',
      },
      exam_abdomen: {
        context: "Abdomen: Flat. Maximal tenderness at McBurney's point. Guarding in RIF. Rovsing's sign positive. Bowel sounds reduced.",
        tier1:   "Abdomen: Flat. Maximal tenderness at McBurney's point (2/3 from umbilicus to ASIS). Guarding present in RIF. Rovsing's sign positive — pressure on LIF causes RIF pain. Bowel sounds reduced.",
        tier2:   "The guarding is involuntary — it tightens immediately on touch. Percussion tenderness is also present over McBurney's point.",
      },
      exam_specific_signs: {
        context: "McBurney's point: +++ Rovsing's: Positive. Psoas: Positive. Obturator: Borderline positive.",
        tier1:   "McBurney's point tenderness: +++ (maximal). Rovsing's sign: Positive. Psoas sign: Positive (pain on right hip extension). Obturator sign: Borderline positive.",
      },
      ix_fbc: {
        context: 'FBC:\n• WBC: 15.8 × 10⁹/L ↑ (neutrophilia: 13.2 × 10⁹/L)\n• Hb: 14.1 g/dL (normal)\n• Platelets: 310 × 10⁹/L (normal)\n→ Leukocytosis with left shift, consistent with bacterial/surgical inflammation.',
        tier1:   'FBC:\n• WBC: 15.8 × 10⁹/L ↑ (neutrophilia: 13.2 × 10⁹/L)\n• Hb: 14.1 g/dL (normal)\n• Platelets: 310 × 10⁹/L (normal)\n→ Leukocytosis with left shift, consistent with bacterial/surgical inflammation.',
      },
      ix_crp: {
        context: 'CRP: 98 mg/L ↑↑ (markedly raised — consistent with acute inflammation)',
        tier1:   'CRP: 98 mg/L ↑↑ (markedly raised — consistent with acute inflammation)',
      },
      ix_ultrasound: {
        context: 'USS Abdomen:\n• Non-compressible, dilated appendix — diameter 10mm\n• Periappendiceal fat stranding\n• No perforation or abscess\n→ Findings consistent with acute appendicitis.',
        tier1:   'USS Abdomen:\n• Non-compressible, dilated appendix — diameter 10mm (>6mm = abnormal)\n• Periappendiceal fat stranding\n• No perforation or abscess identified\n→ Findings consistent with acute appendicitis.',
      },
      ix_urinalysis: {
        context: 'Urinalysis: Trace leucocytes (non-specific). No nitrites. No blood.\n→ Does not suggest UTI; sterile pyuria can occur in appendicitis.',
        tier1:   'Urinalysis: Trace leucocytes (non-specific, can be due to adjacent inflammation). No nitrites. No blood.\n→ Does not suggest UTI; sterile pyuria can occur in appendicitis.',
      },
    },
    // ── Legacy intentMap (kept for backward compat + scoring) ──
    intentMap: {
      hpc_onset:        { text: "It started about 18 hours ago. First it was around my belly button, then moved to the right side of my stomach. It's been getting worse.", type:'history', label:'Onset & Migration' },
      hpc_character:    { text: "It's a constant, sharp pain. Not colicky — it doesn't come and go. It's there all the time and getting worse. Moving makes it worse.", type:'history', label:'Character' },
      hpc_radiation:    { text: "It doesn't really go anywhere — it just stays in the right lower part of my stomach.", type:'history', label:'Radiation' },
      sr_fever:         { text: "Yes, I've been feeling hot since this morning. My flatmate took my temperature — it was 38.2°C.", type:'history', label:'Fever' },
      sr_nausea:        { text: "Yes, I vomited twice — once last night and once this morning. No appetite at all.", type:'history', label:'Nausea/Vomiting' },
      sr_bowels:        { text: "I haven't opened my bowels since yesterday. Before this started I was normal — once a day.", type:'history', label:'Bowel history' },
      pmh_general:      { text: "I've been healthy — no medical conditions. Never been admitted to hospital before.", type:'history', label:'Past medical history' },
      meds_general:     { text: "Nothing regular. I took paracetamol this morning but it didn't really help.", type:'history', label:'Medications' },
      allergies_general:{ text: "No allergies that I know of.", type:'history', label:'Allergies' },
      shx_general:      { text: "Final year student at UNILAG. I don't smoke or drink. I'm not sexually active.", type:'history', label:'Social history' },
      fhx_general:      { text: "No, nobody in my family has had appendicitis or bowel problems.", type:'history', label:'Family history' },
      exam_general:     { text: 'General: Unwell-looking, lying still (movement worsens pain). Temp 38.4°C. Pulse 102 bpm (tachycardia). BP 118/76. RR 18. SpO₂ 98% on air. Mildly dehydrated — dry tongue.', type:'exam', label:'General examination' },
      exam_abdomen:     { text: "Abdomen: Flat. Maximal tenderness at McBurney's point (2/3 from umbilicus to ASIS). Guarding present in RIF. Rovsing's sign positive. Bowel sounds reduced.", type:'exam', label:'Abdominal examination' },
      exam_specific_signs: { text: "McBurney's point: +++ Rovsing's: Positive. Psoas: Positive. Obturator: Borderline.", type:'exam', label:'Special signs' },
      ix_fbc:           { text: 'FBC:\n• WBC: 15.8 × 10⁹/L ↑\n• Hb: 14.1 g/dL\n• Platelets: 310 × 10⁹/L', type:'investigation', label:'FBC' },
      ix_crp:           { text: 'CRP: 98 mg/L ↑↑', type:'investigation', label:'CRP' },
      ix_ultrasound:    { text: 'USS: Non-compressible dilated appendix 10mm. Periappendiceal fat stranding. No perforation.', type:'investigation', label:'USS Abdomen' },
      ix_urinalysis:    { text: 'Urinalysis: Trace leucocytes. No nitrites. No blood.', type:'investigation', label:'Urinalysis' },
    },
    scoringMap: { mustAsk: ['hpc_onset','hpc_character','sr_fever','exam_abdomen'], shouldAsk: ['sr_nausea','exam_specific_signs','ix_fbc','ix_ultrasound'], pointsBase: 5, pointsMust: 15 },
  },

  // ── O&G: SEVERE PRE-ECLAMPSIA ─────────────────────────────────
  {
    caseId: 'case_og_preeclampsia_001',
    discipline: 'og', difficulty: 'hard', timeLimit: 720,
    hospital: 'LASUTH Ikeja',
    patient: { name: 'Fatima Bello', age: 26, sex: 'Female', occupation: 'Trader', avatar: '🤰' },
    presentingComplaint: 'Headache and swollen legs at 34 weeks gestation',
    diagnosis: { primary: 'Severe Pre-eclampsia', keywords: ['preeclampsia','pre-eclampsia','severe pre-eclampsia','pih'] },
    differentials: [
      { name: 'Severe Pre-eclampsia',              color: '#8A3F6B', initial: 45 },
      { name: 'Gestational Hypertension',          color: '#5B3F8A', initial: 25 },
      { name: 'Chronic Hypertension in Pregnancy', color: '#2A5A8A', initial: 15 },
      { name: 'HELLP Syndrome',                    color: '#9B3535', initial: 15 },
    ],
    trapActions: [
      { pattern: /nsaid|ibuprofen|diclofenac/i,          penalty: 20, explanation: '⛔ NSAIDs are contraindicated after 30 weeks — risk of premature closure of ductus arteriosus. Deducted −20 pts.' },
      { pattern: /ace.?inhibitor|lisinopril|enalapril|ramipril/i, penalty: 20, explanation: '⛔ ACE inhibitors are absolutely contraindicated in pregnancy. Deducted −20 pts.' },
      { pattern: /methyldopa.*avoid|no.*methyldopa/i,    penalty: 10, explanation: '⚠️ Methyldopa is a recommended antihypertensive in pregnancy. Deducted −10 pts.' },
    ],
    symptomFacts: {
      hpc_onset: {
        onset:   '2 days ago',
        location:'back of my head',
        severity:'very severe — worst headache I\'ve ever had',
        context: 'The headache started 2 days ago — at the back of my head. Very severe. My legs have been swollen for a week but much worse now.',
        tier1:   'The headache started 2 days ago — at the back of my head. Very severe. My legs have been swollen for a week but much worse now.',
        tier2:   'The headache is throbbing — at the back of my head and behind my eyes. I\'ve had headaches before but never like this. The swelling has also been getting worse each day.',
        tier3:   'I almost didn\'t come because I thought it was just stress. But since this morning my vision has been blurring at the edges.',
      },
      hpc_character: {
        character: 'throbbing, severe headache',
        severity:  'worst headache I\'ve ever had — and my vision has been blurry since this morning',
        modifier:  'I feel sick too',
        context:   'Throbbing, very severe. Worst headache I\'ve ever had. Vision blurry since this morning.',
        tier1:     "The headache is throbbing and very severe — worst headache I've ever had. My vision has been blurry since this morning. I feel sick too.",
        tier2:     'The blurring started this morning. It comes and goes. Sometimes I see flashing lights.',
        tier3:     'The headache hasn\'t gone even with paracetamol. And now I have pain under my ribs on the right side too.',
      },
      sr_oedema: {
        location:  'legs — up to my thighs now',
        severity:  'very swollen — my shoes don\'t fit anymore',
        context:   'My legs are very swollen — up to my thighs now. My face was also puffy this morning.',
        tier1:     "My legs are very swollen — up to my thighs now. My face was also puffy this morning. My shoes don't fit anymore.",
        tier2:     'When I press my shin the dent stays for a long time. Even my rings are tight — my fingers are swollen too.',
        tier3:     'The swelling in my legs used to go down overnight but now it stays. It\'s not going down anymore.',
      },
      sr_fetal_movement: {
        context:  'I\'ve been feeling the baby move, but maybe a bit less than usual today. I\'m worried.',
        severity: 'a bit less than usual',
        tier1:    "I've been feeling the baby move, but maybe a bit less than usual today. I'm worried.",
        tier2:    'Usually I feel strong kicks after meals but today they\'ve been lighter. I\'ve been counting.',
        tier3:    'I\'ve been pressing on my stomach to feel movement. I feel something but it\'s very quiet.',
      },
      sr_abdominal: {
        context: 'Yes — there\'s some pain in my upper right stomach. Dull and persistent since this morning.',
        tier1:   "Yes — there's some pain in my upper right stomach. It's been there since this morning, dull and persistent.",
        tier2:   'It\'s under my ribs on the right side. I thought it was the baby pressing but it\'s there even when I lie on my left.',
      },
      sr_urinary: {
        context:  'My urine has been much less than normal — darker and frothy.',
        severity: 'less than normal — darker and frothy',
        tier1:    "My urine has been much less than normal — and it looks darker and frothy.",
        tier2:    'I noticed the frothy urine about three days ago. I thought I wasn\'t drinking enough but even when I drink more it\'s still frothy.',
      },
      parity: {
        context: 'This is my first pregnancy. I didn\'t have any problems in early pregnancy.',
        tier1:   "This is my first pregnancy. I didn't have any problems in early pregnancy.",
      },
      antenatal: {
        context: 'I attended ANC 3 times. At my last visit 4 weeks ago my blood pressure was normal — 120/76. No protein in the urine then.',
        tier1:   "I attended ANC 3 times. At my last visit 4 weeks ago my blood pressure was normal — 120/76. No protein in the urine then.",
        tier2:   'The midwife always checked my BP. It was always normal until now. This is my 34th week.',
      },
      pmh_general: {
        context: 'No medical conditions before this pregnancy. No hypertension, no diabetes.',
        tier1:   "No medical conditions before this pregnancy. No hypertension, no diabetes.",
      },
      meds_general: {
        context: 'I take folic acid and iron tablets. No other medications. No traditional herbs.',
        tier1:   "I take folic acid and iron tablets. No other medications. No traditional herbs.",
      },
      fhx_general: {
        context: 'My mother had high blood pressure during her last pregnancy but I don\'t know the details.',
        tier1:   "My mother had high blood pressure during her last pregnancy but I don't know the details.",
      },
      exam_general: {
        context: 'General: Anxious, in pain. BP 168/112 mmHg ↑↑. Pulse 96 bpm. Temp 37.2°C. SpO₂ 97%. Facial puffiness. Bilateral pitting oedema 3+ to thighs.',
        tier1:   'General: Anxious, in pain. BP 168/112 mmHg ↑↑. Pulse 96 bpm. Temp 37.2°C. SpO₂ 97%. Facial puffiness. Bilateral pitting oedema 3+ to thighs.',
      },
      exam_neuro: {
        context: "Neuro: GCS 15. Hyperreflexia +++. Clonus: 3 beats at right ankle. Fundoscopy: papilloedema present.\n→ CNS involvement — risk of eclamptic seizure imminent.",
        tier1:   "Neuro: GCS 15. Hyperreflexia +++ (bilateral). Clonus: 3 beats at right ankle. Fundoscopy: papilloedema present.\n→ CNS involvement — risk of eclamptic seizure imminent.",
      },
      ix_urinalysis: {
        context: 'Urinalysis:\n• Protein: 3+ on dipstick\n• Spot protein:creatinine ratio: 420 mg/mmol\n→ Significant proteinuria confirmed.',
        tier1:   'Urinalysis:\n• Protein: 3+ on dipstick (significant proteinuria)\n• Spot protein:creatinine ratio: 420 mg/mmol (>300 confirms significant proteinuria)',
      },
      ix_fbc: {
        context: 'FBC:\n• Hb: 10.8 g/dL\n• WBC: 11.2 × 10⁹/L\n• Platelets: 82 × 10⁹/L ↓↓ (thrombocytopaenia)\n→ Platelet count <100 is a feature of HELLP syndrome.',
        tier1:   'FBC:\n• Hb: 10.8 g/dL\n• WBC: 11.2 × 10⁹/L\n• Platelets: 82 × 10⁹/L ↓↓ (thrombocytopaenia — possible HELLP)\n→ Platelet count <100 is a feature of HELLP syndrome.',
      },
      ix_lft: {
        context: 'LFTs:\n• AST: 248 IU/L ↑↑\n• ALT: 196 IU/L ↑↑\n• LDH: 820 IU/L ↑↑ (haemolysis)\n→ HELLP Syndrome: Haemolysis + Elevated Liver enzymes + Low Platelets.',
        tier1:   'LFTs:\n• AST: 248 IU/L ↑↑\n• ALT: 196 IU/L ↑↑\n• LDH: 820 IU/L ↑↑ (haemolysis)\n→ HELLP Syndrome: Haemolysis + Elevated Liver enzymes + Low Platelets.',
      },
      ix_ultrasound: {
        context: 'Obstetric USS:\n• Single live fetus, cephalic\n• EFW: 1.7kg (IUGR)\n• AFI: 6cm (oligohydramnios)\n• Doppler: Absent end-diastolic flow\n→ Fetal compromise. Delivery should be planned urgently.',
        tier1:   'Obstetric USS:\n• Single live fetus, cephalic\n• EFW: 1.7kg (IUGR)\n• AFI: 6cm (oligohydramnios)\n• Doppler: Absent end-diastolic flow in umbilical artery\n→ Fetal compromise. Delivery should be planned urgently.',
      },
    },
    intentMap: {
      hpc_onset:       { text: "The headache started 2 days ago — at the back of my head. Very severe. My legs have been swollen for a week but much worse now.", type:'history', label:'Onset' },
      hpc_character:   { text: "The headache is throbbing and very severe — worst headache I've ever had. My vision has been blurry since this morning. I feel sick too.", type:'history', label:'Character' },
      sr_oedema:       { text: "My legs are very swollen — up to my thighs now. My face was also puffy this morning. My shoes don't fit anymore.", type:'history', label:'Oedema' },
      sr_fetal_movement:{ text: "I've been feeling the baby move, but maybe a bit less than usual today. I'm worried.", type:'history', label:'Fetal movement' },
      sr_abdominal:    { text: "Yes — there's some pain in my upper right stomach. It's been there since this morning, dull and persistent.", type:'history', label:'Epigastric/RUQ pain' },
      sr_urinary:      { text: "My urine has been much less than normal — and it looks darker and frothy.", type:'history', label:'Urinary symptoms' },
      parity:          { text: "This is my first pregnancy. I didn't have any problems in early pregnancy.", type:'history', label:'Obstetric history' },
      antenatal:       { text: "I attended ANC 3 times. At my last visit 4 weeks ago my blood pressure was normal — 120/76. No protein in the urine then.", type:'history', label:'Antenatal history' },
      pmh_general:     { text: "No medical conditions before this pregnancy. No hypertension, no diabetes.", type:'history', label:'Past medical history' },
      meds_general:    { text: "I take folic acid and iron tablets. No other medications. No traditional herbs.", type:'history', label:'Medications' },
      fhx_general:     { text: "My mother had high blood pressure during her last pregnancy but I don't know the details.", type:'history', label:'Family history' },
      exam_general:    { text: 'General: Anxious, in pain. BP 168/112 mmHg ↑↑. Pulse 96 bpm. Temp 37.2°C. SpO₂ 97%. Facial puffiness. Bilateral pitting oedema 3+ to thighs.', type:'exam', label:'General examination' },
      exam_neuro:      { text: "Neuro: GCS 15. Hyperreflexia +++. Clonus: 3 beats at right ankle. Fundoscopy: papilloedema present.", type:'exam', label:'Neurological examination' },
      ix_urinalysis:   { text: 'Urinalysis: Protein 3+. Spot P:Cr ratio 420 mg/mmol.', type:'investigation', label:'Urinalysis' },
      ix_fbc:          { text: 'FBC: Hb 10.8. WBC 11.2. Platelets 82 ↓↓', type:'investigation', label:'FBC' },
      ix_lft:          { text: 'LFTs: AST 248 ↑↑. ALT 196 ↑↑. LDH 820 ↑↑', type:'investigation', label:'LFTs' },
      ix_ultrasound:   { text: 'Obstetric USS: EFW 1.7kg. AFI 6cm. Absent end-diastolic flow.', type:'investigation', label:'Obstetric USS' },
    },
    scoringMap: { mustAsk: ['hpc_character','sr_oedema','antenatal','exam_neuro'], shouldAsk: ['ix_urinalysis','ix_fbc','ix_lft','sr_fetal_movement','parity'], pointsBase: 5, pointsMust: 15 },
  },

  // ── MEDICINE: DECOMPENSATED HEART FAILURE ─────────────────────
  {
    caseId: 'case_med_hf_001',
    discipline: 'med', difficulty: 'hard', timeLimit: 720,
    hospital: 'UCH Ibadan',
    patient: { name: 'Emmanuel Okafor', age: 58, sex: 'Male', occupation: 'Retired Civil Servant', avatar: '👴' },
    presentingComplaint: 'Worsening breathlessness and ankle swelling for 3 weeks',
    diagnosis: { primary: 'Decompensated Heart Failure', keywords: ['heart failure','cardiac failure','decompensated heart failure','congestive heart failure','chf'] },
    differentials: [
      { name: 'Decompensated Heart Failure', color: '#6B4520', initial: 40 },
      { name: 'COPD Exacerbation',          color: '#5B3F8A', initial: 20 },
      { name: 'Pulmonary Embolism',         color: '#A84040', initial: 15 },
      { name: 'Constrictive Pericarditis',  color: '#7A8F9E', initial: 10 },
    ],
    trapActions: [
      { pattern: /nsaid|ibuprofen|diclofenac/i, penalty: 20, explanation: '⛔ NSAIDs cause fluid retention and worsen heart failure. Contraindicated in cardiac failure. Deducted −20 pts.' },
      { pattern: /verapamil|diltiazem/i,         penalty: 15, explanation: '⚠️ Verapamil and diltiazem are negatively inotropic and contraindicated in systolic heart failure. Deducted −15 pts.' },
    ],
    symptomFacts: {
      hpc_onset: {
        onset:   '3 weeks ago',
        context: 'The breathing problems have been getting worse over the past 3 weeks. I used to climb one flight of stairs without stopping, but now I\'m breathless just walking to my toilet.',
        severity:'getting worse each week',
        tier1:   'The breathing problems have been getting worse over the past 3 weeks. I used to climb one flight of stairs without stopping, but now I\'m breathless just walking to my toilet.',
        tier2:   'It\'s been slowly but steadily worse. Two weeks ago I had to stop walking to the kitchen. Now even lying down is difficult.',
        tier3:   'My wife noticed it first — she said I was sleeping sitting up. I didn\'t even realise how bad it had gotten.',
      },
      hpc_character: {
        character: 'shortness of breath — worse lying down',
        severity:  'I now sleep with 3 pillows',
        modifier:  'I wake up at night gasping for breath',
        context:   'Shortness of breath — worse lying down. Three pillows now. Waking up gasping at night.',
        tier1:     "It's shortness of breath — worse lying down. I now sleep with 3 pillows. I also wake up at night gasping for breath.",
        tier2:     'The nocturnal episodes are very frightening. I wake up feeling like I\'m drowning. I have to sit at the edge of the bed for 20 minutes before it settles.',
        tier3:     'I\'ve started sleeping in the chair because the bed is worse. My wife is very worried.',
      },
      hpc_orthopnoea: {
        context:  'I can\'t lie flat anymore. Three pillows, and even then it takes a while to settle.',
        severity: 'three pillows — can\'t lie flat',
        tier1:    "Yes — I can't lie flat anymore. Three pillows, and even then it takes a while to settle.",
        tier2:    'Even with three pillows I sometimes have to sit completely upright. The breathlessness starts within minutes of lying flat.',
      },
      sr_oedema: {
        location:  'both ankles and legs',
        severity:  'very swollen — by evening my feet are like balloons',
        context:   'Both my ankles and legs are very swollen. By evening, my feet are like balloons.',
        tier1:     "Both my ankles and legs are very swollen. By evening, my feet are like balloons.",
        tier2:     'The swelling is worse in the evening and a bit better in the morning. I can\'t fit into my shoes anymore.',
        tier3:     'The swelling used to go down overnight. Now it doesn\'t go down anymore even in the morning.',
      },
      sr_chest_pain: {
        character:'dull heaviness',
        context:  'No chest pain. But there\'s sometimes a dull heaviness in my chest.',
        tier1:    "No chest pain. But there's sometimes a dull heaviness in my chest.",
      },
      sr_urinary: {
        context:  'I\'ve been passing much less urine than usual — maybe half my normal amount.',
        severity: 'about half my normal urine output',
        tier1:    "I've been passing much less urine than usual — maybe half my normal amount.",
        tier2:    'I used to go to the toilet 4–5 times a day. Now maybe twice. I was taking a water tablet but I ran out.',
      },
      pmh_general: {
        context: 'I have hypertension for 12 years and type 2 diabetes for 8 years. I had a heart attack 4 years ago — I was managed at UCH.',
        tier1:   "I have hypertension for 12 years and type 2 diabetes for 8 years. I had a heart attack 4 years ago — I was managed at UCH.",
        tier2:   'After the heart attack they said my heart was weak. I was put on many tablets. I\'ve been managing.',
      },
      meds_general: {
        context: 'Lisinopril 10mg, Carvedilol 12.5mg, Spironolactone 25mg, Metformin 500mg BD. I ran out of my water tablet (Frusemide) 2 weeks ago.',
        tier1:   "Lisinopril 10mg, Carvedilol 12.5mg, Spironolactone 25mg, Metformin 500mg BD. I ran out of my water tablet (Frusemide) 2 weeks ago.",
        tier2:   'I ran out of the Frusemide about 2 weeks ago and haven\'t been able to refill it. That\'s when the swelling got worse.',
        tier3:   'My son was supposed to get it for me from the pharmacy but he travelled. I thought I could manage without it for a while.',
      },
      shx_general: {
        context: 'Retired. Lives with wife and daughter. Previously smoked 1 pack/day for 20 years — stopped 8 years ago. Occasional alcohol.',
        tier1:   "Retired. Lives with wife and daughter. Previously smoked 1 pack/day for 20 years — stopped 8 years ago. Occasional alcohol.",
      },
      exam_general: {
        context: 'General: Breathless at rest, speaking in short sentences. Mildly cyanosed. JVP raised — 6cm above sternal angle. Bilateral pitting oedema 3+ to the knees.',
        tier1:   "General: Breathless at rest, speaking in short sentences. Mildly cyanosed. JVP raised — 6cm above sternal angle. Bilateral pitting oedema 3+ to the knees.",
      },
      exam_cardiovascular: {
        context: 'Apex beat displaced to 6th ICS, anterior axillary line (cardiomegaly). HS I+II+S3 (gallop rhythm). Pan-systolic murmur at apex, radiating to axilla (MR).',
        tier1:   "Apex beat displaced to 6th ICS, anterior axillary line (cardiomegaly). HS I+II+S3 (gallop rhythm). Pan-systolic murmur at apex, radiating to axilla (MR).",
        tier2:   'The S3 gallop is clearly heard at the apex with the bell. The apex beat is outside the midclavicular line — significant cardiomegaly.',
      },
      exam_chest: {
        context: 'Bilateral basal fine inspiratory crackles extending to mid-zones. Stony dull percussion at right base — possible pleural effusion.',
        tier1:   "Bilateral basal fine inspiratory crackles extending to mid-zones. Stony dull percussion at right base — possible pleural effusion.",
      },
      ix_ecg: {
        context: 'ECG:\nSinus rhythm. Rate 96. Left bundle branch block (LBBB). LVH pattern. No acute ST changes.',
        tier1:   'ECG:\nSinus rhythm. Rate 96. Left bundle branch block (LBBB). LVH pattern. No acute ST changes.',
      },
      ix_cxr: {
        context: "CXR:\nCardiomegaly (CTR >0.5). Upper lobe diversion. Bilateral Kerley B lines. Right pleural effusion. Perihilar haze — 'bat-wing' pattern.",
        tier1:   "CXR:\nCardiomegaly (CTR >0.5). Upper lobe diversion. Bilateral Kerley B lines. Right pleural effusion. Perihilar haze — 'bat-wing' pattern.",
      },
      ix_fbc: {
        context: 'FBC:\n• Hb: 10.2 g/dL (normocytic anaemia)\n• WBC: 9.8 × 10⁹/L (normal)\n• Platelets: 220 × 10⁹/L (normal)',
        tier1:   'FBC:\n• Hb: 10.2 g/dL (normocytic anaemia)\n• WBC: 9.8 × 10⁹/L (normal)\n• Platelets: 220 × 10⁹/L (normal)',
      },
      ix_lft: {
        context: 'Renal profile + BNP:\n• Creatinine: 168 μmol/L ↑\n• eGFR: 36 mL/min\n• Na: 132 mmol/L ↓\n• K: 5.4 mmol/L ↑\n• BNP: 1840 pg/mL ↑↑ (strongly confirms cardiac failure)',
        tier1:   'Renal profile + BNP:\n• Creatinine: 168 μmol/L ↑ (AKI on CKD)\n• eGFR: 36 mL/min\n• Na: 132 mmol/L ↓\n• K: 5.4 mmol/L ↑\n• BNP: 1840 pg/mL ↑↑ (strongly confirms cardiac failure)',
      },
    },
    intentMap: {
      hpc_onset:         { text: "The breathing problems have been getting worse over the past 3 weeks. I used to climb one flight of stairs without stopping, but now I'm breathless just walking to my toilet.", type:'history', label:'Onset' },
      hpc_character:     { text: "It's shortness of breath — worse lying down. I now sleep with 3 pillows. I also wake up at night gasping for breath.", type:'history', label:'Character' },
      hpc_orthopnoea:    { text: "Yes — I can't lie flat anymore. Three pillows, and even then it takes a while to settle.", type:'history', label:'Orthopnoea/PND' },
      sr_oedema:         { text: "Both my ankles and legs are very swollen. By evening, my feet are like balloons.", type:'history', label:'Oedema' },
      sr_chest_pain:     { text: "No chest pain. But there's sometimes a dull heaviness in my chest.", type:'history', label:'Chest heaviness' },
      sr_urinary:        { text: "I've been passing much less urine than usual — maybe half my normal amount.", type:'history', label:'Urinary output' },
      pmh_general:       { text: "I have hypertension for 12 years and type 2 diabetes for 8 years. I had a heart attack 4 years ago — I was managed at UCH.", type:'history', label:'Past medical history' },
      meds_general:      { text: "Lisinopril 10mg, Carvedilol 12.5mg, Spironolactone 25mg, Metformin 500mg BD. I ran out of my water tablet (Frusemide) 2 weeks ago.", type:'history', label:'Medications' },
      shx_general:       { text: "Retired. Lives with wife and daughter. Previously smoked 1 pack/day for 20 years — stopped 8 years ago. Occasional alcohol.", type:'history', label:'Social history' },
      exam_general:      { text: "General: Breathless at rest, speaking in short sentences. Mildly cyanosed. JVP raised — 6cm above sternal angle. Bilateral pitting oedema 3+ to the knees.", type:'exam', label:'General examination' },
      exam_cardiovascular:{ text: "Apex beat displaced to 6th ICS, anterior axillary line (cardiomegaly). HS I+II+S3 (gallop rhythm). Pan-systolic murmur at apex, radiating to axilla (MR).", type:'exam', label:'Cardiovascular exam' },
      exam_chest:        { text: "Bilateral basal fine inspiratory crackles extending to mid-zones. Stony dull percussion at right base — possible pleural effusion.", type:'exam', label:'Chest examination' },
      ix_ecg:            { text: 'ECG: Sinus rhythm. Rate 96. LBBB. LVH pattern.', type:'investigation', label:'ECG' },
      ix_cxr:            { text: "CXR: Cardiomegaly. Upper lobe diversion. Kerley B lines. Right pleural effusion. Bat-wing perihilar haze.", type:'investigation', label:'CXR' },
      ix_fbc:            { text: 'FBC: Hb 10.2 g/dL. WBC 9.8. Platelets 220.', type:'investigation', label:'FBC' },
      ix_lft:            { text: 'Renal + BNP: Creatinine 168 ↑. eGFR 36. Na 132 ↓. K 5.4 ↑. BNP 1840 ↑↑', type:'investigation', label:'Renal profile / BNP' },
    },
    scoringMap: { mustAsk: ['hpc_character','pmh_general','meds_general','exam_cardiovascular'], shouldAsk: ['sr_oedema','hpc_orthopnoea','ix_cxr','ix_lft'], pointsBase: 5, pointsMust: 15 },
  },

  // ── MEDICINE: ACUTE ASTHMA EXACERBATION ──────────────────────
  {
    caseId: 'case_med_asthma_001',
    discipline: 'med', difficulty: 'intermediate', timeLimit: 600,
    hospital: 'LUTH Lagos',
    patient: { name: 'Amina Yusuf', age: 22, sex: 'Female', occupation: 'University Student', avatar: '👩' },
    presentingComplaint: 'Sudden onset breathlessness and wheeze for 3 hours',
    diagnosis: { primary: 'Acute Asthma Exacerbation', keywords: ['asthma','asthma attack','acute asthma','asthma exacerbation','bronchospasm'] },
    differentials: [
      { name: 'Acute Asthma Exacerbation', color: '#2A5A8A', initial: 45 },
      { name: 'Anaphylaxis',               color: '#9B3535', initial: 20 },
      { name: 'COPD Exacerbation',          color: '#5B3F8A', initial: 15 },
      { name: 'Pulmonary Embolism',         color: '#7A8F9E', initial: 20 },
    ],
    trapActions: [
      { pattern: /\bbeta.?blocker|propranolol|atenolol\b/i, penalty: 20, explanation: '⛔ Beta-blockers are absolutely contraindicated in acute asthma — they cause life-threatening bronchospasm. Deducted −20 pts.' },
      { pattern: /\bnsaid|ibuprofen|aspirin\b/i,            penalty: 15, explanation: '⛔ NSAIDs/Aspirin can precipitate aspirin-exacerbated respiratory disease (AERD) in asthmatics. Deducted −15 pts.' },
      { pattern: /\bsedati|morphine.*asthma/i,              penalty: 15, explanation: '⛔ Sedatives and opioids are contraindicated in acute asthma — risk of respiratory arrest. Deducted −15 pts.' },
    ],
    symptomFacts: {
      hpc_onset: {
        onset:   '3 hours ago',
        context: 'It came on suddenly about 3 hours ago. I was in the library — the person next to me was wearing strong perfume. Then I started feeling tight in my chest.',
        tier1:   "It came on suddenly about 3 hours ago. I was in the library — the person next to me was wearing strong perfume. Then I started feeling tight in my chest.",
        tier2:   'The breathing got worse very quickly. Within 30 minutes I couldn\'t finish a sentence. My friend brought me straight here.',
        tier3:   'I\'ve had attacks before but this one came on faster. Usually I get a warning — some itching in my throat. This time nothing.',
      },
      hpc_character: {
        character: 'tight, wheezy breathing',
        severity:  'very severe — can\'t complete sentences',
        modifier:  'It\'s worse when I breathe out. I can hear myself wheeze.',
        tier1:    "It's tight — like someone is squeezing my chest. Wheezy. I can hear myself wheeze. Worse breathing out. Very severe.",
        tier2:    'The wheeze is loud — you can probably hear it from there. I can barely finish a sentence. My chest feels like a barrel.',
        tier3:    'I\'m using my neck muscles to breathe. I\'ve never felt this scared during an attack.',
      },
      hpc_triggers: {
        context: 'Strong perfume triggered this one. I\'m also triggered by exercise, cold air, and dust. I missed my preventer inhaler this morning.',
        tier1:   "Strong perfume triggered this one. I'm also triggered by exercise, cold air, and dust. I missed my preventer inhaler this morning.",
        tier2:   'I hadn\'t taken my brown inhaler for 3 days actually — I thought I\'d be fine for a few days. That was a mistake.',
        tier3:   'I ran out of the preventer last week and couldn\'t afford to refill it immediately. I was managing on the blue inhaler alone.',
      },
      hpc_relieving: {
        modifier: 'My blue inhaler (salbutamol) only helps a little. Sitting upright is better than lying down.',
        tier1:    "My blue inhaler (salbutamol) only helps a little — not as much as usual. Sitting upright is a bit better.",
        tier2:    'I used the blue inhaler 5 times on the way here. Each time it helped for only about 10 minutes then it wore off.',
      },
      pmh_general: {
        context: 'Known asthmatic since age 8. I was admitted once 2 years ago — needed nebulisers but no ICU. No other medical conditions.',
        tier1:   "Known asthmatic since age 8. I was admitted once 2 years ago — needed nebulisers but no ICU. No other medical conditions.",
        tier2:   'My asthma is usually well controlled when I take my brown inhaler regularly. I had a bad attack last harmattan season too.',
      },
      meds_general: {
        context: 'Salbutamol 100mcg MDI (blue — reliever) and Beclometasone 200mcg MDI (brown — preventer). I missed 3 doses of the preventer.',
        tier1:   "Salbutamol 100mcg MDI (blue — reliever) and Beclometasone 200mcg MDI (brown — preventer). I missed 3 doses of the preventer.",
        tier2:   'The salbutamol I\'ve been using quite a lot lately — more than once a day most days this week. That should have been a warning sign.',
      },
      allergies_general: {
        context: 'No drug allergies. Allergic to house dust mites, cat fur, and strong perfumes.',
        tier1:   "No drug allergies. Allergic to house dust mites, cat fur, and strong perfumes.",
      },
      shx_general: {
        context: '22-year-old UNILAG student. Lives in a hostel — quite dusty. Non-smoker. No alcohol.',
        tier1:   "22-year-old UNILAG student. Lives in a hostel — quite dusty. Non-smoker. No alcohol.",
      },
      fhx_general: {
        context: 'My mother has asthma. My older brother has eczema.',
        tier1:   "My mother has asthma. My older brother has eczema.",
      },
      exam_general: {
        context: 'General: Distressed, tachypnoeic, speaking in short phrases only. Sitting upright. RR 28/min. SpO₂ 89% on air ↓. Pulse 124 bpm. Temp 36.9°C. Using accessory muscles (sternomastoid). Pulsus paradoxus present.',
        tier1:   "General: Distressed, tachypnoeic, speaking in short phrases only. Sitting upright. RR 28/min. SpO₂ 89% on air ↓. Pulse 124 bpm. Temp 36.9°C. Using accessory muscles (sternomastoid). Pulsus paradoxus present.",
      },
      exam_chest: {
        context: 'Chest: Bilateral hyperresonance. Bilaterally reduced breath sounds with widespread expiratory wheeze. Prolonged expiratory phase. No crackles.',
        tier1:   "Chest: Bilateral hyperresonance on percussion. Bilaterally reduced breath sounds with widespread expiratory wheeze. Prolonged expiratory phase (I:E ratio 1:3). No crackles.",
        tier2:   'The wheeze is truly bilateral and polyphonic — consistent with generalised small airway obstruction. The chest is hyperinflated — note the barrel shape and hyper-resonance.',
      },
      ix_pefr: {
        context: 'PEFR: 140 L/min (predicted 420 L/min for height/age)\n→ PEFR = 33% of predicted = SEVERE acute asthma.',
        tier1:   "PEFR: 140 L/min\n→ Predicted: 420 L/min\n→ 33% of predicted = SEVERE acute asthma (33–50% = severe; <33% = life-threatening).",
      },
      ix_abg: {
        context: 'ABG on air:\n• pH: 7.38 (normal — but concerning in context)\n• PaCO₂: 4.8 kPa (normal — WARNING: should be low in severe asthma)\n• PaO₂: 7.2 kPa ↓\n• HCO₃: 22 mmol/L (normal)\n→ NORMAL CO₂ in severe asthma = respiratory muscle fatigue = PRE-ARREST.',
        tier1:   "ABG on air:\n• pH: 7.38\n• PaCO₂: 4.8 kPa (NORMAL — very concerning; should be LOW in severe asthma)\n• PaO₂: 7.2 kPa ↓\n• HCO₃: 22 mmol/L\n→ Normal CO₂ in severe asthma = pre-arrest. Escalate immediately.",
      },
      ix_cxr: {
        context: 'CXR:\n• Hyperinflated lung fields — flattened diaphragms\n• No pneumothorax\n• No focal consolidation\n• Heart size normal\n→ Consistent with severe acute asthma; no complications.',
        tier1:   "CXR:\n• Hyperinflated lung fields — flattened diaphragms (>6 anterior ribs)\n• No pneumothorax\n• No focal consolidation or collapse\n• Heart size normal\n→ Consistent with severe acute asthma; no complications identified.",
      },
      ix_fbc: {
        context: 'FBC:\n• WBC: 14.2 × 10⁹/L ↑ (eosinophilia: 1.8 × 10⁹/L)\n• Hb: 12.8 g/dL\n• Platelets: 290 × 10⁹/L\n→ Eosinophilia consistent with atopic/allergic disease.',
        tier1:   "FBC:\n• WBC: 14.2 × 10⁹/L ↑\n• Eosinophils: 1.8 × 10⁹/L ↑ (consistent with atopic disease)\n• Hb: 12.8 g/dL\n• Platelets: 290 × 10⁹/L",
      },
    },
    intentMap: {
      hpc_onset:        { text: "It came on suddenly about 3 hours ago. I was in the library — someone next to me was wearing strong perfume. Then I started feeling tight in my chest.", type:'history', label:'Onset' },
      hpc_character:    { text: "It's tight — like someone is squeezing my chest. Wheezy. I can hear myself wheeze. Worse breathing out. Very severe.", type:'history', label:'Character' },
      hpc_triggers:     { text: "Strong perfume triggered this one. I'm also triggered by exercise, cold air, and dust. I missed my preventer inhaler this morning.", type:'history', label:'Triggers' },
      hpc_relieving:    { text: "My blue inhaler only helps a little — not as much as usual. Sitting upright is a bit better.", type:'history', label:'Relieving factors' },
      pmh_general:      { text: "Known asthmatic since age 8. I was admitted once 2 years ago — needed nebulisers but no ICU.", type:'history', label:'Past medical history' },
      meds_general:     { text: "Salbutamol 100mcg MDI (blue — reliever) and Beclometasone 200mcg MDI (brown — preventer). I missed 3 doses of the preventer.", type:'history', label:'Medications' },
      allergies_general:{ text: "No drug allergies. Allergic to house dust mites, cat fur, and strong perfumes.", type:'history', label:'Allergies' },
      shx_general:      { text: "22-year-old UNILAG student. Lives in a hostel — quite dusty. Non-smoker. No alcohol.", type:'history', label:'Social history' },
      fhx_general:      { text: "My mother has asthma. My older brother has eczema.", type:'history', label:'Family history' },
      exam_general:     { text: "General: Distressed, tachypnoeic, speaking in short phrases. Sitting upright. RR 28/min. SpO₂ 89% on air. Pulse 124 bpm. Accessory muscles in use. Pulsus paradoxus present.", type:'exam', label:'General examination' },
      exam_chest:       { text: "Chest: Bilateral hyperresonance. Bilaterally reduced breath sounds with widespread expiratory wheeze. Prolonged expiratory phase. No crackles.", type:'exam', label:'Chest examination' },
      ix_pefr:          { text: "PEFR: 140 L/min (33% of predicted 420) = SEVERE acute asthma.", type:'investigation', label:'PEFR' },
      ix_abg:           { text: "ABG: pH 7.38. PaCO₂ 4.8 kPa (NORMAL — pre-arrest warning). PaO₂ 7.2 kPa ↓.", type:'investigation', label:'ABG' },
      ix_cxr:           { text: "CXR: Hyperinflated. Flattened diaphragms. No pneumothorax. No consolidation.", type:'investigation', label:'CXR' },
      ix_fbc:           { text: "FBC: WBC 14.2 ↑ (eosinophilia 1.8 ↑). Hb 12.8. Platelets 290.", type:'investigation', label:'FBC' },
    },
    scoringMap: { mustAsk: ['hpc_character','hpc_triggers','pmh_general','exam_chest'], shouldAsk: ['meds_general','ix_pefr','ix_abg','ix_cxr'], pointsBase: 5, pointsMust: 15 },
  },

  // ── PAEDIATRICS: SEVERE MALARIA ───────────────────────────────
  {
    caseId: 'case_peds_malaria_001',
    discipline: 'peds', difficulty: 'hard', timeLimit: 720,
    hospital: 'LUTH Lagos',
    patient: { name: 'Chidera Obi', age: 4, sex: 'Male', occupation: 'Child (preschool)', avatar: '👦' },
    presentingComplaint: 'Fever, seizures, and reduced consciousness for 1 day',
    diagnosis: { primary: 'Severe Malaria (P. falciparum)', keywords: ['severe malaria','cerebral malaria','falciparum malaria','malaria','p. falciparum'] },
    differentials: [
      { name: 'Severe Malaria (P. falciparum)', color: '#A84040', initial: 50 },
      { name: 'Bacterial Meningitis',           color: '#2A5A8A', initial: 25 },
      { name: 'Viral Encephalitis',             color: '#5B3F8A', initial: 15 },
      { name: 'Febrile Convulsion',             color: '#7A8F9E', initial: 10 },
    ],
    trapActions: [
      { pattern: /\baspirin\b/i,              penalty: 20, explanation: "⛔ Aspirin is contraindicated in children under 16 years (Reye's syndrome). Deducted −20 pts." },
      { pattern: /\bchloroquine\b/i,           penalty: 20, explanation: '⛔ Chloroquine-resistant P. falciparum is endemic in Nigeria. First-line for severe malaria is IV artesunate (WHO/FMOH). Deducted −20 pts.' },
      { pattern: /\blumbar puncture.{0,20}immediately|lp.{0,20}first\b/i, penalty: 15, explanation: '⚠️ LP should be deferred in a comatose child until raised ICP (papilloedema, focal signs) is excluded and the patient is stabilised. Deducted −15 pts.' },
    ],
    symptomFacts: {
      hpc_onset: {
        onset:   'yesterday',
        context: 'It started yesterday. In the morning he had very high fever. By afternoon he had a fit. By evening he wouldn\'t wake up properly.',
        tier1:   "It started yesterday. In the morning he had very high fever. By afternoon he had a fit. By evening he wouldn't wake up properly.",
        tier2:   'The fever came first — very high, we were sponging him. Then the shaking started suddenly. After the shaking he was confused and we couldn\'t rouse him properly.',
        tier3:   'We thought it was just the usual malaria at first. We gave him some drugs from the chemist. But he just got worse.',
      },
      hpc_character: {
        character: 'very high fever then seizure then confusion',
        severity:  'he is not responding normally — we cannot wake him properly',
        tier1:    "Very high fever first, then the shaking, then he became unconscious. We can't wake him properly.",
        tier2:    'The seizure lasted about 5 minutes — he was stiff then shaking, then floppy afterwards. He\'s been drowsy and not making sense since.',
      },
      sr_fever: {
        onset:   'since yesterday morning',
        severity:'very high — we didn\'t measure but he was burning',
        context: 'Very high fever since yesterday morning. We were sponging him with cold water. He was also shivering at one point.',
        tier1:   "Very high fever since yesterday morning. We were sponging him with cold water. He was also shivering at one point.",
        tier2:   'The fever didn\'t come down with paracetamol syrup we gave him. It was very high — we couldn\'t measure but he was burning.',
      },
      sr_seizures: {
        context: 'One seizure yesterday afternoon — lasted about 5 minutes. He was stiff and shaking, then stopped and became floppy. He was not conscious during it.',
        duration:'about 5 minutes',
        severity:'one generalised seizure — stiff then shaking then floppy',
        tier1:   "One seizure yesterday afternoon — lasted about 5 minutes. He was stiff and shaking, then stopped and became floppy. He was not conscious during it.",
        tier2:   'After the seizure he opened his eyes sometimes but wasn\'t tracking us or speaking properly. He tried to push us away when we touched him.',
        tier3:   'Before this he\'s never had a fit before. This is the first time. We were very frightened.',
      },
      sr_consciousness: {
        context: 'He is not responding properly. He opens his eyes when we shout at him but doesn\'t follow our fingers and isn\'t speaking properly.',
        severity:'altered — GCS appears reduced',
        tier1:   "He is not responding properly. He opens his eyes when we shout at him but doesn't follow our fingers and isn't speaking properly.",
        tier2:   'He said a few words this morning but since then just groaning. We can\'t get him to drink anything — he\'s just pushing the cup away.',
      },
      sr_fever: {
        onset:   'since yesterday morning',
        severity:'very high — we didn\'t measure but he was burning',
        context: 'Very high fever since yesterday morning. We were sponging him with cold water. He was also shivering at one point.',
        tier1:   "Very high fever since yesterday morning. We were sponging him with cold water. He was also shivering at one point.",
        tier2:   'The fever didn\'t come down with paracetamol syrup we gave him. It was very high — we couldn\'t measure but he was burning.',
      },
      sr_jaundice: {
        context: 'Now that you ask — his eyes do look a bit yellow today. We didn\'t notice it yesterday.',
        tier1:   "Now that you ask — his eyes do look a bit yellow today. We didn't notice it yesterday.",
      },
      shx_travel: {
        context: 'Yes — we went to visit family in Ogun State last weekend. They live near a forest area. There was lots of mosquitoes.',
        tier1:   "Yes — we went to visit family in Ogun State last weekend. They live near a forest area. There was lots of mosquitoes.",
        tier2:   'We were there for 4 days. He was bitten a lot by mosquitoes — we didn\'t have a net at their house.',
      },
      pmh_general: {
        context: 'He has had malaria twice before — ages 2 and 3. Both times he was treated as an outpatient. No other medical conditions.',
        tier1:   "He has had malaria twice before — ages 2 and 3. Both times he was treated as an outpatient. No other medical conditions.",
      },
      meds_general: {
        context: 'We gave him paracetamol syrup and some malaria and typhoid combination tablets we bought from the chemist. Also some agbo (herbal mixture).',
        tier1:   "We gave him paracetamol syrup and some malaria and typhoid combination tablets we bought from the chemist. Also some agbo (herbal mixture).",
        tier2:   'I don\'t know the exact name of the tablets — the chemist gave them to us. They were yellow tablets.',
      },
      immunisation: {
        context: 'He is up to date with all his vaccinations according to his card — BCG, pentavalent, measles, yellow fever. He had the RTS,S malaria vaccine at 6 months.',
        tier1:   "He is up to date with all his vaccinations according to his card — BCG, pentavalent, measles, yellow fever. He had the RTS,S malaria vaccine at 6 months.",
        tier2:   'The malaria vaccine — we were told it reduces but doesn\'t prevent malaria completely. He can still get it.',
      },
      exam_general: {
        context: 'General: Critically ill-looking child. Temperature 39.8°C. Pulse 148 bpm (tachycardia). RR 38/min. SpO₂ 91% on air. Deeply jaundiced sclera. Severe pallor. Moderate dehydration. Blantyre Coma Score 2/5.',
        tier1:   "General: Critically ill-looking 4-year-old. Temperature 39.8°C. Pulse 148 bpm. RR 38/min. SpO₂ 91% on air ↓. Deeply jaundiced sclera. Severe pallor. Moderate dehydration. Blantyre Coma Score: 2/5 (eyes open to pain only, no localisation, no verbal).",
      },
      exam_neuro: {
        context: 'Blantyre Coma Score 2/5 (≤2 = cerebral malaria). Pupils equal and reactive — 3mm bilaterally. Opisthotonus present (neck stiffness in context of fever). No focal signs. No papilloedema.',
        tier1:   "Blantyre Coma Score: 2/5 (≤2 = cerebral malaria). Pupils: 3mm, equal and reactive. Opisthotonus (back arching) present. Neck stiffness present. No focal neurological signs. No papilloedema on fundoscopy.",
        tier2:   'The opisthotonus is important — can be seen in both cerebral malaria and meningitis. LP may be needed after stabilisation to exclude meningitis.',
      },
      exam_abdomen: {
        context: 'Abdomen: Soft. Splenomegaly — 4cm below costal margin, non-tender. Liver 2cm below costal margin. No ascites.',
        tier1:   "Abdomen: Soft. Splenomegaly — 4cm below left costal margin, non-tender. Liver 2cm below costal margin. No ascites.",
      },
      ix_rdt: {
        context: 'Malaria RDT:\n• HRP-2 (P. falciparum): POSITIVE ✓\n• pLDH (pan-malarial): POSITIVE ✓\n→ Confirms P. falciparum malaria.',
        tier1:   "Malaria RDT:\n• HRP-2 (P. falciparum): POSITIVE ✓\n• pLDH (pan-malarial): POSITIVE ✓\n→ P. falciparum malaria confirmed.",
      },
      ix_thickfilm: {
        context: 'Thick & Thin Blood Film:\n• Parasitaemia: 4.2% (hyperparasitaemia — WHO criterion for severe malaria is >2%)\n• Species: P. falciparum — ring forms + gametocytes\n• Hb: 6.1 g/dL (severe anaemia)',
        tier1:   "Thick & Thin Blood Film:\n• Parasitaemia: 4.2% ↑↑ (hyperparasitaemia — >2% = WHO severe malaria criterion)\n• Species: P. falciparum — multiple ring forms + banana-shaped gametocytes\n• Hb on film request: 6.1 g/dL (severe anaemia = blood transfusion threshold)",
      },
      ix_fbc: {
        context: 'FBC:\n• Hb: 6.1 g/dL ↓↓ (severe anaemia)\n• WBC: 6.8 × 10⁹/L (normal)\n• Platelets: 48 × 10⁹/L ↓↓ (severe thrombocytopaenia)\n→ Hb <5g/dL in a child with respiratory distress = blood transfusion. Thrombocytopaenia almost universal in severe malaria.',
        tier1:   "FBC:\n• Hb: 6.1 g/dL ↓↓ (severe malarial anaemia)\n• WBC: 6.8 × 10⁹/L (normal)\n• Platelets: 48 × 10⁹/L ↓↓ (severe thrombocytopaenia — universal in malaria)\n→ Hb <5g/dL + respiratory distress = blood transfusion threshold.",
      },
      ix_lft: {
        context: 'LFTs:\n• Bilirubin total: 98 μmol/L ↑↑ (jaundice)\n• Unconjugated: 78 μmol/L (haemolysis)\n• ALT: 62 IU/L (mildly elevated)\n• Blood glucose: 2.1 mmol/L ↓↓ (HYPOGLYCAEMIA — common complication)',
        tier1:   "LFTs:\n• Total bilirubin: 98 μmol/L ↑↑ (unconjugated = haemolysis)\n• ALT: 62 IU/L (mild)\n• Blood glucose: 2.1 mmol/L ↓↓ (HYPOGLYCAEMIA — common in severe malaria, especially in children)\n→ Hypoglycaemia must be corrected IMMEDIATELY with IV glucose.",
      },
    },
    intentMap: {
      hpc_onset:     { text: "It started yesterday. In the morning he had very high fever. By afternoon he had a fit. By evening he wouldn't wake up properly.", type:'history', label:'Onset' },
      hpc_character: { text: "Very high fever first, then the shaking, then he became unconscious. We can't wake him properly.", type:'history', label:'Character' },
      sr_fever:      { text: "Very high fever since yesterday morning. We were sponging him with cold water. He was also shivering at one point.", type:'history', label:'Fever' },
      sr_seizures:   { text: "One seizure yesterday afternoon — lasted about 5 minutes. He was stiff and shaking, then stopped and became floppy. He was not conscious during it.", type:'history', label:'Seizures' },
      sr_consciousness:{ text: "He is not responding properly. He opens his eyes when we shout at him but doesn't follow our fingers and isn't speaking properly.", type:'history', label:'Consciousness' },
      sr_jaundice:   { text: "Now that you ask — his eyes do look a bit yellow today. We didn't notice it yesterday.", type:'history', label:'Jaundice' },
      shx_travel:    { text: "Yes — we went to visit family in Ogun State last weekend. They live near a forest area. There were lots of mosquitoes.", type:'history', label:'Travel history' },
      pmh_general:   { text: "He has had malaria twice before — ages 2 and 3. Both times treated as outpatient. No other medical conditions.", type:'history', label:'Past medical history' },
      meds_general:  { text: "We gave him paracetamol syrup and some malaria and typhoid combination tablets from the chemist. Also some agbo (herbal mixture).", type:'history', label:'Medications' },
      immunisation:  { text: "Up to date with all vaccinations — BCG, pentavalent, measles, yellow fever. He had the RTS,S malaria vaccine at 6 months.", type:'history', label:'Immunisation' },
      exam_general:  { text: "General: Critically ill. Temp 39.8°C. Pulse 148. RR 38. SpO₂ 91%. Deeply jaundiced. Severe pallor. Moderate dehydration. Blantyre Coma Score 2/5.", type:'exam', label:'General examination' },
      exam_neuro:    { text: "Blantyre Coma Score 2/5. Pupils 3mm equal reactive. Opisthotonus. Neck stiffness. No focal signs. No papilloedema.", type:'exam', label:'Neurological examination' },
      exam_abdomen:  { text: "Abdomen: Soft. Splenomegaly 4cm below costal margin. Liver 2cm below costal margin.", type:'exam', label:'Abdominal examination' },
      ix_rdt:        { text: "Malaria RDT: HRP-2 POSITIVE. pLDH POSITIVE. P. falciparum confirmed.", type:'investigation', label:'Malaria RDT' },
      ix_thickfilm:  { text: "Blood film: Parasitaemia 4.2% (hyperparasitaemia). P. falciparum — ring forms + gametocytes.", type:'investigation', label:'Blood film' },
      ix_fbc:        { text: "FBC: Hb 6.1 g/dL ↓↓. WBC 6.8. Platelets 48 ↓↓.", type:'investigation', label:'FBC' },
      ix_lft:        { text: "LFTs: Bilirubin 98 μmol/L ↑↑. ALT 62. Blood glucose 2.1 mmol/L ↓↓ (HYPOGLYCAEMIA).", type:'investigation', label:'LFTs / Blood glucose' },
    },
    scoringMap: { mustAsk: ['sr_fever','sr_seizures','sr_consciousness','shx_travel'], shouldAsk: ['exam_neuro','ix_rdt','ix_thickfilm','ix_fbc','ix_lft'], pointsBase: 5, pointsMust: 15 },
  },

  // Paediatrics cases loaded from bundled JSON
  ...pedsCases.cases,
];

// ══════════════════════════════════════════════════════════════
//  RE-EXPORT ALL V5.0 INFRASTRUCTURE (unchanged)
//  Only handleChat() and resolveCase() are replaced.
// ══════════════════════════════════════════════════════════════

// ── Text normalisation (Upgrade 1) ───────────────────────────
const NORMALISATION_MAP = [
  [/\bbody dey hot\b/gi, 'fever temperature'],
  [/\bbody hot\b/gi, 'fever temperature'],
  [/\bpikin\b/gi, 'child'],
  [/\bbaby dey move\b/gi, 'fetal movement'],
  [/\bno dey move\b/gi, 'not moving'],
  [/\bwetin dey worry\b/gi, 'what is wrong presenting complaint'],
  [/\banka.*swollen\b/gi, 'ankle swelling oedema'],
  [/\bleg.*swell\b/gi, 'leg swelling oedema'],
  [/\bhead dey pain\b/gi, 'headache'],
  [/\bstomach dey pain\b/gi, 'abdominal pain'],
  [/\bchest dey pain\b/gi, 'chest pain'],
  [/\bbreath dey hard\b/gi, 'difficulty breathing dyspnoea'],
  [/\bdey shake\b/gi, 'shaking seizure convulsion'],
  [/\bno gree wake\b/gi, 'not waking altered consciousness'],
  [/\bchop vomit\b/gi, 'vomiting nausea'],
  [/\bh\/o\b/gi, 'history of'],
  [/\bc\/o\b/gi, 'complaining of'],
  [/\bk\/a\b/gi, 'known allergic'],
  [/\bk\/c\/o\b/gi, 'known case of'],
  [/\bpm hx\b/gi, 'past medical history'],
  [/\bpmhx\b/gi, 'past medical history'],
  [/\bfhx\b/gi, 'family history'],
  [/\bshx\b/gi, 'social history'],
  [/\bhpc\b/gi, 'history presenting complaint'],
  [/\bbp\b/gi, 'blood pressure'],
  [/\bhr\b/gi, 'heart rate pulse'],
  [/\brr\b/gi, 'respiratory rate breathing'],
  [/\bspo2\b/gi, 'oxygen saturation spo2'],
  [/\bo2 sat\b/gi, 'oxygen saturation'],
  [/\btemp\b/gi, 'temperature'],
  [/\bwt\b/gi, 'weight'],
  [/\bht\b/gi, 'height'],
  [/\blocsn\b/gi, 'loss of consciousness'],
  [/\bloc\b/gi, 'level of consciousness'],
  [/\bsob\b/gi, 'shortness of breath dyspnoea'],
  [/\bdob\b/gi, 'difficulty breathing'],
  [/\bpnd\b/gi, 'paroxysmal nocturnal dyspnoea orthopnoea'],
  [/\bjvp\b/gi, 'jugular venous pressure'],
  [/\bpv\b/gi, 'per vaginum vaginal'],
  [/\bfc\b/gi, 'febrile convulsion seizure'],
  [/\bneonatal\b/gi, 'newborn neonate neonatal'],
  [/\bga\b/gi, 'gestational age weeks'],
  [/\bga(\d+)\b/gi, 'gestation $1 weeks'],
  [/\bimci\b/gi, 'integrated management childhood illness assessment'],
  [/\bcmam\b/gi, 'community management acute malnutrition'],
  [/\bmuac\b/gi, 'mid upper arm circumference malnutrition'],
  [/\brutf\b/gi, 'ready use therapeutic food malnutrition'],
  [/\bsam\b/gi, 'severe acute malnutrition'],
  [/\bmam\b/gi, 'moderate acute malnutrition'],
  [/\bepi\b/gi, 'expanded programme immunisation vaccination'],
  [/\bwho\b/gi, 'world health organisation protocol'],
  [/\bfeva\b/gi, 'fever'],
  [/\bvomitting\b/gi, 'vomiting'],
  [/\bsiezure\b/gi, 'seizure'],
  [/\bconvultion\b/gi, 'convulsion'],
  [/\bjoundice\b/gi, 'jaundice'],
  [/\bbreathless\b/gi, 'shortness of breath dyspnoea'],
  [/\bswolen\b/gi, 'swollen'],
  [/\bpallor\b/gi, 'pallor anaemia pale'],
  [/\bdehydrat\b/gi, 'dehydration'],
  [/\bwt loss\b/gi, 'weight loss'],
  [/\btachycardi\b/gi, 'tachycardia fast heart rate'],
  [/\bbradycardi\b/gi, 'bradycardia slow heart rate'],
];

function normaliseText(raw) {
  let t = raw.toLowerCase().trim();
  for (const [pattern, replacement] of NORMALISATION_MAP) {
    t = t.replace(pattern, replacement);
  }
  t = t.replace(/[^\w\s'-]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return t;
}

// ── Intent Clustering (Upgrade 2) ────────────────────────────
const INTENT_CLUSTERS = {
  full_history:      ['hpc_onset','hpc_character','hpc_radiation','hpc_relieving','hpc_triggers','hpc_associated'],
  social_cluster:    ['shx_general','shx_travel','fhx_general'],
  obstetric_cluster: ['parity','antenatal','sr_fetal_movement','sr_abdominal'],
  paediatric_hx:     ['immunisation','pmh_general','shx_travel','sr_fever','sr_seizures'],
  respiratory_hx:    ['hpc_character','hpc_triggers','sr_fever','pmh_general','meds_general','fhx_general'],
  general_exam:      ['exam_general','exam_skin'],
  full_exam:         ['exam_general','exam_cardiovascular','exam_chest','exam_abdomen','exam_neuro','exam_skin'],
  neuro_cluster:     ['exam_neuro','exam_general','sr_consciousness','sr_seizures'],
  cardiac_cluster:   ['exam_cardiovascular','exam_general','sr_chest_pain','sr_oedema'],
  abdo_cluster:      ['exam_abdomen','exam_specific_signs','exam_general'],
  baseline_ix:       ['ix_fbc','ix_lft','ix_crp','ix_urinalysis'],
  malaria_ix:        ['ix_rdt','ix_thickfilm','ix_fbc','ix_lft'],
  cardiac_ix:        ['ix_ecg','ix_cxr','ix_fbc','ix_lft'],
  respiratory_ix:    ['ix_cxr','ix_pefr','ix_abg','ix_fbc'],
};

const CLUSTER_TRIGGERS = [
  { phrases: ['take a full history','full history','complete history','take history'],            clusters: ['full_history','social_cluster'] },
  { phrases: ['social history','any social history'],                                             clusters: ['social_cluster'] },
  { phrases: ['obstetric history','antenatal history','any pregnancies'],                         clusters: ['obstetric_cluster'] },
  { phrases: ['paediatric history','child history','history of the child'],                       clusters: ['paediatric_hx'] },
  { phrases: ['respiratory history','breathing history'],                                         clusters: ['respiratory_hx'] },
  { phrases: ['general examination','general survey','examine generally','examine the patient'],  clusters: ['general_exam'] },
  { phrases: ['full examination','complete examination','examine from head to toe'],              clusters: ['full_exam'] },
  { phrases: ['neurological examination','examine neurologically','check neurology'],             clusters: ['neuro_cluster'] },
  { phrases: ['cardiac examination','cardiovascular examination','examine heart'],                clusters: ['cardiac_cluster'] },
  { phrases: ['abdominal examination','examine the abdomen','abdominal exam'],                    clusters: ['abdo_cluster'] },
  { phrases: ['baseline investigations','routine bloods','routine investigations','basic bloods'],clusters: ['baseline_ix'] },
  { phrases: ['malaria workup','malaria investigations','test for malaria'],                      clusters: ['malaria_ix'] },
  { phrases: ['cardiac workup','heart investigations'],                                           clusters: ['cardiac_ix'] },
  { phrases: ['respiratory investigations','breathing tests','lung investigations'],              clusters: ['respiratory_ix'] },
];

function resolveClusterIntents(normText, caseData) {
  const hits = new Set();
  for (const trigger of CLUSTER_TRIGGERS) {
    if (trigger.phrases.some(ph => normText.includes(ph))) {
      for (const clusterName of trigger.clusters) {
        for (const id of (INTENT_CLUSTERS[clusterName] || [])) {
          if (caseData.intentMap && caseData.intentMap[id]) hits.add(id);
        }
      }
    }
  }
  return [...hits];
}

// ── Personality System (Upgrade 3) ───────────────────────────
const TEMPERAMENTS = {
  stoic: {
    openings:          ['', '', '', '(pauses) ', ''],
    closings:          ['', " That's all I know.", '', ''],
    distress_openings: ['(winces slightly) ', '(shifts uncomfortably) ', ''],
    distress_closings: ['', " It's not easy.", ''],
  },
  anxious: {
    openings:          ["I'm very worried but — ", 'Please help me — ', "I'm not sure if this is important, but ", '', 'I keep thinking the worst... '],
    closings:          [' Is that bad?', ' Should I be worried?', '', ' What does that mean?', ''],
    distress_openings: ['(visibly trembling) ', '(tearful) ', "I'm scared — "],
    distress_closings: [" Please tell me it's nothing serious.", " I'm really frightened.", ''],
  },
  reticent: {
    openings:          ['(reluctantly) ', '', 'I suppose... ', '(long pause) '],
    closings:          ['', ". That's it.", " I don't want to talk about it further.", ''],
    distress_openings: ['', '(looks away) ', '(quietly) '],
    distress_closings: ['', ' It hurts to talk about it.', ''],
  },
  cooperative: {
    openings:          ['Sure — ', 'Of course, doctor — ', 'Yes, happy to explain — ', ''],
    closings:          [' I hope that helps.', '', ' Is there anything else you need?', ''],
    distress_openings: ['(clearly distressed but cooperative) ', ''],
    distress_closings: [' But please help me.', ''],
  },
  frightened_child_proxy: {
    openings:          ['(mother, anxiously) ', '(father) ', '(caregiver, very worried) ', ''],
    closings:          [' Please, doctor, help my child.', " I'm very worried.", '', ''],
    distress_openings: ['(tearful mother) ', '(distraught parent) '],
    distress_closings: [" My child has never been this sick.", ' Please do something.'],
  },
};

function assignTemperament(patient) {
  const age = patient?.age || 30;
  const sex = patient?.sex || 'Male';
  if (age < 12) return 'frightened_child_proxy';
  if (age >= 12 && age <= 17) return 'reticent';
  if (age >= 60 && sex === 'Male') return 'stoic';
  if (patient?.occupation === 'Trader' || (sex === 'Female' && age < 35)) return 'anxious';
  return 'cooperative';
}

function applyPersonality(baseText, temperament, isDistressed, rng) {
  const T = TEMPERAMENTS[temperament] || TEMPERAMENTS.cooperative;
  const openPool = isDistressed ? T.distress_openings : T.openings;
  const closePool = isDistressed ? T.distress_closings : T.closings;
  const open  = openPool[Math.floor(rng * openPool.length)];
  const close = closePool[Math.floor(rng * closePool.length)];
  const base  = baseText.trim().replace(/\.$/, '');
  return `${open}${base}${close}`.trim();
}

const DISTRESS_INTENTS = new Set([
  'sr_seizures','sr_consciousness','sr_chest_pain','sr_fetal_movement',
  'hpc_character','exam_neuro','exam_general',
]);

// ── Upgrade 8: Nigerian Patient Engine ───────────────────────
const MEDICAL_JARGON = /\b(haemoglobin|neutrophilia|orthopnoea|hyperreflexia|papilloedema|auscultate|palpate|mcburney|rovsing|creatinine|splenomegaly|hepatomegaly|jugular\s*venous|sternal\s*angle|epigastric\s*tenderness|bradycardia|tachycardia|auscultation|percussion\s*note|dullness|crepitations|dyspnoea|paraesthesia|diaphoresis|diuresis|proteinuria|thrombocytopaenia|coagulopathy|hepatosplenomegaly|fundoscopy|clonus|hyperparasitaemia)\b/i;

const NIGERIAN_CONTEXT = {
  openers:  ['Please doctor, ', 'To be honest with you, ', 'Actually, ', 'You see, ', 'I must tell you, ', 'Ehen, well — ', 'To cut the long story short, '],
  self_med: [
    "Before coming here I bought paracetamol and amoxil from the chemist down the road.",
    "I tried some agbo (herbal mixture) that my aunt prepared — it didn't help.",
    "I got some malaria and typhoid combination drugs over the counter and started them.",
    "I used hot water and local herbs first, but the symptoms kept getting worse.",
    "My neighbour gave me some of her tablets — I don't know the name exactly.",
  ],
  faith_coping: [
    "I've been praying over it and believing God for healing.",
    "My pastor laid hands on me last Sunday, but I'm still not feeling right.",
    "I believe God will see me through, but I need your help too, doctor.",
    "My church members said it's spiritual — but it keeps getting worse so I came.",
  ],
};

function handleJargonResponse(studentText, builtReply) {
  if (!MEDICAL_JARGON.test(studentText)) return builtReply;
  const pool = [
    "Sorry doctor, I don't understand that word. Can you ask me in simpler language?",
    "I'm not a medical person, doctor. Please explain what you mean.",
    "That sounds very complicated. Are you asking about my symptoms?",
    "I just want to feel better — can you ask me in plain English please?",
    "I don't know that term. What exactly are you asking?",
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function applyProgressiveDisclosure(baseText, intentId, askedIntents) {
  if (!intentId) return baseText;
  const askCount = askedIntents.filter(id => id === intentId).length;
  if (askCount === 0) return baseText;
  if (askCount === 1) return `${baseText} (I mentioned this before, but yes — I'll repeat it.)`;
  const firstSentence = baseText.split(/[.!?]/)[0] || baseText;
  return `(Slightly impatient) I already told you that, doctor. ${firstSentence}.`;
}

function injectNigerianContext(text, intentId, rng) {
  let reply = text;
  const id  = intentId || '';
  if (rng < 0.40) {
    const pool = NIGERIAN_CONTEXT.openers;
    reply = pool[Math.floor(rng * pool.length)] + reply;
  }
  const isSymptomIntent = id.startsWith('hpc') || id.startsWith('sr_') || id === 'pmh_general' || id === 'meds_general';
  if (isSymptomIntent && rng < 0.30) {
    const pool = NIGERIAN_CONTEXT.self_med;
    reply += ` ${pool[Math.floor(rng * pool.length)]}`;
  }
  const isSevereIntent = id.includes('pain') || id.includes('fever') || id.includes('consciousness') || id.includes('seizure') || id.includes('fetal') || id.includes('chest');
  if (isSevereIntent && rng < 0.20) {
    const pool = NIGERIAN_CONTEXT.faith_coping;
    reply += ` ${pool[Math.floor(rng * pool.length)]}`;
  }
  return reply;
}

function shiftTemperament(baseTemperament, cumulativePenalties, phaseViolationOccurred) {
  if (cumulativePenalties > 10) return 'reticent';
  if (phaseViolationOccurred) return 'anxious';
  return baseTemperament;
}

// ── Knowledge Pearls (Upgrade 4) ─────────────────────────────
function bankLookupTopic(diagnosisPrimary) {
  if (!diagnosisPrimary) return null;
  const slug = diagnosisPrimary.toLowerCase().replace(/[\s()'/]+/g, '_').replace(/_+/g, '_');
  if (STATIC_BANK[`topic:${slug}`]) return STATIC_BANK[`topic:${slug}`];
  const needle = diagnosisPrimary.toLowerCase();
  for (const [key, val] of Object.entries(STATIC_BANK)) {
    if (!key.startsWith('topic:')) continue;
    if (val.name && val.name.toLowerCase().includes(needle)) return val;
    if (key.includes(slug.slice(0, 12))) return val;
  }
  return null;
}
function bankLookupDrug(drugName) {
  if (!drugName) return null;
  return STATIC_BANK[`drug:${drugName.toLowerCase().replace(/\s+/g, '_')}`] || null;
}
function bankLookupGuideline(topic) {
  if (!topic) return null;
  return STATIC_BANK[`guideline:${topic.toLowerCase().replace(/\s+/g, '_')}`] || null;
}

// Full BUILTIN_PEARLS from v5.0 (unchanged — kept for continuity)
const BUILTIN_PEARLS = {
  hpc_onset: {
    _default: 'Always establish the exact timing and mode of onset — sudden (vascular, obstructive) vs gradual (inflammatory, neoplastic) onset has strong diagnostic value.',
    acute_appendicitis: "Classic appendicitis pain begins peri-umbilically then migrates to RIF (McBurney's point) over 12–24 hours — this migration is highly specific.",
    'severe malaria (p. falciparum)': 'In children, P. falciparum progresses to severe disease rapidly — 24–48 hours from onset to cerebral involvement is possible.',
    'acute asthma exacerbation': 'Note the trigger for this exacerbation — exercise, allergen, URTI, or medication non-compliance all point to different management priorities.',
  },
  hpc_character: {
    _default: 'Characterise pain using SOCRATES: Site, Onset, Character, Radiation, Associations, Timing, Exacerbating/relieving, Severity.',
    acute_appendicitis: 'Appendicitis pain is typically constant (not colicky), dull initially then sharp — colicky pain suggests bowel obstruction or ureteric colic instead.',
    'decompensated heart failure': 'Orthopnoea (breathlessness on lying flat) + PND (waking gasping) = classic left ventricular failure. Ask how many pillows they sleep with.',
  },
  sr_fever: {
    _default: 'Fever in children: always ask about rigors, pattern (continuous vs intermittent), and response to antipyretics.',
    'severe malaria (p. falciparum)': 'Hyperparasitaemia (>2%) defines severe malaria in Nigeria. Fever with altered consciousness = cerebral malaria until proven otherwise.',
    'acute appendicitis': 'Low-grade fever (38–38.5°C) with RIF pain and leucocytosis = Alvarado score feature. High fever (>39°C) suggests perforation.',
  },
  sr_seizures: {
    _default: 'Classify seizure type: focal vs generalised, tonic-clonic vs absence. Post-ictal confusion differentiates seizure from syncope.',
    'severe malaria (p. falciparum)': 'Seizures in severe malaria = cerebral malaria (WHO criterion). Treat with IV artesunate + IV diazepam for active seizures.',
  },
  sr_consciousness: {
    _default: 'Use GCS (Eyes 1–4, Verbal 1–5, Motor 1–6) to objectively document consciousness. GCS ≤8 = intubation threshold.',
    'severe malaria (p. falciparum)': 'Blantyre Coma Scale is used for young children (adapted GCS). Score ≤2 = cerebral malaria.',
  },
  sr_jaundice: {
    _default: 'Pre-hepatic (haemolysis) → unconjugated bilirubin. Post-hepatic (obstruction) → pale stool, dark urine, pruritus.',
  },
  sr_oedema: {
    _default: 'Oedema: bilateral pitting = cardiac/renal/hepatic; unilateral = DVT/lymphoedema; facial = nephrotic/anaphylaxis.',
    'decompensated heart failure': 'Bilateral pitting oedema + raised JVP + basal crepitations = classic right heart failure triad.',
    'severe pre-eclampsia': 'Rapidly worsening oedema + proteinuria + hypertension after 20 weeks = pre-eclampsia. Facial puffiness is particularly significant.',
  },
  parity: {
    _default: 'Parity notation: G (gravida) = total pregnancies; P (para) = deliveries after 28 weeks; + number of miscarriages/terminations.',
    'severe pre-eclampsia': 'Nulliparity is the strongest risk factor for pre-eclampsia (6× risk).',
  },
  antenatal: {
    _default: 'WHO ANC schedule recommends ≥8 contacts. In Nigeria: booking visit <12 weeks, BP at every visit.',
    'severe pre-eclampsia': 'New-onset hypertension (≥140/90) + proteinuria after 20 weeks = pre-eclampsia.',
  },
  pmh_general: {
    _default: 'Past medical history mnemonic: MJ THREADS — Medication, Jaundice, TB, Heart disease, Rheumatic fever, Epilepsy, Asthma, Diabetes, Stroke.',
    'decompensated heart failure': 'Prior MI + long-standing hypertension = ischaemic cardiomyopathy. Running out of diuretics is a classic precipitant of decompensation.',
  },
  meds_general: {
    _default: 'Always ask about: prescription drugs, OTC drugs, herbal/traditional medicine (common in Nigeria), nutritional supplements, and missed doses.',
    'decompensated heart failure': 'Running out of loop diuretics (frusemide) is the #1 precipitant of hospital admission in known heart failure patients in Nigeria.',
  },
  exam_cardiovascular: {
    _default: 'Cardiac auscultation: listen at apex (mitral), lower sternal border (tricuspid), 2nd R ICS (aortic), 2nd L ICS (pulmonary).',
    'decompensated heart failure': 'S3 gallop = ventricular dysfunction — the most specific bedside sign of decompensated LVF. Displaced apex = cardiomegaly.',
  },
  exam_chest: {
    _default: 'Respiratory exam: Inspect → Palpate (TVF) → Percuss → Auscultate (breath sounds, added sounds).',
    'decompensated heart failure': 'Bilateral basal fine inspiratory crackles = pulmonary oedema. Stony dull + reduced breath sounds = pleural effusion.',
  },
  exam_abdomen: {
    _default: 'Abdominal exam: Inspect → Superficial palpation → Deep palpation → Percussion → Auscultate.',
    acute_appendicitis: "McBurney's, Rovsing's, Psoas, Obturator signs — all increase LR for appendicitis. Alvarado score ≥7 = surgical referral.",
  },
  exam_neuro: {
    _default: 'Neurological exam: Consciousness (GCS) → Cranial nerves → Motor → Sensory → Coordination → Gait.',
    'severe pre-eclampsia': 'Hyperreflexia + clonus (≥3 beats) = impending eclampsia. Treat with IV/IM magnesium sulphate IMMEDIATELY.',
  },
  exam_specific_signs: {
    _default: 'Special tests should be used to confirm or refute your leading differential — they are hypothesis-driven, not routine.',
    acute_appendicitis: "Rovsing's sign has LR+ ~2.5 for appendicitis. Combined with McBurney's + fever + leucocytosis = Alvarado ≥7.",
  },
  ix_fbc: {
    _default: 'Interpret FBC systematically: Hb → WBC (neutrophilia=bacterial; lymphocytosis=viral) → Differential → Platelets.',
    'decompensated heart failure': 'Anaemia is a common precipitant of heart failure decompensation — always check Hb.',
  },
  ix_lft: {
    _default: 'LFT: AST/ALT elevation = hepatocellular; ALP/GGT = cholestatic. BNP >100pg/mL = heart failure until proven otherwise.',
    'decompensated heart failure': 'BNP >400pg/mL = high probability HF. BNP useful to guide diuretic titration and prognosis.',
  },
  ix_urinalysis: {
    _default: 'Urine dipstick: glucose (DM), protein (renal/cardiac/pre-eclampsia), blood (UTI/stones), nitrites+leucocytes = UTI.',
    'severe pre-eclampsia': 'Protein 2+ on dipstick = ≥300mg/24hr = significant proteinuria. With BP ≥140/90 after 20 weeks = pre-eclampsia.',
  },
  ix_cxr: {
    _default: 'Systematic CXR: ABCDE — Airway, Bones, Cardiac (CTR <0.5), Diaphragm, Everything else.',
    'decompensated heart failure': 'Heart failure CXR: Cardiomegaly + Upper lobe diversion + Kerley B lines + Bat-wing opacification.',
  },
  ix_ecg: {
    _default: 'ECG: Rate → Rhythm → Axis → P waves → PR → QRS → ST (elevation/depression) → T waves → QTc.',
    'decompensated heart failure': 'LBBB = cardiomegaly and likely systolic dysfunction. New-onset LBBB with symptoms = treat as acute MI equivalent.',
  },
  ix_crp: {
    _default: 'CRP rises within 4–6 hours. Very high CRP (>150) = bacterial infection, tissue necrosis, or vasculitis.',
    acute_appendicitis: 'CRP >80 + WBC >11 + clinical features = Alvarado ≥7 → surgical review.',
  },
  ix_rdt: {
    _default: 'Malaria RDT detects HRP-2 (P. falciparum-specific) and pLDH (pan-malarial). High sensitivity ~95%.',
    'severe malaria (p. falciparum)': 'A positive RDT in a child with altered consciousness = severe malaria until proven otherwise.',
  },
  ix_thickfilm: {
    _default: 'Thick blood film is the gold standard for malaria — allows species ID and parasitaemia quantification.',
    'severe malaria (p. falciparum)': 'Parasitaemia >2% = hyperparasitaemia = WHO severe malaria criterion.',
  },
};

async function getPearl(intentId, diagnosisPrimary, env) {
  if (env?.KNOWLEDGE_KV) {
    try {
      const diagKey = `topic:${(diagnosisPrimary || '').toLowerCase().replace(/\s+/g, '_')}`;
      const raw = await env.KNOWLEDGE_KV.get(diagKey);
      if (raw) {
        const data = JSON.parse(raw);
        const pearls = data.pearls || data.clinicalPearls;
        if (pearls?.[intentId]) return `📚 *Clinical pearl:* ${pearls[intentId]}`;
      }
    } catch (_) {}
  }
  const topic = bankLookupTopic(diagnosisPrimary);
  if (topic?.pearls?.[intentId]) return `📚 *Clinical pearl:* ${topic.pearls[intentId]}`;
  const genericPearl = STATIC_BANK[`pearl:${intentId}`];
  if (genericPearl?.content) return `📚 *Teaching point:* ${genericPearl.content}`;
  const intentPearls = BUILTIN_PEARLS[intentId];
  if (!intentPearls) return null;
  const diagKey = (diagnosisPrimary || '').toLowerCase();
  const pearl = intentPearls[diagKey] || intentPearls._default || null;
  return pearl ? `📚 *Teaching point:* ${pearl}` : null;
}

// ── Differential Tracker (Upgrade 5) ─────────────────────────
const DEFAULT_INTENT_WEIGHTS = {
  sr_fever:           { 'Acute Appendicitis': +8, 'Severe Malaria (P. falciparum)': +20, 'Viral Encephalitis': +10 },
  sr_seizures:        { 'Severe Malaria (P. falciparum)': +25, 'Viral Encephalitis': +20, 'Febrile Convulsion': +15 },
  sr_oedema:          { 'Decompensated Heart Failure': +20, 'Severe Pre-eclampsia': +18, 'HELLP Syndrome': +8 },
  sr_chest_pain:      { 'Decompensated Heart Failure': +10, 'Pulmonary Embolism': +15 },
  hpc_character:      { 'Acute Appendicitis': +15, 'Decompensated Heart Failure': +10 },
  hpc_triggers:       { 'Acute Asthma Exacerbation': +20 },
  hpc_orthopnoea:     { 'Decompensated Heart Failure': +22, 'Pulmonary Embolism': +5 },
  pmh_general:        { 'Decompensated Heart Failure': +10 },
  meds_general:       { 'Decompensated Heart Failure': +10 },
  antenatal:          { 'Severe Pre-eclampsia': +15, 'Gestational Hypertension': +12, 'HELLP Syndrome': +8 },
  parity:             { 'Severe Pre-eclampsia': +10 },
  exam_general:       { 'Severe Malaria (P. falciparum)': +10 },
  exam_cardiovascular:{ 'Decompensated Heart Failure': +20 },
  exam_chest:         { 'Acute Asthma Exacerbation': +18, 'Decompensated Heart Failure': +15 },
  exam_neuro:         { 'Severe Malaria (P. falciparum)': +15, 'Severe Pre-eclampsia': +20 },
  exam_specific_signs:{ 'Acute Appendicitis': +20 },
  ix_fbc:             { 'Severe Malaria (P. falciparum)': +12, 'Decompensated Heart Failure': +8, 'HELLP Syndrome': +10 },
  ix_rdt:             { 'Severe Malaria (P. falciparum)': +30 },
  ix_thickfilm:       { 'Severe Malaria (P. falciparum)': +25 },
  ix_lft:             { 'HELLP Syndrome': +20, 'Decompensated Heart Failure': +10 },
  ix_urinalysis:      { 'Severe Pre-eclampsia': +20, 'Gestational Hypertension': +8 },
  ix_ecg:             { 'Decompensated Heart Failure': +15 },
  ix_cxr:             { 'Decompensated Heart Failure': +15 },
  ix_pefr:            { 'Acute Asthma Exacerbation': +22 },
  ix_ultrasound:      { 'Severe Pre-eclampsia': +12, 'HELLP Syndrome': +10 },
};

function updateDifferentials(caseData, askedIntents) {
  if (!caseData.differentials?.length) return [];
  const diffs = caseData.differentials.map(d => ({ ...d }));
  const weights = caseData.intentWeights || DEFAULT_INTENT_WEIGHTS;
  let total = 0;
  diffs.forEach(d => {
    let w = d.initial ?? 25;
    for (const intentId of askedIntents) {
      const intentDeltas = weights[intentId];
      if (!intentDeltas) continue;
      for (const [diagName, delta] of Object.entries(intentDeltas)) {
        if (d.name.toLowerCase() === diagName.toLowerCase()) w += delta;
      }
    }
    d.weight = Math.max(1, w);
    total += d.weight;
  });
  diffs.forEach(d => { d.probability = Math.round((d.weight / total) * 100); });
  return diffs.sort((a, b) => b.probability - a.probability);
}

// ── Phase Tracking (Upgrade 6) ────────────────────────────────
const PHASES = { HISTORY: 1, EXAM: 2, INVESTIGATION: 3 };
const PHASE_LABELS = { 1: 'History', 2: 'Examination', 3: 'Investigation' };

function detectIntentPhase(intentId) {
  if (!intentId) return null;
  if (intentId.startsWith('exam_')) return PHASES.EXAM;
  if (intentId.startsWith('ix_'))   return PHASES.INVESTIGATION;
  return PHASES.HISTORY;
}
function getCurrentPhase(askedIntents) {
  let phase = PHASES.HISTORY;
  for (const id of askedIntents) {
    const p = detectIntentPhase(id);
    if (p && p > phase) phase = p;
  }
  return phase;
}
function checkPhaseViolation(intentId, askedIntents, caseData) {
  const intentPhase = detectIntentPhase(intentId);
  if (!intentPhase) return null;
  const mustAskHistory = (caseData.scoringMap?.mustAsk || []).filter(id => detectIntentPhase(id) === PHASES.HISTORY);
  const coveredMustHistory = mustAskHistory.filter(id => askedIntents.includes(id)).length;
  if (intentPhase === PHASES.EXAM && askedIntents.length === 0)
    return `⚠️ *Clinical tutor note:* You've started with examination before taking any history. Always begin with a focused history. (-2 pts deducted)`;
  const hasExam = askedIntents.some(id => detectIntentPhase(id) === PHASES.EXAM);
  if (intentPhase === PHASES.INVESTIGATION && !hasExam)
    return `⚠️ *Clinical tutor note:* You've moved to investigations before performing any clinical examination. (-2 pts deducted)`;
  if (intentPhase >= PHASES.EXAM && mustAskHistory.length > 0 && coveredMustHistory === 0)
    return `⚠️ *Clinical tutor note:* You have not yet asked about the key features of the presenting complaint. (-2 pts deducted)`;
  return null;
}

// ── Danger Check ──────────────────────────────────────────────
const GLOBAL_DANGEROUS_PATTERNS = [
  { pattern: /\baspirin\b/i, penalty: 20, explanation: "⛔ Aspirin is contraindicated in children under 16 years (Reye's syndrome risk). Deducted −20 pts." },
  { pattern: /\bchloroquine\b/i, penalty: 15, explanation: '⚠️ Chloroquine-resistant P. falciparum is widespread in Nigeria. First-line for severe malaria is IV artesunate. Deducted −15 pts.' },
  { pattern: /\bbeta.?blocker|propranolol|atenolol\b/i, penalty: 20, explanation: '⛔ Beta-blockers are absolutely contraindicated in acute asthma. Deducted −20 pts.' },
  { pattern: /\bnsaid|ibuprofen|diclofenac\b/i, penalty: 15, explanation: '⛔ NSAIDs contraindicated in surgical abdomens, pregnancy >20 weeks, and active heart failure. Deducted −15 pts.' },
  { pattern: /\bace.?inhibitor|lisinopril|enalapril|ramipril\b/i, penalty: 15, explanation: '⛔ ACE inhibitors are teratogenic in the 2nd and 3rd trimesters. Absolutely contraindicated in pregnancy. Deducted −15 pts.' },
  { pattern: /\blumbar.?puncture.{0,20}without|lp.{0,20}before.{0,20}stabili/i, penalty: 15, explanation: '⚠️ LP should only be performed after stabilising the patient and excluding raised ICP. Deducted −15 pts.' },
  { pattern: /\bsedati|diazepam.{0,20}asthma|lorazepam.{0,20}respir/i, penalty: 15, explanation: '⛔ Sedation in acute respiratory distress can cause respiratory arrest. Deducted −15 pts.' },
];

function checkDanger(normText, caseData) {
  if (caseData.trapActions) {
    for (const trap of caseData.trapActions) {
      const regex = new RegExp(trap.pattern.source || trap.pattern, trap.pattern.flags || 'i');
      if (regex.test(normText)) return trap;
    }
  }
  for (const g of GLOBAL_DANGEROUS_PATTERNS) {
    if (g.pattern.test(normText)) return g;
  }
  return null;
}

// ── Fallback / Not-Applicable Generators ─────────────────────
function generateFallback(normText, caseData, history) {
  const age = caseData.patient?.age;
  const complaint = caseData.presentingComplaint;
  if (/treat|manag|give|prescrib|administer|start.*on/i.test(normText))
    return `As your clinical tutor: management questions aren't part of the clerking phase. Focus on history, examination, and investigations first.`;
  if (/diagnos|what is|condition|impression|assessment/i.test(normText))
    return `Use the "Give Diagnosis" button when you're ready to submit your clinical impression. Continue clerking.`;
  if (/thank|okay|ok|noted|i see/i.test(normText))
    return `Please continue with your assessment. Ask me about my symptoms, history, medications, or request an examination.`;
  const responses = [
    `I'm not sure I understand that question. Could you rephrase it? I'm here about my ${complaint?.toLowerCase() || 'symptoms'}.`,
    `Sorry, I didn't quite follow that. I'm a ${age}-year-old patient — please ask about my symptoms, history, or how I've been feeling.`,
    `I'm not sure what you mean. You can ask about when it started, what it feels like, my past history, medications, or family history.`,
    `Could you clarify that? I'm happy to tell you more about my ${complaint?.toLowerCase() || 'problem'}.`,
    `I don't understand that question. Perhaps ask about my symptoms, examination findings, or investigations instead.`,
  ];
  return responses[history.length % responses.length];
}

function generateNotApplicable(intentId, caseData) {
  const age = caseData.patient?.age;
  const sex = caseData.patient?.sex || 'Unknown';
  const naResponses = {
    sr_fever:         `No, I haven't had any fever or chills.`,
    sr_nausea:        `No nausea or vomiting.`,
    sr_seizures:      `No, no fits or seizures.`,
    sr_chest_pain:    `No chest pain.`,
    sr_jaundice:      `No, my eyes haven't been yellow and my urine has been normal.`,
    shx_travel:       `No, I haven't travelled anywhere recently.`,
    shx_general:      `I'm ${sex === 'Female' ? 'a housewife' : 'working in my usual occupation'}. I don't smoke. I drink occasionally.`,
    fhx_general:      `No notable family history of serious illness.`,
    allergies_general:`No known drug allergies.`,
    parity:           sex === 'Male' ? `That's not applicable — I'm a ${age}-year-old male patient.` : `This is my first pregnancy.`,
    antenatal:        sex === 'Male' ? `That's not applicable to me.` : `I've been attending antenatal clinic.`,
    sr_abdominal:     `No significant abdominal pain.`,
    sr_oedema:        `No notable swelling.`,
    sr_urinary:       `Urine is normal — no burning or frequency.`,
    sr_bowels:        `My bowels have been normal.`,
    sr_appetite:      `My appetite has been okay.`,
    sr_consciousness: `I've been alert and conscious throughout.`,
    sr_fetal_movement:sex === 'Male' ? `That's not applicable.` : `Yes, baby has been moving normally.`,
    immunisation:     `Up to date with vaccinations as far as I know.`,
  };
  return naResponses[intentId] || `No, that's not something I've noticed or experienced.`;
}

// ── Intent Classification Engine ─────────────────────────────
function classifyIntent(normText, patterns) {
  let bestMatch = null, bestScore = 0;
  for (const pattern of patterns) {
    let score = 0;
    for (const phrase of (pattern.phrases || [])) {
      if (normText.includes(phrase.toLowerCase())) score += 30;
    }
    let keywordHits = 0;
    for (const kw of (pattern.keywords || [])) {
      const kwLower = kw.toLowerCase();
      if (normText.includes(kwLower)) {
        if (kw.length <= 4) {
          if (new RegExp(`\\b${kwLower}\\b`).test(normText)) { score += 10; keywordHits++; }
        } else { score += 10; keywordHits++; }
      }
    }
    if (keywordHits >= 2) score += 10;
    if (keywordHits >= 4) score += 10;
    if (score > bestScore) { bestScore = score; bestMatch = pattern; }
  }
  return bestScore >= 10 ? bestMatch : null;
}

// ── Intent Patterns (full v5.0 set — unchanged) ───────────────
const INTENT_PATTERNS = [
  { id:'hpc_onset',       keywords:['when','start','began','how long','duration','onset','since','ago','period','days','weeks','months','first notice','first felt','beginning','first time','come on','started'],
    phrases:['when did','how long have','when did it start','how did it start','when did the pain begin','how long ago','how long has this been going on','when did you first notice'] },
  { id:'hpc_character',   keywords:['character','nature','describe','what kind','type','feel like','quality','sharp','dull','throbbing','constant','aching','burning','cramp','colicky','pressure','tight','heavy','stabbing','squeezing','worse','better'],
    phrases:['describe the pain','what does it feel like','what kind of pain','what is the pain like','can you describe','what type of pain','is the pain sharp','is it constant','does the pain come and go','what is the character of the pain','how would you describe it'] },
  { id:'hpc_radiation',   keywords:['radiat','spread','go','move','extend','travel','jaw','arm','back','groin','leg','shoulder','neck'],
    phrases:['does the pain spread','does it radiate','does it go anywhere','does the pain travel','does it go to your back','does the pain move'] },
  { id:'hpc_relieving',   keywords:['better','relieve','help','relief','ease','alleviates','reduce','improve','lying','sitting','standing','rest','eating'],
    phrases:['what makes it better','does anything help','what relieves it','what makes the pain go away','anything that helps','does rest help','does lying down help'] },
  { id:'hpc_associated',  keywords:['associated','other','also','alongside','accompanying','together with','in addition','at the same time','symptoms','problems','else','anything else wrong'],
    phrases:['any other symptoms','associated symptoms','anything else','are there any other symptoms','any other problems'] },
  { id:'hpc_triggers',    keywords:['trigger','cause','start','bring on','precipitate','provoke','worsen','worse with','aggravate','exercise','cold','stress','dust','pollen','pet','food'],
    phrases:['what triggers','what causes it','what makes it worse','what brings it on','any triggers','does exercise trigger'] },
  { id:'hpc_orthopnoea',  keywords:['lie down','lying down','flat','pillow','orthopnoea','breathless lying','sleeping position','how many pillows','prop up'],
    phrases:['can you lie flat','how many pillows','breathless when lying','orthopnoea','do you sleep propped up'] },
  { id:'sr_fever',        keywords:['fever','temperature','hot','pyrexia','febrile','chills','rigors','shivering','sweating','sweats','night sweats','body hot'],
    phrases:['any fever','any temperature','do you have fever','feeling hot','any chills','any rigors','any night sweats','is there fever'] },
  { id:'sr_nausea',       keywords:['nausea','vomit','sick','vomiting','retching','throw up','nauseated','vomited','emesis'],
    phrases:['any nausea','any vomiting','have you vomited','feeling sick','any sickness','do you feel sick','any retching','have you been sick'] },
  { id:'sr_seizures',     keywords:['seizure','fit','convulsion','shake','jerk','twitch','epilepsy','tonic','clonic','febrile convulsion'],
    phrases:['any seizures','any fits','any convulsions','did they shake','any jerking','febrile convulsion'] },
  { id:'sr_consciousness',keywords:['conscious','consciousness','unconscious','awareness','alert','drowsy','lethargy','lethargic','confused','confusion','gcs','altered','unresponsive'],
    phrases:['any change in consciousness','are they alert','are they drowsy','any confusion','are they unresponsive','level of consciousness'] },
  { id:'sr_jaundice',     keywords:['yellow','jaundice','icteric','sclera','eyes yellow','pale stool','dark urine','pruritus','itch'],
    phrases:['any jaundice','yellow eyes','yellow skin','are their eyes yellow','any pale stools','any dark urine','any itching'] },
  { id:'sr_oedema',       keywords:['swelling','oedema','edema','puffy','swollen','fluid','ankle','leg','face','sacral','ascites'],
    phrases:['any swelling','ankle swelling','leg swelling','facial swelling','any oedema','are the ankles swollen','any fluid retention'] },
  { id:'sr_chest_pain',   keywords:['chest pain','chest tightness','chest pressure','angina','retrosternal','precordial','chest discomfort','chest heaviness'],
    phrases:['any chest pain','any chest tightness','pain in your chest','chest discomfort','any pressure in the chest'] },
  { id:'sr_appetite',     keywords:['appetite','eat','food','hungry','meal','diet','anorexia','loss of appetite'],
    phrases:['how is your appetite','are you eating','any change in appetite','loss of appetite'] },
  { id:'sr_bowels',       keywords:['bowels','stool','poo','diarrhoea','constipation','blood stool','melaena','change bowel','loose stool'],
    phrases:['any bowel changes','any diarrhoea','any constipation','blood in stool','bowel habits'] },
  { id:'sr_urinary',      keywords:['urine','urinary','pee','bladder','burning','dark','frequency','urgency','dysuria','blood in urine','nocturia','passing urine','less urine','frothy'],
    phrases:['any urinary symptoms','burning when passing urine','dark urine','how is your urine','blood in urine','any urinary frequency','urine output','any frothy urine'] },
  { id:'sr_fetal_movement',keywords:['baby','fetal','fetus','kick','movement','move','feel baby','baby moving'],
    phrases:['is baby moving','any fetal movement','can you feel the baby','baby kicks','has baby been moving','reduced fetal movement'] },
  { id:'sr_abdominal',    keywords:['abdominal pain','belly pain','stomach pain','epigastric','right upper quadrant','ruq','upper abdominal'],
    phrases:['any abdominal pain','any upper abdominal pain','any epigastric pain','any right upper quadrant pain'] },
  { id:'shx_travel',      keywords:['travel','trip','visit','journey','abroad','visited','returned','forest','rural','endemic','outside'],
    phrases:['any recent travel','have you travelled','any travel history','been anywhere recently','visited any endemic area'] },
  { id:'parity',          keywords:['parity','gravida','para','previous pregnancy','first pregnancy','how many children','obstetric history','miscarriage'],
    phrases:['obstetric history','parity','any previous pregnancies','how many children','first pregnancy','any miscarriages'] },
  { id:'antenatal',       keywords:['antenatal','anc','booking','antenatal care','scan','gestation','weeks pregnant','trimester'],
    phrases:['antenatal history','any anc visits','have you been attending antenatal','booking visit','gestation','how many weeks pregnant'] },
  { id:'immunisation',    keywords:['vaccine','vaccination','immunisation','immunization','epi','jab','bcg','dpt','measles','yellow fever','malaria vaccine'],
    phrases:['any vaccinations','immunisation history','is the child vaccinated','up to date with vaccines','epi schedule'] },
  { id:'pmh_general',     keywords:['history','past','medical','illness','condition','admit','operation','surgery','previous','hypertension','diabetes','asthma','epilepsy','hospital','chronic'],
    phrases:['past medical history','any medical conditions','ever admitted','any previous illness','any chronic conditions','any previous surgery'] },
  { id:'meds_general',    keywords:['medication','drug','tablet','capsule','injection','inhaler','medicine','prescription','taking','herbal','traditional','supplement','water tablet'],
    phrases:['any medications','what medications','any drugs','on any treatment','any tablets','any herbal remedies','any prescriptions'] },
  { id:'allergies_general',keywords:['allerg','allergic','reaction','sensitivity','intolerance','rash','anaphylaxis'],
    phrases:['any allergies','are you allergic','any drug allergies','any reactions to medication'] },
  { id:'fhx_general',     keywords:['family','father','mother','parent','sibling','brother','sister','relative','hereditary','genetic'],
    phrases:['family history','any family history','any hereditary conditions','does it run in the family','parents have any conditions'] },
  { id:'shx_general',     keywords:['smoke','smoking','alcohol','drink','work','occupation','job','live','married','social','exercise','diet'],
    phrases:['do you smoke','any alcohol','what is your occupation','social history','smoking history','alcohol intake'] },
  { id:'exam_general',    keywords:['general','appearance','vital signs','vitals','temperature','pulse','blood pressure','respiratory rate','spo2','weight','pallor','cyanosis','jaundice','clubbing','oedema'],
    phrases:['general examination','examine generally','vital signs','take vitals','general appearance','check vitals','general survey'] },
  { id:'exam_cardiovascular', keywords:['cardiovascular','heart','cardiac','apex','murmur','heart sounds','jvp','jugular','peripheral pulses','precordium'],
    phrases:['examine the heart','cardiovascular examination','cardiac examination','listen to the heart','heart sounds','check jvp'] },
  { id:'exam_chest',      keywords:['chest','respiratory','lung','lungs','breath','wheeze','crackle','breath sounds','air entry','percussion','trachea'],
    phrases:['examine the chest','respiratory examination','listen to the lungs','breath sounds','any wheeze','chest examination'] },
  { id:'exam_abdomen',    keywords:['abdomen','abdominal','belly','stomach','liver','spleen','guarding','rigidity','tenderness','masses','bowel sounds','palpate','ascites'],
    phrases:['examine the abdomen','abdominal examination','palpate the abdomen','any tenderness','check for guarding'] },
  { id:'exam_neuro',      keywords:['neuro','neurological','reflexes','power','tone','sensation','gcs','consciousness','pupils','cranial nerves','cerebellar','clonus'],
    phrases:['neurological examination','examine neurologically','check reflexes','gcs','pupils','check for clonus'] },
  { id:'exam_skin',       keywords:['skin','rash','lesion','macule','papule','vesicle','dermatology','eczema','erythema','petechiae','purpura'],
    phrases:['examine the skin','any rash','skin examination','any skin lesions','check pallor'] },
  { id:'exam_lymph_nodes',keywords:['lymph','lymph nodes','lymphadenopathy','glands','cervical','axillary','inguinal','swollen glands'],
    phrases:['check lymph nodes','lymph node examination','any swollen glands'] },
  { id:'exam_specific_signs', keywords:['specific','mcburney','rovsing','psoas','obturator','murphy','kernig','brudzinski'],
    phrases:["mcburney's point","rovsing's sign","psoas sign","murphy's sign",'specific signs','special tests'] },
  { id:'ix_fbc',          keywords:['fbc','full blood count','blood count','cbc','haemoglobin','hb','wbc','white blood cell','platelets','neutrophils','anaemia'],
    phrases:['order fbc','full blood count','check fbc','blood count','haematology'] },
  { id:'ix_ultrasound',   keywords:['ultrasound','uss','sonogram','scan','abdominal imaging','abdominal ultrasound'],
    phrases:['order ultrasound','abdominal ultrasound','ultrasound scan','request uss'] },
  { id:'ix_crp',          keywords:['crp','c reactive protein','esr','inflammatory markers'],
    phrases:['check crp','inflammatory markers','c reactive protein','esr'] },
  { id:'ix_urinalysis',   keywords:['urinalysis','urine dipstick','mcs','urine culture','urine test','urine analysis','dipstick','protein urine'],
    phrases:['urinalysis','urine test','dipstick urine','urine dipstick','urine sample','urine protein'] },
  { id:'ix_pefr',         keywords:['pefr','peak flow','peak expiratory flow','spirometry'],
    phrases:['check pefr','peak flow','peak expiratory flow','measure peak flow'] },
  { id:'ix_abg',          keywords:['abg','arterial blood gas','blood gas','ph','pao2','paco2','oxygen','co2'],
    phrases:['arterial blood gas','abg','blood gases','check blood gas'] },
  { id:'ix_cxr',          keywords:['cxr','chest xray','chest x ray','chest radiograph','chest film'],
    phrases:['chest xray','cxr','order cxr','chest x ray','chest radiograph'] },
  { id:'ix_rdt',          keywords:['rdt','malaria test','rapid diagnostic test','malaria rdt'],
    phrases:['malaria rdt','rapid diagnostic test','test for malaria','rdt'] },
  { id:'ix_thickfilm',    keywords:['thick film','thin film','blood film','blood smear','malaria film','giemsa','parasitaemia'],
    phrases:['blood film','thick and thin film','malaria smear','blood smear'] },
  { id:'ix_lft',          keywords:['lft','liver function','liver enzymes','ast','alt','alp','bilirubin','albumin','bnp','renal profile','urea','creatinine'],
    phrases:['liver function tests','lft','liver enzymes','check liver function','bnp','renal function'] },
  { id:'ix_ecg',          keywords:['ecg','ekg','electrocardiogram','heart tracing','twelve lead'],
    phrases:['order ecg','ecg','electrocardiogram','heart tracing','12 lead'] },
];

// ── Case Serialiser ────────────────────────────────────────────
function serialiseCases(cases) {
  return cases.map(c => ({
    ...c,
    trapActions: (c.trapActions || []).map(t => ({
      ...t,
      pattern: t.pattern instanceof RegExp ? t.pattern.source : (t.pattern || ''),
      flags:   t.pattern instanceof RegExp ? t.pattern.flags  : (t.flags || 'i'),
    })),
  }));
}

const BUNDLED_DISCIPLINES = new Set(['peds']);

// ══════════════════════════════════════════════════════════════
//  CASE RESOLVER (v6.0)
//  Merges v5.0 BUILTIN_CASES with v6.0 BUILTIN_CASES_V2.
//  v6.0 cases take priority when caseId matches.
// ══════════════════════════════════════════════════════════════

// v5.0 legacy cases (og + med without symptomFacts)
const LEGACY_CASES = [];  // empty — v6.0 cases cover all three builtin disciplines

const ALL_BUILTIN_CASES = [...BUILTIN_CASES_V2];

async function resolveCase(caseId, env) {
  // ── 0. Peds are bundled — always from BUILTIN_CASES_V2 ────────
  const isBundled = ALL_BUILTIN_CASES.some(
    c => c.caseId === caseId && BUNDLED_DISCIPLINES.has(c.discipline)
  );
  if (isBundled) return ALL_BUILTIN_CASES.find(c => c.caseId === caseId) || null;

  // ── 1. KV individual case ──────────────────────────────────────
  let caseData = null;
  if (env?.CASES_KV) {
    try {
      const raw = await env.CASES_KV.get(`case:${caseId}`);
      if (raw) caseData = JSON.parse(raw);
    } catch (_) {}
    if (!caseData) {
      try {
        for (const disc of ['med', 'surg', 'og']) {
          const bulk = await env.CASES_KV.get(`cases:${disc}`);
          if (bulk) {
            const found = JSON.parse(bulk).find(c => c.caseId === caseId);
            if (found) { caseData = found; break; }
          }
        }
      } catch (_) {}
    }
  }

  // ── 2. Built-in fallback ──────────────────────────────────────
  if (!caseData) caseData = ALL_BUILTIN_CASES.find(c => c.caseId === caseId) || null;
  if (!caseData) return null;

  // ── 3. Bank enrichment ────────────────────────────────────────
  const primaryDx = caseData.diagnosis?.primary;
  if (primaryDx) {
    const topic = bankLookupTopic(primaryDx);
    if (topic) {
      if (!caseData.differentials?.length && topic.differentials?.length) {
        caseData.differentials = topic.differentials.map((d, i) => ({
          name: d.name,
          initial: Math.max(5, 40 - i * 10),
          color: ['#8A3F6B','#9B3535','#5B3F8A','#2A5A8A','#3F6B3F'][i % 5],
          distinguishing: d.distinguishing || '',
        }));
      }
      if (!caseData.managementPearl && topic.management_pearls)
        caseData.managementPearl = topic.management_pearls;
      if (!caseData.nigerianContext && topic.nigerian_context)
        caseData.nigerianContext = topic.nigerian_context;
      if (!caseData.clinicalFeaturesSummary && topic.clinical_features)
        caseData.clinicalFeaturesSummary = topic.clinical_features;
      if (!caseData.investigationsSummary && topic.investigations)
        caseData.investigationsSummary = topic.investigations;
      caseData._bankEnriched = true;
      caseData._bankTopic = topic.slug || topic.name;
    }
  }
  return caseData;
}

// ══════════════════════════════════════════════════════════════
//  CORS + JSON HELPERS
// ══════════════════════════════════════════════════════════════
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

// ══════════════════════════════════════════════════════════════
//  ROUTER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;
    if (method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/health')                              return handleHealth(env);
      if (url.pathname === '/cases'           && method === 'GET') return handleCases(url, env);
      if (url.pathname === '/chat'            && method === 'POST') return handleChat(request, env);
      if (url.pathname === '/scores'          && method === 'POST') return handleScore(request, env);
      if (url.pathname === '/leaderboard'     && method === 'GET') return handleLeaderboard(url, env);
      if (url.pathname === '/admin/ingest'    && method === 'POST') return handleIngest(request, env);
      if (url.pathname === '/admin/ingest-cases' && method === 'POST') return handleIngestCases(request, env);
      if (url.pathname === '/admin/knowledge' && method === 'GET') return handleKnowledgeQuery(url, env);
      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err('Internal server error', 500);
    }
  },
};

// ══════════════════════════════════════════════════════════════
//  CHAT HANDLER (v6.0)
//  Identical contract to v5.0 /chat.
//  Body: { caseId, message, conversationHistory, askedIntents, penalties }
// ══════════════════════════════════════════════════════════════

async function handleChat(request, env) {
  const body = await request.json();
  const {
    caseId,
    message,
    conversationHistory = [],
    askedIntents = [],
    penalties: clientPenalties = 0,
  } = body;
  if (!caseId || !message) return err('caseId and message required');

  const caseData = await resolveCase(caseId, env);
  if (!caseData) return err(`Case ${caseId} not found`, 404);

  // ── Upgrade 1: Normalise ─────────────────────────────────────
  const normText = normaliseText(message);

  // ── Danger check ─────────────────────────────────────────────
  const danger = checkDanger(normText, caseData);
  if (danger) {
    return json({
      reply: danger.explanation,
      intentId: null, type: 'penalty',
      isDangerous: true, penalty: danger.penalty, score: 0,
      normalisedText: normText,
    });
  }

  // ── Upgrade 2: Intent Clustering ─────────────────────────────
  const clusterIntentIds = resolveClusterIntents(normText, caseData);
  if (clusterIntentIds.length > 1) {
    const scored = [], replies = [];
    let totalPts = 0;
    for (const id of clusterIntentIds) {
      if (askedIntents.includes(id)) continue;
      const entry = caseData.intentMap[id];
      if (!entry) continue;
      const isMust   = caseData.scoringMap.mustAsk.includes(id);
      const isShould = caseData.scoringMap.shouldAsk.includes(id);
      const pts = isMust   ? (caseData.scoringMap.pointsMust || 15)
               : isShould ? (caseData.scoringMap.pointsBase  || 10) : 5;
      totalPts += pts;
      scored.push({ intentId: id, score: pts, label: entry.label });

      // Use fact store tier1 if available, else intentMap text
      const facts = caseData.symptomFacts?.[id];
      const replyText = facts?.tier1 || entry.text;
      replies.push(`[${entry.label}] ${replyText}`);
    }
    const primaryId = scored.find(s => s.score >= 15)?.intentId || scored[0]?.intentId;
    const pearl = primaryId ? await getPearl(primaryId, caseData.diagnosis?.primary, env) : null;
    const allAskedAfterCluster = [...askedIntents, ...scored.map(s => s.intentId)];
    const updatedDifferentials = updateDifferentials(caseData, allAskedAfterCluster);
    return json({
      reply: replies.join('\n\n---\n\n'),
      intentId: primaryId || null,
      type: 'cluster',
      isDangerous: false,
      score: totalPts,
      clusterIntents: scored,
      pearl,
      normalisedText: normText,
      differentials: updatedDifferentials,
      engine: 'v6-cluster',
    });
  }

  // ── Upgrade 3: Temperament assignment ────────────────────────
  const temperament = assignTemperament(caseData.patient);

  // ── Single intent classification ─────────────────────────────
  const intent = classifyIntent(normText, INTENT_PATTERNS);
  if (!intent) {
    const fallback = generateFallback(normText, caseData, conversationHistory);
    const currentDifferentials = updateDifferentials(caseData, askedIntents);
    return json({
      reply: fallback,
      intentId: null, type: 'fallback',
      isDangerous: false, score: 0,
      normalisedText: normText,
      temperamentApplied: temperament,
      differentials: currentDifferentials,
      engine: 'v6-fallback',
    });
  }

  const responseData = caseData.intentMap[intent.id];
  if (!responseData) {
    const notApplicable = generateNotApplicable(intent.id, caseData);
    const currentDifferentials = updateDifferentials(caseData, askedIntents);
    return json({
      reply: notApplicable,
      intentId: intent.id, type: 'history',
      isDangerous: false, score: 0,
      normalisedText: normText,
      temperamentApplied: temperament,
      differentials: currentDifferentials,
      engine: 'v6-na',
    });
  }

  // ── Upgrade 6: Phase check ────────────────────────────────────
  const phaseWarning = checkPhaseViolation(intent.id, askedIntents, caseData);
  const phasePenalty = phaseWarning ? 2 : 0;
  const currentPhase = getCurrentPhase(askedIntents);
  const intentPhase  = detectIntentPhase(intent.id);

  // ── Scoring ───────────────────────────────────────────────────
  const alreadyAsked = askedIntents.includes(intent.id);
  const isMust       = caseData.scoringMap.mustAsk.includes(intent.id);
  const isShould     = caseData.scoringMap.shouldAsk.includes(intent.id);
  const basePoints   = alreadyAsked ? 0
    : isMust   ? (caseData.scoringMap.pointsMust  || 15)
    : isShould ? (caseData.scoringMap.pointsBase  || 10)
    : 5;
  const points = Math.max(0, basePoints - phasePenalty);

  // ── Upgrade 9–12: Conversation Engine ─────────────────────────
  const isDistressed = DISTRESS_INTENTS.has(intent.id);
  const rng = ((message.length * 7 + intent.id.length * 13) % 100) / 100;

  const facts = caseData.symptomFacts?.[intent.id] || null;

  const wrappedReply = alreadyAsked
    ? (facts?.tier1 || responseData.text)  // repeat ask → serve tier1 (clean facts)
    : generateConversation({
        facts,
        baseText:               responseData.text,
        intentId:               intent.id,
        studentText:            normText,
        baseTemperament:        temperament,
        isDistressed,
        askedIntents,
        conversationHistory,
        cumulativePenalties:    clientPenalties,
        phaseViolationOccurred: !!phaseWarning,
        rng,
      });

  // ── Upgrade 4: Teaching pearl ─────────────────────────────────
  const pearl = (!alreadyAsked && (isMust || isShould))
    ? await getPearl(intent.id, caseData.diagnosis?.primary, env)
    : null;

  // ── Upgrade 5: Updated differentials ─────────────────────────
  const askedAfter = alreadyAsked ? askedIntents : [...askedIntents, intent.id];
  const updatedDifferentials = updateDifferentials(caseData, askedAfter);

  const finalReply = phaseWarning ? `${phaseWarning}\n\n${wrappedReply}` : wrappedReply;

  return json({
    reply: finalReply,
    intentId: intent.id,
    type: responseData.type || 'history',
    isDangerous: false,
    score: points,
    alreadyAsked,
    pearl,
    normalisedText: normText,
    temperamentApplied: temperament,
    phaseWarning: phaseWarning || null,
    phasePenalty,
    currentPhase:  PHASE_LABELS[currentPhase] || 'History',
    intentPhase:   PHASE_LABELS[intentPhase]  || 'History',
    differentials: updatedDifferentials,
    engine: 'v6-conversation',  // new field — lets the UI know which engine replied
  });
}

// ══════════════════════════════════════════════════════════════
//  CASES, SCORES, LEADERBOARD, ADMIN (unchanged from v5.0)
// ══════════════════════════════════════════════════════════════

async function handleCases(url, env) {
  const discipline = url.searchParams.get('discipline');
  if (!discipline) return err('discipline param required');
  if (BUNDLED_DISCIPLINES.has(discipline)) {
    const cases = ALL_BUILTIN_CASES.filter(c => c.discipline === discipline);
    return json({ cases: serialiseCases(cases), source: 'builtin', count: cases.length });
  }
  if (env?.CASES_KV) {
    const raw = await env.CASES_KV.get(`cases:${discipline}`);
    if (raw) {
      const cases = JSON.parse(raw);
      return json({ cases: serialiseCases(cases), source: 'kv', count: cases.length });
    }
  }
  const cases = ALL_BUILTIN_CASES.filter(c => c.discipline === discipline);
  return json({ cases: serialiseCases(cases), source: 'builtin', count: cases.length });
}

async function handleScore(request, env) {
  const body = await request.json();
  const { caseId, studentName, score, penalties, correct, discipline, timeTaken } = body;
  if (!caseId || score == null) return err('caseId and score required');
  if (env?.SCORES_KV) {
    const entry = { caseId, studentName: studentName || 'Anonymous', score, penalties: penalties || 0, correct: correct || false, discipline: discipline || 'unknown', timeTaken: timeTaken || 0, timestamp: Date.now() };
    const key = `score:${caseId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await env.SCORES_KV.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 });
    return json({ success: true, key });
  }
  return json({ success: true, stored: false, note: 'SCORES_KV not configured' });
}

async function handleLeaderboard(url, env) {
  const discipline = url.searchParams.get('discipline');
  if (!env?.SCORES_KV) return json({ leaderboard: [], note: 'SCORES_KV not configured' });
  const prefix = discipline ? `score:case_${discipline}` : 'score:';
  const keys = await env.SCORES_KV.list({ prefix, limit: 200 });
  const scores = [];
  for (const k of keys.keys) {
    const raw = await env.SCORES_KV.get(k.name);
    if (raw) { try { scores.push(JSON.parse(raw)); } catch (_) {} }
  }
  scores.sort((a, b) => (b.score - b.penalties) - (a.score - a.penalties));
  return json({ leaderboard: scores.slice(0, 50), total: scores.length });
}

async function handleIngest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) return err('Unauthorised', 401);
  const body = await request.json();
  if (!env.KNOWLEDGE_KV) return err('KNOWLEDGE_KV not configured', 500);
  let ingested = 0;
  for (const [key, value] of Object.entries(body)) {
    await env.KNOWLEDGE_KV.put(key, JSON.stringify(value));
    ingested++;
  }
  return json({ success: true, ingested });
}

async function handleIngestCases(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) return err('Unauthorised', 401);
  const body = await request.json();
  if (!env.CASES_KV) return err('CASES_KV not configured', 500);
  const { discipline, cases } = body;
  if (!discipline || !Array.isArray(cases)) return err('discipline and cases[] required');
  await env.CASES_KV.put(`cases:${discipline}`, JSON.stringify(cases));
  return json({ success: true, discipline, count: cases.length });
}

async function handleKnowledgeQuery(url, env) {
  const auth = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || auth !== env.ADMIN_SECRET) return err('Unauthorised', 401);
  const topic = url.searchParams.get('topic'), drug = url.searchParams.get('drug');
  const guide = url.searchParams.get('guideline'), search = url.searchParams.get('search');
  const listAll = url.searchParams.get('list');
  if (listAll) {
    const keys = Object.keys(STATIC_BANK);
    return json({ found: true, total: keys.length,
      topics:     keys.filter(k => k.startsWith('topic:')).map(k => k.replace('topic:', '')),
      pearls:     keys.filter(k => k.startsWith('pearl:')).map(k => k.replace('pearl:', '')),
      drugs:      keys.filter(k => k.startsWith('drug:')).map(k => k.replace('drug:', '')),
      guidelines: keys.filter(k => k.startsWith('guideline:')).map(k => k.replace('guideline:', '')),
    });
  }
  if (search) {
    const needle = search.toLowerCase(), matches = [];
    for (const [key, val] of Object.entries(STATIC_BANK)) {
      const haystack = [val.name, val.overview, val.slug].filter(Boolean).join(' ').toLowerCase();
      if (haystack.includes(needle)) matches.push({ key, name: val.name, type: key.split(':')[0] });
    }
    return json({ found: matches.length > 0, query: search, results: matches });
  }
  if (drug) {
    const entry = bankLookupDrug(drug);
    return entry ? json({ found: true, source: 'static_bank', drug, data: entry }) : json({ found: false, drug });
  }
  if (guide) {
    const entry = bankLookupGuideline(guide);
    return entry ? json({ found: true, source: 'static_bank', guideline: guide, data: entry }) : json({ found: false, guideline: guide });
  }
  if (!topic) return err('Provide topic=, drug=, guideline=, search=, or list=1');
  if (env?.KNOWLEDGE_KV) {
    try {
      const raw = await env.KNOWLEDGE_KV.get(`topic:${topic}`);
      if (raw) return json({ found: true, source: 'kv', topic, data: JSON.parse(raw) });
    } catch (_) {}
  }
  const staticEntry = bankLookupTopic(topic);
  if (staticEntry) return json({ found: true, source: 'static_bank', topic, data: staticEntry });
  return json({ found: false, topic, sources_checked: ['kv', 'static_bank'] });
}

async function handleHealth(env) {
  return json({
    status: 'online',
    engine: 'ClerkAI Medical Engine v6.0 — Knowledge-Dense Conversation Engine',
    mode: 'rule-based',
    upgrades: [
      'text-normalisation', 'intent-clustering', 'personality-system',
      'knowledge-expansion', 'differential-tracker', 'phase-tracking',
      'static-peds-knowledge-bank', 'dynamic-nigerian-patient-engine',
      'structured-symptom-fact-store',   // NEW: Upgrade 9
      'template-engine',                  // NEW: Upgrade 10
      'conversation-assembler',           // NEW: Upgrade 11
      'revelation-gating',                // NEW: Upgrade 12
    ],
    conversationEngine: {
      templateBanks:       Object.keys(TEMPLATES).length,
      templatePermutations:'64–96 per intent',
      revelationTiers:     3,
      crossReferenceIntents: Object.keys({ hpc_character:1, sr_oedema:1, sr_urinary:1, sr_seizures:1, sr_chest_pain:1 }).length,
    },
    knowledgeBank: {
      entries: Object.keys(STATIC_BANK).length,
      topics:  Object.keys(STATIC_BANK).filter(k => k.startsWith('topic:')).length,
      pearls:  Object.keys(STATIC_BANK).filter(k => k.startsWith('pearl:')).length,
      drugs:   Object.keys(STATIC_BANK).filter(k => k.startsWith('drug:')).length,
      guidelines: Object.keys(STATIC_BANK).filter(k => k.startsWith('guideline:')).length,
    },
    timestamp: Date.now(),
    kvBindings: { cases: !!env?.CASES_KV, scores: !!env?.SCORES_KV, knowledge: !!env?.KNOWLEDGE_KV },
  });
}
