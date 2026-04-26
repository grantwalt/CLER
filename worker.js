/**
 * ClerkAI — Cloudflare Worker Suite  v2.0
 * ══════════════════════════════════════════════════════════════
 * Offline Clinical Reasoning Simulator
 * Zero-LLM, fully rule-based medical intelligence engine.
 *
 * ✦ UPGRADE 1 — Text Normalisation Engine
 *     Handles abbreviations, typos, pidgin English, and
 *     Nigerian medical shorthand before any matching occurs.
 *
 * ✦ UPGRADE 2 — Intent Clustering
 *     Groups semantically related intents into clusters so that
 *     a broad question ("tell me about her history") can unlock
 *     multiple relevant intents simultaneously.
 *
 * ✦ UPGRADE 3 — Personality System
 *     Each patient has a temperament + emotional state that
 *     colours their replies with authentic distress, reticence,
 *     or openness — without needing an LLM.
 *
 * ✦ UPGRADE 4 — Knowledge Expansion
 *     Every scored intent now triggers a teaching-pearl lookup
 *     from KV (or a rich built-in bank), feeding the student a
 *     clinical nugget after the patient's answer.
 *
 * Routes:
 *   GET  /cases?discipline=            → Serve cases from KV (or built-in bank)
 *   POST /chat                         → Patient simulation (intent engine)
 *   POST /scores                       → Score persistence & leaderboard
 *   GET  /leaderboard?discipline=      → Top scores
 *   GET  /health                       → Backend health probe
 *   POST /admin/ingest                 → Ingest knowledge bank JSON (protected)
 *   GET  /admin/knowledge?topic=       → Query knowledge bank
 *   POST /admin/ingest-cases           → Ingest additional cases (protected)
 *
 * KV Bindings required (in wrangler.toml):
 *   CASES_KV       — stores case JSON by key "cases:{discipline}"
 *   SCORES_KV      — stores score entries
 *   KNOWLEDGE_KV   — medical knowledge bank (pearls, clusters, etc.)
 *
 * Environment variables:
 *   ADMIN_SECRET   — Bearer token for admin endpoints
 */

// ─── CORS HEADERS ──────────────────────────────────────────────
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
function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ─── ROUTER ────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    if (method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/health')                           return handleHealth(env);
      if (url.pathname === '/cases'           && method === 'GET')  return handleCases(url, env);
      if (url.pathname === '/chat'            && method === 'POST') return handleChat(request, env);
      if (url.pathname === '/scores'          && method === 'POST') return handleScore(request, env);
      if (url.pathname === '/leaderboard'     && method === 'GET')  return handleLeaderboard(url, env);
      if (url.pathname === '/admin/ingest'    && method === 'POST') return handleIngest(request, env);
      if (url.pathname === '/admin/ingest-cases' && method === 'POST') return handleIngestCases(request, env);
      if (url.pathname === '/admin/knowledge' && method === 'GET')  return handleKnowledgeQuery(url, env);
      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err('Internal server error', 500);
    }
  },
};

// ══════════════════════════════════════════════════════════════
//  UPGRADE 1 — TEXT NORMALISATION ENGINE
//  Runs before any intent matching. Handles Nigerian pidgin,
//  common abbreviations, medical shorthand, and typos.
// ══════════════════════════════════════════════════════════════

const NORMALISATION_MAP = [
  // ── Nigerian Pidgin / informal English ──────────────────────
  [/\bbody dey hot\b/gi,           'fever temperature'],
  [/\bbody hot\b/gi,               'fever temperature'],
  [/\bpikin\b/gi,                  'child'],
  [/\bbaby dey move\b/gi,          'fetal movement'],
  [/\bno dey move\b/gi,            'not moving'],
  [/\bwetin dey worry\b/gi,        'what is wrong presenting complaint'],
  [/\banka.*swollen\b/gi,          'ankle swelling oedema'],
  [/\bleg.*swell\b/gi,             'leg swelling oedema'],
  [/\bhead dey pain\b/gi,          'headache'],
  [/\bstomach dey pain\b/gi,       'abdominal pain'],
  [/\bchest dey pain\b/gi,         'chest pain'],
  [/\bbreath dey hard\b/gi,        'difficulty breathing dyspnoea'],
  [/\bdey shake\b/gi,              'shaking seizure convulsion'],
  [/\bno gree wake\b/gi,           'not waking altered consciousness'],
  [/\bchop vomit\b/gi,             'vomiting nausea'],

  // ── Medical abbreviations ────────────────────────────────────
  [/\bh\/o\b/gi,                   'history of'],
  [/\bc\/o\b/gi,                   'complaining of'],
  [/\bk\/a\b/gi,                   'known allergic'],
  [/\bk\/c\/o\b/gi,                'known case of'],
  [/\bpm hx\b/gi,                  'past medical history'],
  [/\bpmhx\b/gi,                   'past medical history'],
  [/\bfhx\b/gi,                    'family history'],
  [/\bshx\b/gi,                    'social history'],
  [/\bhpc\b/gi,                    'history presenting complaint'],
  [/\bbp\b/gi,                     'blood pressure'],
  [/\bhr\b/gi,                     'heart rate pulse'],
  [/\brr\b/gi,                     'respiratory rate breathing'],
  [/\bspo2\b/gi,                   'oxygen saturation spo2'],
  [/\bo2 sat\b/gi,                 'oxygen saturation'],
  [/\btemp\b/gi,                   'temperature'],
  [/\bwt\b/gi,                     'weight'],
  [/\bht\b/gi,                     'height'],
  [/\blocsn\b/gi,                  'loss of consciousness'],
  [/\bloc\b/gi,                    'level of consciousness'],
  [/\bsob\b/gi,                    'shortness of breath dyspnoea'],
  [/\bdob\b/gi,                    'difficulty breathing'],
  [/\bpnd\b/gi,                    'paroxysmal nocturnal dyspnoea orthopnoea'],
  [/\bjvp\b/gi,                    'jugular venous pressure'],
  [/\bdo\b/gi,                     'document order'],
  [/\bpv\b/gi,                     'per vaginum vaginal'],
  [/\bfc\b/gi,                     'febrile convulsion seizure'],
  [/\bneonatal\b/gi,               'newborn neonate neonatal'],
  [/\bga\b/gi,                     'gestational age weeks'],
  [/\bga(\d+)\b/gi,                'gestation $1 weeks'],
  [/\bimci\b/gi,                   'integrated management childhood illness assessment'],
  [/\bcmam\b/gi,                   'community management acute malnutrition'],
  [/\bmuac\b/gi,                   'mid upper arm circumference malnutrition'],
  [/\brutf\b/gi,                   'ready use therapeutic food malnutrition'],
  [/\bsam\b/gi,                    'severe acute malnutrition'],
  [/\bmam\b/gi,                    'moderate acute malnutrition'],
  [/\bepi\b/gi,                    'expanded programme immunisation vaccination'],
  [/\bwho\b/gi,                    'world health organisation protocol'],
  [/\bnmcn\b/gi,                   'nursing council nigeria registration'],
  [/\buac\b/gi,                    'mid upper arm circumference'],

  // ── Common typos / informal spellings ────────────────────────
  [/\bfeva\b/gi,                   'fever'],
  [/\bvomitting\b/gi,              'vomiting'],
  [/\bsiezure\b/gi,                'seizure'],
  [/\bconvultion\b/gi,             'convulsion'],
  [/\bjoundice\b/gi,               'jaundice'],
  [/\bbreathless\b/gi,             'shortness of breath dyspnoea'],
  [/\bswolen\b/gi,                 'swollen'],
  [/\bchest pain\b/gi,             'chest pain'],
  [/\bpallor\b/gi,                 'pallor anaemia pale'],
  [/\bdehydrat\b/gi,               'dehydration'],
  [/\bwt loss\b/gi,                'weight loss'],
  [/\btachycardi\b/gi,             'tachycardia fast heart rate'],
  [/\bbradycardi\b/gi,             'bradycardia slow heart rate'],
];

/**
 * normaliseText(raw)
 * Returns a lowercased, normalised version of raw clinical text.
 */
function normaliseText(raw) {
  let t = raw.toLowerCase().trim();
  for (const [pattern, replacement] of NORMALISATION_MAP) {
    t = t.replace(pattern, replacement);
  }
  // Remove punctuation clutter but preserve hyphens (e.g. well-being)
  t = t.replace(/[^\w\s'-]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return t;
}

// ══════════════════════════════════════════════════════════════
//  UPGRADE 2 — INTENT CLUSTERING
//  Groups of related intent IDs. When a broad phrase matches
//  multiple clusters, all cluster members are checked against
//  the intentMap and scored if present.
// ══════════════════════════════════════════════════════════════

const INTENT_CLUSTERS = {
  // History clusters
  full_history:      ['hpc_onset','hpc_character','hpc_radiation','hpc_relieving','hpc_triggers','hpc_associated'],
  social_cluster:    ['shx_general','shx_travel','fhx_general'],
  obstetric_cluster: ['parity','antenatal','sr_fetal_movement','sr_abdominal'],
  paediatric_hx:     ['immunisation','pmh_general','shx_travel','sr_fever','sr_seizures'],
  respiratory_hx:    ['hpc_character','hpc_triggers','sr_fever','pmh_general','meds_general','fhx_general'],

  // Examination clusters
  general_exam:      ['exam_general','exam_skin'],
  full_exam:         ['exam_general','exam_cardiovascular','exam_chest','exam_abdomen','exam_neuro','exam_skin'],
  neuro_cluster:     ['exam_neuro','exam_general','sr_consciousness','sr_seizures'],
  cardiac_cluster:   ['exam_cardiovascular','exam_general','sr_chest_pain','sr_oedema'],
  abdo_cluster:      ['exam_abdomen','exam_specific_signs','exam_general'],

  // Investigation clusters
  baseline_ix:       ['ix_fbc','ix_lft','ix_crp','ix_urinalysis'],
  malaria_ix:        ['ix_rdt','ix_thickfilm','ix_fbc','ix_lft'],
  cardiac_ix:        ['ix_ecg','ix_cxr','ix_fbc','ix_lft'],
  respiratory_ix:    ['ix_cxr','ix_pefr','ix_abg','ix_fbc'],
};

/** clusterTriggerPhrases: phrases that unlock a whole cluster */
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

/**
 * resolveClusterIntents(normText, caseData)
 * Returns an array of intentIds that are (a) triggered by the
 * input's broad phrase, and (b) exist in the case's intentMap.
 */
function resolveClusterIntents(normText, caseData) {
  const hits = new Set();
  for (const trigger of CLUSTER_TRIGGERS) {
    const matched = trigger.phrases.some(ph => normText.includes(ph));
    if (matched) {
      for (const clusterName of trigger.clusters) {
        const members = INTENT_CLUSTERS[clusterName] || [];
        for (const id of members) {
          if (caseData.intentMap && caseData.intentMap[id]) hits.add(id);
        }
      }
    }
  }
  return [...hits];
}

// ══════════════════════════════════════════════════════════════
//  UPGRADE 3 — PERSONALITY SYSTEM
//  Temperaments colour patient replies with authentic emotion.
//  Applied by wrapping the base intentMap response text.
// ══════════════════════════════════════════════════════════════

const TEMPERAMENTS = {
  /**
   * Each temperament is a tuple:
   *   [openingModifier, closingModifier, emotionTag]
   * Modifiers are injected at the start/end of the patient reply.
   * emotionTag is used to gate which modifier pool is sampled.
   */

  stoic: {
    openings:  ['', '', '', '(pauses) ', ''],
    closings:  ['', ' That\'s all I know.', '', ''],
    distress_openings: ['(winces slightly) ', '(shifts uncomfortably) ', ''],
    distress_closings: ['', ' It\'s not easy.', ''],
  },

  anxious: {
    openings:  ['I\'m very worried but — ', 'Please help me — ', 'I\'m not sure if this is important, but ', '', 'I keep thinking the worst... '],
    closings:  [' Is that bad?', ' Should I be worried?', '', ' What does that mean?', ''],
    distress_openings: ['(visibly trembling) ', '(tearful) ', 'I\'m scared — '],
    distress_closings: [' Please tell me it\'s nothing serious.', ' I\'m really frightened.', ''],
  },

  reticent: {
    openings:  ['(reluctantly) ', '', 'I suppose... ', '(long pause) '],
    closings:  ['', '. That\'s it.', ' I don\'t want to talk about it further.', ''],
    distress_openings: ['', '(looks away) ', '(quietly) '],
    distress_closings: ['', ' It hurts to talk about it.', ''],
  },

  cooperative: {
    openings:  ['Sure — ', 'Of course, doctor — ', 'Yes, happy to explain — ', ''],
    closings:  [' I hope that helps.', '', ' Is there anything else you need?', ''],
    distress_openings: ['(clearly distressed but cooperative) ', ''],
    distress_closings: [' But please help me.', ''],
  },

  frightened_child_proxy: { // Used when parent is answering on behalf of child
    openings:  ['(mother, anxiously) ', '(father) ', '(caregiver, very worried) ', ''],
    closings:  [' Please, doctor, help my child.', ' I\'m very worried.', '', ''],
    distress_openings: ['(tearful mother) ', '(distraught parent) '],
    distress_closings: [' My child has never been this sick.', ' Please do something.'],
  },
};

/** Assign temperament to a case based on patient profile */
function assignTemperament(patient) {
  const age = patient?.age || 30;
  const sex = patient?.sex || 'Male';
  // Children → proxy parent temperament
  if (age < 12) return 'frightened_child_proxy';
  // Adolescents → reticent
  if (age >= 12 && age <= 17) return 'reticent';
  // Elderly + male → stoic
  if (age >= 60 && sex === 'Male') return 'stoic';
  // Obstetric cases → anxious
  if (patient?.occupation === 'Trader' || (sex === 'Female' && age < 35)) return 'anxious';
  // Default
  return 'cooperative';
}

/**
 * applyPersonality(baseText, temperament, isDistressed, rng)
 * Wraps the base patient response with personality-appropriate
 * phrasing. rng = a 0–1 number for deterministic variation.
 */
function applyPersonality(baseText, temperament, isDistressed, rng) {
  const T = TEMPERAMENTS[temperament] || TEMPERAMENTS.cooperative;
  const openPool = isDistressed ? T.distress_openings : T.openings;
  const closePool = isDistressed ? T.distress_closings : T.closings;
  const open  = openPool[Math.floor(rng * openPool.length)];
  const close = closePool[Math.floor(rng * closePool.length)];
  // Avoid double-punctuation
  const base  = baseText.trim().replace(/\.$/, '');
  return `${open}${base}${close}`.trim();
}

/** isDistressedIntent — intents that represent distressing symptoms */
const DISTRESS_INTENTS = new Set([
  'sr_seizures','sr_consciousness','sr_chest_pain','sr_fetal_movement',
  'hpc_character','exam_neuro','exam_general',
]);

// ══════════════════════════════════════════════════════════════
//  UPGRADE 4 — KNOWLEDGE EXPANSION (BUILT-IN PEARL BANK)
//  Provides clinical teaching pearls for every intent. These
//  fire when the intent is scored (mustAsk or shouldAsk).
//  KV overrides the built-in bank if a match is found.
// ══════════════════════════════════════════════════════════════

const BUILTIN_PEARLS = {
  // History pearls
  hpc_onset: {
    _default: 'Always establish the exact timing and mode of onset — sudden (vascular, obstructive) vs gradual (inflammatory, neoplastic) onset has strong diagnostic value.',
    acute_appendicitis: 'Classic appendicitis pain begins peri-umbilically then migrates to RIF (McBurney\'s point) over 12–24 hours — this migration is highly specific.',
    'severe malaria (p. falciparum)': 'In children, P. falciparum progresses to severe disease rapidly — 24–48 hours from onset to cerebral involvement is possible. Always ask about travel to endemic areas.',
    'acute asthma exacerbation': 'Note the trigger for this exacerbation — exercise, allergen, URTI, or medication non-compliance all point to different management priorities.',
  },
  hpc_character: {
    _default: 'Characterise pain using SOCRATES: Site, Onset, Character, Radiation, Associations, Timing, Exacerbating/relieving, Severity.',
    acute_appendicitis: 'Appendicitis pain is typically constant (not colicky), dull initially then sharp — colicky pain suggests bowel obstruction or ureteric colic instead.',
    'decompensated heart failure': 'Orthopnoea (breathlessness on lying flat) + PND (waking gasping) = classic left ventricular failure. Ask how many pillows they sleep with.',
  },
  sr_fever: {
    _default: 'Fever in children: always ask about rigors (suggest bacteraemia/malaria), pattern (continuous vs intermittent), and response to antipyretics.',
    'severe malaria (p. falciparum)': 'Hyperparasitaemia (>2%) defines severe malaria in Nigeria. Fever with altered consciousness = cerebral malaria until proven otherwise. IV artesunate is first-line — NOT chloroquine.',
    'acute appendicitis': 'Low-grade fever (38–38.5°C) with RIF pain and leucocytosis = Alvarado score feature. High fever (>39°C) suggests perforation.',
  },
  sr_seizures: {
    _default: 'Classify seizure type: focal vs generalised, tonic-clonic vs absence. Post-ictal confusion differentiates seizure from syncope.',
    'severe malaria (p. falciparum)': 'Seizures in severe malaria = cerebral malaria (WHO criterion). Treat with IV artesunate + IV diazepam for active seizures. Avoid LP until cerebral oedema is excluded.',
  },
  sr_consciousness: {
    _default: 'Use GCS (Eyes 1–4, Verbal 1–5, Motor 1–6) to objectively document consciousness. GCS ≤8 = intubation threshold.',
    'severe malaria (p. falciparum)': 'Blantyre Coma Scale is used for young children (adapted GCS). Score ≤2 = cerebral malaria.',
  },
  sr_jaundice: {
    _default: 'Pre-hepatic (haemolysis) → unconjugated bilirubin → dark urine absent. Hepatic → conjugated + unconjugated. Post-hepatic (obstruction) → pale stool, dark urine, pruritus.',
    'severe malaria (p. falciparum)': 'Jaundice in malaria = haemolytic (RBC destruction by P. falciparum). Bilirubin >3mg/dL is a WHO severe malaria criterion.',
  },
  sr_oedema: {
    _default: 'Oedema distribution: bilateral pitting = cardiac/renal/hepatic; unilateral = DVT/lymphoedema; facial = nephrotic/anaphylaxis. Always check JVP.',
    'decompensated heart failure': 'Bilateral pitting oedema + raised JVP + basal crepitations = classic right heart failure triad. Ask about when it\'s worse (evening = dependent oedema).',
    'severe pre-eclampsia': 'Rapidly worsening oedema + proteinuria + hypertension after 20 weeks = pre-eclampsia. Facial puffiness is particularly significant.',
  },
  shx_travel: {
    _default: 'Travel history is essential for tropical infections. Ask about: destination, duration, malaria prophylaxis, insect exposure, water/food safety.',
    'severe malaria (p. falciparum)': 'Exposure to Anopheles mosquitoes in rural/peri-urban Nigeria is the key risk factor. Incubation period for P. falciparum is 7–14 days.',
  },
  parity: {
    _default: 'Parity notation: G (gravida) = total pregnancies; P (para) = deliveries after 28 weeks; + number of miscarriages/terminations.',
    'severe pre-eclampsia': 'Nulliparity is the strongest risk factor for pre-eclampsia (6× risk). Also: multiple gestation, prior PE, diabetes, renal disease, BMI >35.',
  },
  antenatal: {
    _default: 'WHO ANC schedule recommends ≥8 contacts. In Nigeria: booking visit <12 weeks, BP at every visit, glucose challenge at 24–28 weeks.',
    'severe pre-eclampsia': 'New-onset hypertension (≥140/90) + proteinuria after 20 weeks = pre-eclampsia. A previously normal BP at ANC that suddenly rises is a red flag.',
  },
  immunisation: {
    _default: 'Nigerian EPI schedule: BCG + OPV0 at birth; Penta 1/2/3 + OPV1/2/3 + PCV at 6/10/14 weeks; MCV1 at 9 months; MCV2 + YF at 12–15 months.',
    'severe malaria (p. falciparum)': 'R21/Matrix-M malaria vaccine (2023 WHO recommendation) reduces severe malaria by ~75% in high-transmission areas. Ask if child received it.',
  },
  pmh_general: {
    _default: 'Past medical history mnemonic: MJ THREADS — Medication, Jaundice, TB, Heart disease, Rheumatic fever, Epilepsy, Asthma, Diabetes, Stroke.',
    'acute asthma exacerbation': 'Previous ICU admission, intubation, or >2 hospitalisations/year = markers of high-risk asthma. These patients need aggressive early treatment.',
    'decompensated heart failure': 'Prior MI + long-standing hypertension = ischaemic cardiomyopathy. Running out of diuretics (like frusemide) is a classic precipitant of decompensation.',
  },
  meds_general: {
    _default: 'Always ask about: prescription drugs, OTC drugs, herbal/traditional medicine (common in Nigeria), nutritional supplements, inhalers, and missed doses.',
    'acute asthma exacerbation': 'SABA (salbutamol) use >3×/week = poorly controlled asthma. Non-compliance with ICS (brown inhaler) is the single most common trigger for exacerbations.',
    'decompensated heart failure': 'Running out of loop diuretics (frusemide) is the #1 precipitant of hospital admission in known heart failure patients in Nigeria.',
  },
  fhx_general: {
    _default: 'Draw a 3-generation pedigree when FHx is significant. Document age of onset in affected relatives — early MI in 1st-degree relatives (<55 M / <65 F) = familial hypercholesterolaemia.',
    'acute asthma exacerbation': 'Atopy (asthma, eczema, allergic rhinitis) is strongly familial. FHx of asthma in a 1st-degree relative doubles the child\'s risk.',
  },
  allergies_general: {
    _default: 'For every allergy: document the drug, the reaction type (rash, anaphylaxis, GI intolerance), severity, and whether it was IgE-mediated.',
  },
  shx_general: {
    _default: 'Social history covers: smoking (pack-years), alcohol (units/week), occupation (occupational exposure), housing, dependants, and recreational drugs.',
  },
  // Examination pearls
  exam_general: {
    _default: 'General survey: Assess ABC first. Then: nutrition status (MUAC in children), hydration, pallor, jaundice, cyanosis, clubbing, lymphadenopathy, oedema.',
    'severe malaria (p. falciparum)': 'WHO severe malaria signs: impaired consciousness, respiratory distress, circulatory collapse, abnormal bleeding, severe anaemia (Hb <5g/dL), hyperparasitaemia.',
    'severe acute malnutrition': 'SAM criteria: MUAC <11.5cm OR WHZ <−3 OR bilateral pitting oedema. Bilateral oedema = kwashiorkor even if weight appears normal.',
  },
  exam_cardiovascular: {
    _default: 'Cardiac auscultation: listen at apex (mitral), lower sternal border (tricuspid), 2nd R ICS (aortic), 2nd L ICS (pulmonary). Identify S1/S2, murmurs (grade 1–6), added sounds.',
    'decompensated heart failure': 'S3 gallop (3rd heart sound) = ventricular dysfunction — the most specific bedside sign of decompensated LVF. Displaced apex = cardiomegaly.',
  },
  exam_chest: {
    _default: 'Respiratory exam: Inspect (expansion, accessory muscles) → Palpate (TVF) → Percuss (resonant/dull/stony dull) → Auscultate (breath sounds, added sounds).',
    'acute asthma exacerbation': 'Polyphonic expiratory wheeze = airflow obstruction. Silent chest = near-fatal asthma (no wheeze = no airflow). A normalising PaCO2 in severe asthma is a PRE-ARREST sign.',
    'decompensated heart failure': 'Bilateral basal fine inspiratory crackles = pulmonary oedema. Stony dull + reduced breath sounds at base = pleural effusion (common in heart failure).',
  },
  exam_abdomen: {
    _default: 'Abdominal exam: Inspect → Superficial palpation (guarding, rigidity) → Deep palpation (organomegaly, masses) → Percussion (shifting dullness) → Auscultate (bowel sounds).',
    acute_appendicitis: 'McBurney\'s point (1/3 from ASIS to umbilicus), Rovsing\'s sign, Psoas sign, Obturator sign — all increase LR for appendicitis. Alvarado score ≥7 = surgical referral.',
    'severe malaria (p. falciparum)': 'Hepatosplenomegaly is the hallmark of chronic/severe malaria. Massively enlarged spleen (>5cm) in children = hyperreactive malarial splenomegaly.',
  },
  exam_neuro: {
    _default: 'Neurological exam: Consciousness (GCS) → Cranial nerves → Motor (power/tone/reflexes) → Sensory → Coordination (cerebellar) → Gait. Document any focal deficits.',
    'severe malaria (p. falciparum)': 'Neck stiffness in malaria: can occur (meningism) but LP is only done after stabilisation and clinical exclusion of raised ICP (papilloedema, focal neurology).',
    'severe pre-eclampsia': 'Hyperreflexia + clonus (≥3 beats) = impending eclampsia. Treat with IV/IM magnesium sulphate IMMEDIATELY. MgSO4 is the drug of choice for eclampsia prophylaxis in Nigeria.',
  },
  exam_specific_signs: {
    _default: 'Special tests should be used to confirm or refute your leading differential — they are hypothesis-driven, not routine.',
    acute_appendicitis: 'Rovsing\'s sign (LIF pressure → RIF pain) has LR+ ~2.5 for appendicitis. Combined with McBurney\'s tenderness + fever + leucocytosis = Alvarado score ≥7.',
  },
  exam_skin: {
    _default: 'Skin examination: document lesion morphology (macule/papule/vesicle/pustule/nodule), distribution, colour, borders, associated features (excoriation, secondary infection).',
  },
  // Investigation pearls
  ix_fbc: {
    _default: 'Interpret FBC systematically: Hb (anaemia severity) → WBC (infection, leukaemia) → Differential (neutrophilia = bacterial; lymphocytosis = viral; eosinophilia = parasitic/allergic) → Platelets.',
    'severe malaria (p. falciparum)': 'Thrombocytopaenia (platelets <150) is almost universal in malaria. Severe anaemia (Hb <5g/dL) = blood transfusion threshold in children with respiratory distress.',
    'decompensated heart failure': 'Anaemia is a common precipitant of heart failure decompensation — always check Hb. Normocytic anaemia of chronic disease is common in heart failure.',
  },
  ix_rdt: {
    _default: 'Malaria RDT detects HRP-2 (P. falciparum-specific) and pLDH (pan-malarial). High sensitivity ~95% for P. falciparum. Can remain positive for 2 weeks after treatment.',
    'severe malaria (p. falciparum)': 'A positive RDT in a child with altered consciousness = severe malaria until proven otherwise. Do NOT wait for blood film before starting IV artesunate.',
  },
  ix_thickfilm: {
    _default: 'Thick blood film is the gold standard for malaria diagnosis — allows species identification and quantification of parasitaemia. Giemsa stain required.',
    'severe malaria (p. falciparum)': 'Parasitaemia >2% = hyperparasitaemia = one of WHO\'s severe malaria criteria. Multiple ring forms + banana-shaped gametocytes on thin film = P. falciparum.',
  },
  ix_lft: {
    _default: 'LFT interpretation: AST/ALT elevation = hepatocellular damage; ALP/GGT elevation = cholestatic. AST:ALT ratio >2:1 = alcoholic liver disease. BNP >100pg/mL = heart failure until proven otherwise.',
    'decompensated heart failure': 'BNP >400pg/mL = high probability of HF. NT-proBNP >900pg/mL in patients >50 years. BNP is useful to guide diuretic titration and predict prognosis.',
  },
  ix_urinalysis: {
    _default: 'Urine dipstick: glucose (DM), protein (renal/cardiac/pre-eclampsia), blood (UTI/stones/glomerulonephritis), nitrites+leucocytes = UTI.',
    'severe pre-eclampsia': 'Protein 2+ on dipstick = ≥300mg/24hr = significant proteinuria. Combined with BP ≥140/90 after 20 weeks = pre-eclampsia. Spot protein:creatinine ratio >30mg/mmol is confirmatory.',
  },
  ix_pefr: {
    _default: 'PEFR interpretation: >75% predicted = mild; 50–75% = moderate; 33–50% = severe; <33% = life-threatening. Always compare to patient\'s personal best.',
    'acute asthma exacerbation': 'PEFR <50% = severe acute asthma → needs salbutamol nebulisation + systemic corticosteroids + oxygen + close monitoring. PEFR <33% = life-threatening.',
  },
  ix_abg: {
    _default: 'ABG interpretation: pH→ acidosis/alkalosis. PaCO2 → respiratory component. HCO3 → metabolic component. PaO2/FiO2 ratio <300 = acute lung injury.',
    'acute asthma exacerbation': 'In acute asthma, CO2 is initially LOW (hyperventilation). A NORMAL or RISING CO2 in severe asthma = respiratory muscle fatigue = PRE-ARREST. Escalate immediately.',
  },
  ix_cxr: {
    _default: 'Systematic CXR review: ABCDE — Airway (trachea), Bones, Cardiac (CTR <0.5), Diaphragm (under-lung zones), Everything else (hila, vessels, soft tissue).',
    'decompensated heart failure': 'Heart failure CXR: Cardiomegaly (CTR>0.5) + Upper lobe diversion + Kerley B lines + Bat-wing perihilar opacification + Pleural effusion(s) = ABCDE of cardiac failure.',
  },
  ix_ecg: {
    _default: 'ECG interpretation: Rate → Rhythm → Axis → P waves → PR interval → QRS (width/morphology) → ST segment (elevation/depression) → T waves → QTc.',
    'decompensated heart failure': 'LBBB on ECG = cardiomegaly and likely systolic dysfunction. New-onset LBBB with symptoms = treat as acute MI equivalent until proven otherwise (Sgarbossa criteria).',
  },
  ix_crp: {
    _default: 'CRP rises within 4–6 hours of insult. Very high CRP (>150) = bacterial infection, tissue necrosis, or vasculitis. Normal CRP does NOT exclude infection — viral infections may have low CRP.',
    acute_appendicitis: 'CRP >80 + WBC >11 + clinical features = Alvarado score ≥7 → surgical review. CRP >150 in appendicitis context = perforation until proven otherwise.',
  },
};

/**
 * getPearl(intentId, diagnosisPrimary, env)
 * Returns a teaching pearl string (or null) for a given intent.
 * Priority: KV knowledge bank → built-in bank (diagnosis-specific → generic).
 */
async function getPearl(intentId, diagnosisPrimary, env) {
  // 1. Try KV first
  if (env?.KNOWLEDGE_KV) {
    try {
      const diagKey = `topic:${(diagnosisPrimary || '').toLowerCase().replace(/\s+/g, '_')}`;
      const raw = await env.KNOWLEDGE_KV.get(diagKey);
      if (raw) {
        const data = JSON.parse(raw);
        const pearls = data.pearls || data.clinicalPearls;
        if (pearls && pearls[intentId]) return `📚 *Clinical pearl:* ${pearls[intentId]}`;
      }
    } catch (_) {}
    try {
      const raw = await env.KNOWLEDGE_KV.get(`topic:${intentId}`);
      if (raw) {
        const data = JSON.parse(raw);
        const pearl = data.pearl || data.summary;
        if (pearl) return `📚 *Teaching point:* ${pearl}`;
      }
    } catch (_) {}
  }

  // 2. Fall back to built-in pearl bank
  const intentPearls = BUILTIN_PEARLS[intentId];
  if (!intentPearls) return null;
  const diagKey = (diagnosisPrimary || '').toLowerCase();
  const pearl = intentPearls[diagKey] || intentPearls._default || null;
  return pearl ? `📚 *Teaching point:* ${pearl}` : null;
}

// ══════════════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════════════

async function handleHealth(env) {
  return json({
    status: 'online',
    engine: 'ClerkAI Medical Engine v2.0 — Offline Clinical Reasoning Simulator',
    mode: 'rule-based',
    upgrades: ['text-normalisation', 'intent-clustering', 'personality-system', 'knowledge-expansion'],
    timestamp: Date.now(),
    kvBindings: {
      cases: !!env.CASES_KV,
      scores: !!env.SCORES_KV,
      knowledge: !!env.KNOWLEDGE_KV,
    },
  });
}

// ══════════════════════════════════════════════════════════════
//  CASES — GET /cases?discipline=peds|med|surg|og
// ══════════════════════════════════════════════════════════════

async function handleCases(url, env) {
  const discipline = url.searchParams.get('discipline');
  if (!discipline) return err('discipline param required');
  if (env.CASES_KV) {
    const raw = await env.CASES_KV.get(`cases:${discipline}`);
    if (raw) {
      const cases = JSON.parse(raw);
      return json({ cases, source: 'kv', count: cases.length });
    }
  }
  const cases = BUILTIN_CASES.filter(c => c.discipline === discipline);
  return json({ cases, source: 'builtin', count: cases.length });
}

// ══════════════════════════════════════════════════════════════
//  CHAT — POST /chat
//  Body: { caseId, message, conversationHistory, askedIntents }
//  Returns: {
//    reply, intentId, type, score, isDangerous, penalty,
//    pearl, clusterIntents, normalisedText, temperamentApplied
//  }
// ══════════════════════════════════════════════════════════════

async function handleChat(request, env) {
  const body = await request.json();
  const { caseId, message, conversationHistory = [], askedIntents = [] } = body;
  if (!caseId || !message) return err('caseId and message required');

  const caseData = await resolveCase(caseId, env);
  if (!caseData) return err(`Case ${caseId} not found`, 404);

  // ── UPGRADE 1: Normalise text before any matching ──────────
  const normText = normaliseText(message);

  // ── Check for dangerous/penalty-triggering inputs ──────────
  const danger = checkDanger(normText, caseData);
  if (danger) {
    return json({
      reply: danger.explanation,
      intentId: null, type: 'penalty',
      isDangerous: true, penalty: danger.penalty, score: 0,
      normalisedText: normText,
    });
  }

  // ── UPGRADE 2: Intent Clustering — check for broad queries ──
  const clusterIntentIds = resolveClusterIntents(normText, caseData);
  if (clusterIntentIds.length > 1) {
    // Score all cluster intents not yet asked
    const scored = [];
    const replies = [];
    let totalPts = 0;
    for (const id of clusterIntentIds) {
      if (askedIntents.includes(id)) continue;
      const entry = caseData.intentMap[id];
      if (!entry) continue;
      const isMust   = caseData.scoringMap.mustAsk.includes(id);
      const isShould = caseData.scoringMap.shouldAsk.includes(id);
      const pts = isMust ? (caseData.scoringMap.pointsMust || 15)
                : isShould ? (caseData.scoringMap.pointsBase || 10) : 5;
      totalPts += pts;
      scored.push({ intentId: id, score: pts, label: entry.label });
      replies.push(`[${entry.label}] ${entry.text}`);
    }
    // Attach a pearl for the most important intent in the cluster
    const primaryId = scored.find(s => s.score >= 15)?.intentId
                   || scored[0]?.intentId;
    const pearl = primaryId
      ? await getPearl(primaryId, caseData.diagnosis?.primary, env)
      : null;

    return json({
      reply: replies.join('\n\n---\n\n'),
      intentId: primaryId || null,
      type: 'cluster',
      isDangerous: false,
      score: totalPts,
      clusterIntents: scored,
      pearl,
      normalisedText: normText,
    });
  }

  // ── UPGRADE 3: Assign temperament ──────────────────────────
  const temperament = assignTemperament(caseData.patient);

  // ── Classify single intent ──────────────────────────────────
  const intent = classifyIntent(normText, INTENT_PATTERNS);
  if (!intent) {
    const fallback = generateFallback(normText, caseData, conversationHistory);
    return json({
      reply: fallback,
      intentId: null, type: 'fallback',
      isDangerous: false, score: 0,
      normalisedText: normText,
      temperamentApplied: temperament,
    });
  }

  const responseData = caseData.intentMap[intent.id];
  if (!responseData) {
    const notApplicable = generateNotApplicable(intent.id, caseData);
    return json({
      reply: notApplicable,
      intentId: intent.id, type: 'history',
      isDangerous: false, score: 0,
      normalisedText: normText,
      temperamentApplied: temperament,
    });
  }

  // ── Score the intent ────────────────────────────────────────
  const alreadyAsked = askedIntents.includes(intent.id);
  const isMust       = caseData.scoringMap.mustAsk.includes(intent.id);
  const isShould     = caseData.scoringMap.shouldAsk.includes(intent.id);
  const points       = alreadyAsked ? 0
    : isMust   ? (caseData.scoringMap.pointsMust  || 15)
    : isShould ? (caseData.scoringMap.pointsBase  || 10)
    : 5;

  // ── UPGRADE 3: Apply personality to the reply ───────────────
  const isDistressed = DISTRESS_INTENTS.has(intent.id);
  // Simple deterministic RNG seeded by message length + intent id length
  const rng = ((message.length * 7 + intent.id.length * 13) % 100) / 100;
  const wrappedReply = alreadyAsked
    ? responseData.text   // No personality wrapping on repeat questions
    : applyPersonality(responseData.text, temperament, isDistressed, rng);

  // ── UPGRADE 4: Fetch knowledge pearl (only for scored intents)
  const pearl = (!alreadyAsked && (isMust || isShould))
    ? await getPearl(intent.id, caseData.diagnosis?.primary, env)
    : null;

  return json({
    reply: wrappedReply,
    intentId: intent.id,
    type: responseData.type || 'history',
    isDangerous: false,
    score: points,
    alreadyAsked,
    pearl,
    normalisedText: normText,
    temperamentApplied: temperament,
  });
}

// ══════════════════════════════════════════════════════════════
//  SCORES — POST /scores
// ══════════════════════════════════════════════════════════════

async function handleScore(request, env) {
  const body = await request.json();
  const { caseId, studentName, score, penalties, correct, discipline, timeTaken } = body;
  if (!caseId || score == null) return err('caseId and score required');

  if (env.SCORES_KV) {
    const entry = {
      caseId, studentName: studentName || 'Anonymous',
      score, penalties: penalties || 0,
      correct: correct || false,
      discipline: discipline || 'unknown',
      timeTaken: timeTaken || 0,
      timestamp: Date.now(),
    };
    const key = `score:${caseId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await env.SCORES_KV.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 });
    return json({ success: true, key });
  }
  return json({ success: true, stored: false, note: 'SCORES_KV not configured' });
}

// ══════════════════════════════════════════════════════════════
//  LEADERBOARD — GET /leaderboard?discipline=
// ══════════════════════════════════════════════════════════════

async function handleLeaderboard(url, env) {
  const discipline = url.searchParams.get('discipline');
  if (!env.SCORES_KV) return json({ leaderboard: [], note: 'SCORES_KV not configured' });

  const prefix = discipline ? `score:case_${discipline}` : 'score:';
  const keys = await env.SCORES_KV.list({ prefix, limit: 200 });
  const scores = [];
  for (const k of keys.keys) {
    const raw = await env.SCORES_KV.get(k.name);
    if (raw) {
      try { scores.push(JSON.parse(raw)); } catch (_) {}
    }
  }
  scores.sort((a, b) => (b.score - b.penalties) - (a.score - a.penalties));
  return json({ leaderboard: scores.slice(0, 50), total: scores.length });
}

// ══════════════════════════════════════════════════════════════
//  ADMIN — POST /admin/ingest (knowledge bank)
// ══════════════════════════════════════════════════════════════

async function handleIngest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return err('Unauthorised', 401);
  }
  const body = await request.json();
  if (!env.KNOWLEDGE_KV) return err('KNOWLEDGE_KV not configured', 500);
  let ingested = 0;
  for (const [key, value] of Object.entries(body)) {
    await env.KNOWLEDGE_KV.put(key, JSON.stringify(value));
    ingested++;
  }
  return json({ success: true, ingested });
}

// ══════════════════════════════════════════════════════════════
//  ADMIN — POST /admin/ingest-cases
// ══════════════════════════════════════════════════════════════

async function handleIngestCases(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return err('Unauthorised', 401);
  }
  const body = await request.json();
  if (!env.CASES_KV) return err('CASES_KV not configured', 500);
  const { discipline, cases } = body;
  if (!discipline || !Array.isArray(cases)) return err('discipline and cases[] required');
  await env.CASES_KV.put(`cases:${discipline}`, JSON.stringify(cases));
  return json({ success: true, discipline, count: cases.length });
}

// ══════════════════════════════════════════════════════════════
//  ADMIN — GET /admin/knowledge?topic=
// ══════════════════════════════════════════════════════════════

async function handleKnowledgeQuery(url, env) {
  const auth = url.searchParams.get('secret');
  if (!env.ADMIN_SECRET || auth !== env.ADMIN_SECRET) return err('Unauthorised', 401);
  const topic = url.searchParams.get('topic');
  if (!topic) return err('topic param required');
  if (!env.KNOWLEDGE_KV) return err('KNOWLEDGE_KV not configured', 500);
  const raw = await env.KNOWLEDGE_KV.get(`topic:${topic}`);
  if (!raw) return json({ found: false, topic });
  return json({ found: true, topic, data: JSON.parse(raw) });
}

// ══════════════════════════════════════════════════════════════
//  INTENT CLASSIFICATION ENGINE
//  Upgraded: normalised text is passed in; score thresholds
//  are tuned for normalised input.
// ══════════════════════════════════════════════════════════════

function classifyIntent(normText, patterns) {
  let bestMatch = null;
  let bestScore = 0;
  for (const pattern of patterns) {
    let score = 0;
    // Exact phrase matching (highest weight)
    for (const phrase of (pattern.phrases || [])) {
      if (normText.includes(phrase.toLowerCase())) score += 30;
    }
    // Keyword matching
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

// ══════════════════════════════════════════════════════════════
//  DANGER CHECK ENGINE
// ══════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════
//  CONTEXTUAL FALLBACK GENERATOR
// ══════════════════════════════════════════════════════════════

function generateFallback(normText, caseData, history) {
  const age = caseData.patient?.age;
  const complaint = caseData.presentingComplaint;

  if (/treat|manag|give|prescrib|administer|start.*on/i.test(normText)) {
    return `As your clinical tutor: management questions aren't part of the clerking phase. Focus on history, examination, and investigations to reach your diagnosis first.`;
  }
  if (/diagnos|what is|condition|impression|assessment/i.test(normText)) {
    return `Use the "Give Diagnosis" button when you're ready to submit your clinical impression. Continue clerking — you may be missing important history.`;
  }
  if (/thank|okay|ok|noted|i see/i.test(normText)) {
    return `Please continue with your assessment. Ask me about my symptoms, history, medications, or request an examination.`;
  }

  const responses = [
    `I'm not sure I understand that question. Could you rephrase it? I'm here about my ${complaint?.toLowerCase() || 'symptoms'}.`,
    `Sorry, I didn't quite follow that. I'm a ${age}-year-old patient — please ask about my symptoms, history, or how I've been feeling.`,
    `I'm not sure what you mean. You can ask about when it started, what it feels like, my past history, medications, or family history.`,
    `Could you clarify that? I'm happy to tell you more about my ${complaint?.toLowerCase() || 'problem'}.`,
    `I don't understand that question. Perhaps ask about my symptoms, examination findings, or investigations instead.`,
  ];
  return responses[history.length % responses.length];
}

// ══════════════════════════════════════════════════════════════
//  NOT-APPLICABLE RESPONSE GENERATOR
// ══════════════════════════════════════════════════════════════

function generateNotApplicable(intentId, caseData) {
  const age  = caseData.patient?.age;
  const sex  = caseData.patient?.sex || 'Unknown';
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

// ══════════════════════════════════════════════════════════════
//  CASE LOADER
// ══════════════════════════════════════════════════════════════

async function resolveCase(caseId, env) {
  if (env.CASES_KV) {
    try {
      const raw = await env.CASES_KV.get(`case:${caseId}`);
      if (raw) return JSON.parse(raw);
      // Also try loading from the discipline bulk store
      const disciplines = ['peds','med','surg','og'];
      for (const disc of disciplines) {
        const bulk = await env.CASES_KV.get(`cases:${disc}`);
        if (bulk) {
          const arr = JSON.parse(bulk);
          const found = arr.find(c => c.caseId === caseId);
          if (found) return found;
        }
      }
    } catch (_) {}
  }
  return BUILTIN_CASES.find(c => c.caseId === caseId) || null;
}

// ══════════════════════════════════════════════════════════════
//  GLOBAL DANGEROUS PATTERNS
// ══════════════════════════════════════════════════════════════

const GLOBAL_DANGEROUS_PATTERNS = [
  {
    pattern: /\baspirin\b/i, penalty: 20,
    explanation: '⛔ Aspirin is contraindicated in children under 16 years (Reye\'s syndrome risk) and should be avoided in febrile illnesses. Deducted −20 pts.',
  },
  {
    pattern: /\bchloroquine\b/i, penalty: 15,
    explanation: '⚠️ Chloroquine-resistant P. falciparum is widespread in Nigeria. First-line for severe malaria is IV artesunate (WHO/FMOH guidelines). Deducted −15 pts.',
  },
  {
    pattern: /\bbeta.?blocker|propranolol|atenolol\b/i, penalty: 20,
    explanation: '⛔ Beta-blockers are absolutely contraindicated in acute asthma — they cause life-threatening bronchospasm. Deducted −20 pts.',
  },
  {
    pattern: /\bnsaid|ibuprofen|diclofenac\b/i, penalty: 15,
    explanation: '⛔ NSAIDs are contraindicated in surgical abdomens (mask peritoneal signs), pregnancy >20 weeks (renal/ductus effects), and active heart failure. Deducted −15 pts.',
  },
  {
    pattern: /\bace.?inhibitor|lisinopril|enalapril|ramipril\b/i, penalty: 15,
    explanation: '⛔ ACE inhibitors are teratogenic in the 2nd and 3rd trimesters and are absolutely contraindicated in pregnancy. Deducted −15 pts.',
  },
  {
    pattern: /\blumbar.?puncture.{0,20}without|lp.{0,20}before.{0,20}stabili/i, penalty: 15,
    explanation: '⚠️ LP should only be performed after stabilising the patient and excluding raised ICP (papilloedema, focal neurology). Deducted −15 pts.',
  },
  {
    pattern: /\bsedati|diazepam.{0,20}asthma|lorazepam.{0,20}respir/i, penalty: 15,
    explanation: '⛔ Sedation in a patient with acute respiratory distress can cause respiratory arrest. Contraindicated in acute asthma and any unprotected airway. Deducted −15 pts.',
  },
];

// ══════════════════════════════════════════════════════════════
//  INTENT PATTERN LIBRARY
// ══════════════════════════════════════════════════════════════

const INTENT_PATTERNS = [
  // ── History of Presenting Complaint ──────────────────────────
  { id:'hpc_onset',       keywords:['when','start','began','how long','duration','onset','since','ago','period','days','weeks','months','first notice','first felt','beginning','first time','come on','started','come about','begin'],
    phrases:['when did','how long have','when did it start','how did it start','when did the pain begin','how long ago','how long has this been going on','when did you first notice','when did your symptoms start','when did this begin'] },
  { id:'hpc_character',   keywords:['character','nature','describe','what kind','type','sort','like','feel like','quality','sharp','dull','throbbing','constant','aching','burning','cramp','colicky','pressure','tight','heavy','stabbing','squeezing','worse','better'],
    phrases:['describe the pain','what does it feel like','what kind of pain','what is the pain like','can you describe','what type of pain','is the pain sharp','is it constant','does the pain come and go','what is the character of the pain','how would you describe it','what sort of pain'] },
  { id:'hpc_radiation',   keywords:['radiat','spread','go','move','extend','travel','jaw','arm','back','groin','leg','shoulder','neck','radiation','elsewhere'],
    phrases:['does the pain spread','does it radiate','does it go anywhere','does the pain travel','does it go to your back','does the pain move'] },
  { id:'hpc_relieving',   keywords:['better','relieve','help','relief','ease','reducing','alleviates','reduce','improve','lying','sitting','standing','rest','eating'],
    phrases:['what makes it better','does anything help','what relieves it','what makes the pain go away','anything that helps','does rest help','does lying down help'] },
  { id:'hpc_associated',  keywords:['associated','other','also','alongside','accompanying','together with','in addition','at the same time','symptoms','problems','else','anything else wrong'],
    phrases:['any other symptoms','associated symptoms','anything else','are there any other symptoms','any other problems','anything else bothering you'] },
  { id:'hpc_triggers',    keywords:['trigger','cause','start','bring on','precipitate','provoke','worsen','worse with','aggravate','what causes','what brings on','exercise','cold','stress','dust','pollen','pet','cat','dog','food','smell'],
    phrases:['what triggers','what causes it','what makes it worse','what brings it on','any triggers','does anything trigger','does exercise trigger','anything that worsens'] },
  { id:'hpc_orthopnoea',  keywords:['lie down','lying down','flat','pillow','orthopnoea','breathless lying','sleeping position','how many pillows','prop up'],
    phrases:['can you lie flat','how many pillows','breathless when lying','orthopnoea','do you sleep propped up','breathlessness on lying down'] },

  // ── Systems Review ────────────────────────────────────────────
  { id:'sr_fever',        keywords:['fever','temperature','hot','pyrexia','febrile','chills','rigors','shivering','sweating','sweats','night sweats','hypothermia','body hot'],
    phrases:['any fever','any temperature','do you have fever','feeling hot','any chills','any rigors','any night sweats','any shivering','is there fever'] },
  { id:'sr_nausea',       keywords:['nausea','vomit','sick','vomiting','retching','throw up','nauseated','vomited','emesis','morning sickness'],
    phrases:['any nausea','any vomiting','have you vomited','feeling sick','any sickness','do you feel sick','any retching','have you been sick'] },
  { id:'sr_seizures',     keywords:['seizure','fit','convulsion','shake','jerk','twitch','epilepsy','tonic','clonic','postictal','unconscious during','febrile convulsion'],
    phrases:['any seizures','any fits','any convulsions','did they shake','any jerking','any twitching','did they lose consciousness with shaking','any epileptic fits','febrile convulsion'] },
  { id:'sr_consciousness',keywords:['conscious','consciousness','unconscious','awareness','alert','drowsy','lethargy','lethargic','confused','confusion','gcs','altered','unresponsive','level of consciousness'],
    phrases:['any change in consciousness','are they alert','are they drowsy','any confusion','are they unresponsive','level of consciousness','are they lethargic','were they conscious'] },
  { id:'sr_jaundice',     keywords:['yellow','jaundice','icteric','sclera','eyes yellow','pale stool','dark urine','pruritus','itch','cholestasis','bilirubin'],
    phrases:['any jaundice','yellow eyes','yellow skin','are their eyes yellow','any pale stools','any dark urine','any itching','are they jaundiced'] },
  { id:'sr_oedema',       keywords:['swelling','oedema','edema','puffy','swollen','fluid','ankle','leg','face','sacral','abdominal distension','ascites'],
    phrases:['any swelling','ankle swelling','leg swelling','facial swelling','any oedema','are the ankles swollen','any fluid retention'] },
  { id:'sr_chest_pain',   keywords:['chest pain','chest tightness','chest pressure','angina','cardiac','retrosternal','precordial','chest discomfort','chest heaviness','substernal'],
    phrases:['any chest pain','any chest tightness','pain in your chest','chest discomfort','any pressure in the chest','retrosternal pain'] },
  { id:'sr_appetite',     keywords:['appetite','eat','food','hungry','meal','diet','anorexia','loss of appetite','reduced appetite'],
    phrases:['how is your appetite','are you eating','any change in appetite','loss of appetite'] },
  { id:'sr_bowels',       keywords:['bowels','stool','poo','diarrhoea','diarrhea','constipation','blood stool','melaena','change bowel','loose stool'],
    phrases:['any bowel changes','any diarrhoea','any constipation','blood in stool','bowel habits'] },
  { id:'sr_urinary',      keywords:['urine','urinary','pee','bladder','burning','dark','frequency','urgency','dysuria','haematuria','blood in urine','nocturia','passing urine','less urine','oliguria','frothy'],
    phrases:['any urinary symptoms','burning when passing urine','dark urine','how is your urine','blood in urine','any urinary frequency','urine output','any frothy urine'] },
  { id:'sr_fetal_movement',keywords:['baby','fetal','fetus','kick','movement','move','feel baby','baby moving'],
    phrases:['is baby moving','any fetal movement','can you feel the baby','baby kicks','has baby been moving','reduced fetal movement'] },
  { id:'sr_abdominal',    keywords:['abdominal pain','belly pain','stomach pain','epigastric','right upper quadrant','ruq','upper abdominal'],
    phrases:['any abdominal pain','any upper abdominal pain','any epigastric pain','any right upper quadrant pain','any belly pain'] },

  // ── Social & Other History ────────────────────────────────────
  { id:'shx_travel',      keywords:['travel','trip','visit','journey','abroad','visited','returned','forest','rural','endemic','outside','bush'],
    phrases:['any recent travel','have you travelled','any travel history','been anywhere recently','visited any endemic area','been to any rural area','forest area'] },
  { id:'parity',          keywords:['parity','gravida','para','previous pregnancy','first pregnancy','second pregnancy','how many children','obstetric history','miscarriage','abortion','stillbirth','previous delivery'],
    phrases:['obstetric history','parity','any previous pregnancies','how many children','first pregnancy','any miscarriages','previous deliveries'] },
  { id:'antenatal',       keywords:['antenatal','anc','booking','antenatal care','scan','ultrasound scan','booking visit','gestation','weeks pregnant','trimester'],
    phrases:['antenatal history','any anc visits','have you been attending antenatal','booking visit','any scans done','gestation','how many weeks pregnant'] },
  { id:'immunisation',    keywords:['vaccine','vaccination','immunisation','immunization','epi','jab','bcg','dpt','measles','yellow fever','malaria vaccine','rts','r21'],
    phrases:['any vaccinations','immunisation history','is the child vaccinated','up to date with vaccines','any vaccines given','bcg vaccine','epi schedule','malaria vaccine'] },
  { id:'pmh_general',     keywords:['history','past','medical','illness','condition','admit','operation','surgery','previous','hypertension','diabetes','asthma','epilepsy','hospital','chronic','disease'],
    phrases:['past medical history','any medical conditions','ever admitted','any previous illness','any chronic conditions','any previous surgery','any medical problems'] },
  { id:'meds_general',    keywords:['medication','drug','tablet','capsule','injection','inhaler','medicine','prescription','taking','herbal','traditional','supplement','water tablet','regular medication'],
    phrases:['any medications','what medications','any drugs','on any treatment','any tablets','any herbal remedies','traditional medicine','any prescriptions'] },
  { id:'allergies_general',keywords:['allerg','allergic','reaction','sensitivity','intolerance','rash','anaphylaxis','drug reaction'],
    phrases:['any allergies','are you allergic','any drug allergies','any reactions to medication','allergic to anything'] },
  { id:'fhx_general',     keywords:['family','father','mother','parent','sibling','brother','sister','relative','hereditary','genetic','runs in family'],
    phrases:['family history','any family history','any hereditary conditions','does it run in the family','parents have any conditions'] },
  { id:'shx_general',     keywords:['smoke','smoking','alcohol','drink','work','occupation','job','live','married','social','exercise','diet','recreational'],
    phrases:['do you smoke','any alcohol','what is your occupation','social history','smoking history','alcohol intake'] },

  // ── Examination ───────────────────────────────────────────────
  { id:'exam_general',          keywords:['general','appearance','vital signs','vitals','temperature','pulse','blood pressure','respiratory rate','spo2','oxygen saturation','weight','pallor','cyanosis','jaundice','clubbing','oedema','dehydration'],
    phrases:['general examination','examine generally','vital signs','take vitals','general appearance','check vitals','measure temperature','blood pressure','general survey'] },
  { id:'exam_cardiovascular',   keywords:['cardiovascular','heart','cardiac','apex','murmur','auscultate','heart sounds','jvp','jugular','peripheral pulses','precordium'],
    phrases:['examine the heart','cardiovascular examination','cardiac examination','listen to the heart','heart sounds','check jvp','examine the cardiovascular system'] },
  { id:'exam_chest',            keywords:['chest','respiratory','lung','lungs','breath','wheeze','crackle','breath sounds','air entry','percussion','trachea','hyperinflation'],
    phrases:['examine the chest','respiratory examination','listen to the lungs','breath sounds','any wheeze','chest examination'] },
  { id:'exam_abdomen',          keywords:['abdomen','abdominal','belly','stomach','liver','spleen','kidney','guarding','rigidity','tenderness','masses','bowel sounds','palpate','ascites','distension'],
    phrases:['examine the abdomen','abdominal examination','palpate the abdomen','any tenderness','check for guarding'] },
  { id:'exam_neuro',            keywords:['neuro','neurological','reflexes','power','tone','sensation','gcs','consciousness','pupils','cranial nerves','cerebellar','coordination','orientation','clonus'],
    phrases:['neurological examination','examine neurologically','check reflexes','gcs','pupils','check for clonus','check deep tendon reflexes'] },
  { id:'exam_skin',             keywords:['skin','rash','lesion','macule','papule','vesicle','dermatology','eczema','erythema','petechiae','purpura','pallor conjunctivae'],
    phrases:['examine the skin','any rash','skin examination','any skin lesions','skin inspection','check pallor'] },
  { id:'exam_lymph_nodes',      keywords:['lymph','lymph nodes','lymphadenopathy','glands','cervical','axillary','inguinal','swollen glands'],
    phrases:['check lymph nodes','lymph node examination','any swollen glands','palpate lymph nodes'] },
  { id:'exam_specific_signs',   keywords:['specific','mcburney','rovsing','psoas','obturator','murphy','kernig','brudzinski','special signs'],
    phrases:["mcburney's point","rovsing's sign","psoas sign","murphy's sign","kernig's sign",'specific signs','special tests'] },

  // ── Investigations ────────────────────────────────────────────
  { id:'ix_fbc',        keywords:['fbc','full blood count','blood count','cbc','haemoglobin','hb','wbc','white blood cell','platelets','neutrophils','haematology','blood test','anaemia'],
    phrases:['order fbc','full blood count','check fbc','blood count','haematology'] },
  { id:'ix_ultrasound', keywords:['ultrasound','uss','sonogram','scan','echo','abdominal imaging','abdominal ultrasound'],
    phrases:['order ultrasound','abdominal ultrasound','ultrasound scan','request uss','order abdominal ultrasound'] },
  { id:'ix_crp',        keywords:['crp','c reactive protein','esr','inflammatory markers','erythrocyte sedimentation'],
    phrases:['check crp','inflammatory markers','c reactive protein','esr'] },
  { id:'ix_urinalysis', keywords:['urinalysis','urine dipstick','mcs','urine culture','mid stream','urine test','urine analysis','dipstick','protein urine'],
    phrases:['urinalysis','urine test','dipstick urine','urine dipstick','midstream urine','urine sample','urine protein'] },
  { id:'ix_pefr',       keywords:['pefr','peak flow','peak expiratory flow','spirometry','flow rate'],
    phrases:['check pefr','peak flow','peak expiratory flow','spirometry','measure peak flow'] },
  { id:'ix_abg',        keywords:['abg','arterial blood gas','blood gas','ph','pao2','paco2','oxygen','co2','bicarbonate'],
    phrases:['arterial blood gas','abg','blood gases','check blood gas','check ph'] },
  { id:'ix_cxr',        keywords:['cxr','chest xray','chest x ray','chest radiograph','chest film','radiology chest'],
    phrases:['chest xray','cxr','order cxr','chest x ray','chest radiograph'] },
  { id:'ix_rdt',        keywords:['rdt','malaria test','rapid diagnostic test','malaria rdt','malaria antigen'],
    phrases:['malaria rdt','rapid diagnostic test','test for malaria','rdt','order malaria test'] },
  { id:'ix_thickfilm',  keywords:['thick film','thin film','blood film','blood smear','malaria film','giemsa','parasitaemia'],
    phrases:['blood film','thick and thin film','malaria smear','blood smear','order blood film'] },
  { id:'ix_lft',        keywords:['lft','liver function','liver enzymes','ast','alt','alp','bilirubin','albumin','bnp','renal profile','urea','creatinine'],
    phrases:['liver function tests','lft','liver enzymes','check liver function','bnp','renal function','urea and electrolytes'] },
  { id:'ix_ecg',        keywords:['ecg','ekg','electrocardiogram','heart tracing','twelve lead','cardiac tracing'],
    phrases:['order ecg','ecg','electrocardiogram','heart tracing','12 lead'] },
];

// ══════════════════════════════════════════════════════════════
//  BUILT-IN CASE BANK
//  (mirrors the HTML front-end fallback cases)
// ══════════════════════════════════════════════════════════════

const BUILTIN_CASES = [
  {
    caseId: 'case_surg_appendicitis_001',
    discipline: 'surg', difficulty: 'intermediate', timeLimit: 600,
    hospital: 'LUTH Lagos',
    patient: { name: 'Chidi Nwosu', age: 19, sex: 'Male', occupation: 'University Student', avatar: '🧑' },
    presentingComplaint: 'Severe right-sided abdominal pain for 18 hours',
    diagnosis: { primary: 'Acute Appendicitis', keywords: ['appendicitis','acute appendicitis','appendix'] },
    differentials: [
      { name: 'Acute Appendicitis',    color: '#2A5A8A', initial: 35 },
      { name: 'Mesenteric Adenitis',   color: '#5B3F8A', initial: 25 },
      { name: "Meckel's Diverticulitis", color: '#9B3535', initial: 20 },
      { name: 'Right Ureteric Colic',  color: '#7A8F9E', initial: 20 },
    ],
    trapActions: [
      { pattern: /nsaid|ibuprofen|diclofenac/i,                 penalty: 15, explanation: '⛔ NSAIDs mask peritoneal signs and worsen GI bleeding in surgical abdomens. Deducted −15 pts.' },
      { pattern: /morphine.*before.*exam|opioid.*before.*assess/i, penalty: 15, explanation: '⚠️ Administering opioids before completing the surgical assessment can mask signs. Deducted −15 pts.' },
    ],
    intentMap: {
      hpc_onset:       { text: "It started about 18 hours ago. First it was around my belly button, then moved to the right side of my stomach. It's been getting worse.", type:'history', label:'Onset & Migration' },
      hpc_character:   { text: "It's a constant, sharp pain. Not colicky — it doesn't come and go. It's there all the time and getting worse. Moving makes it worse.", type:'history', label:'Character' },
      hpc_radiation:   { text: "It doesn't really go anywhere — it just stays in the right lower part of my stomach.", type:'history', label:'Radiation' },
      sr_fever:        { text: "Yes, I've been feeling hot since this morning. My flatmate took my temperature — it was 38.2°C.", type:'history', label:'Fever' },
      sr_nausea:       { text: "Yes, I vomited twice — once last night and once this morning. No appetite at all.", type:'history', label:'Nausea/Vomiting' },
      sr_bowels:       { text: "I haven't opened my bowels since yesterday. Before this started I was normal — once a day.", type:'history', label:'Bowel history' },
      pmh_general:     { text: "I've been healthy — no medical conditions. Never been admitted to hospital before.", type:'history', label:'Past medical history' },
      meds_general:    { text: "Nothing regular. I took paracetamol this morning but it didn't really help.", type:'history', label:'Medications' },
      allergies_general:{ text: "No allergies that I know of.", type:'history', label:'Allergies' },
      shx_general:     { text: "Final year student at UNILAG. I don't smoke or drink. I'm not sexually active.", type:'history', label:'Social history' },
      fhx_general:     { text: "No, nobody in my family has had appendicitis or bowel problems.", type:'history', label:'Family history' },
      exam_general:    { text: 'General: Unwell-looking, lying still (movement worsens pain). Temp 38.4°C. Pulse 102 bpm (tachycardia). BP 118/76. RR 18. SpO₂ 98% on air. Mildly dehydrated — dry tongue.', type:'exam', label:'General examination' },
      exam_abdomen:    { text: "Abdomen: Flat. Maximal tenderness at McBurney's point (2/3 from umbilicus to ASIS). Guarding present in RIF. Rovsing's sign positive — pressure on LIF causes RIF pain. Bowel sounds reduced.", type:'exam', label:'Abdominal examination' },
      exam_specific_signs: { text: "McBurney's point tenderness: +++ (maximal). Rovsing's sign: Positive. Psoas sign: Positive (pain on right hip extension). Obturator sign: Borderline positive.", type:'exam', label:'Special signs' },
      ix_fbc:          { text: 'FBC:\n• WBC: 15.8 × 10⁹/L ↑ (neutrophilia: 13.2 × 10⁹/L)\n• Hb: 14.1 g/dL (normal)\n• Platelets: 310 × 10⁹/L (normal)\n→ Leukocytosis with left shift, consistent with bacterial/surgical inflammation.', type:'investigation', label:'FBC' },
      ix_crp:          { text: 'CRP: 98 mg/L ↑↑ (markedly raised — consistent with acute inflammation)', type:'investigation', label:'CRP' },
      ix_ultrasound:   { text: 'USS Abdomen:\n• Non-compressible, dilated appendix — diameter 10mm (>6mm = abnormal)\n• Periappendiceal fat stranding\n• No perforation or abscess identified\n→ Findings consistent with acute appendicitis.', type:'investigation', label:'USS Abdomen' },
      ix_urinalysis:   { text: 'Urinalysis: Trace leucocytes (non-specific, can be due to adjacent inflammation). No nitrites. No blood.\n→ Does not suggest UTI; sterile pyuria can occur in appendicitis.', type:'investigation', label:'Urinalysis' },
    },
    scoringMap: { mustAsk: ['hpc_onset','hpc_character','sr_fever','exam_abdomen'], shouldAsk: ['sr_nausea','exam_specific_signs','ix_fbc','ix_ultrasound'], pointsBase: 5, pointsMust: 15 },
  },
  {
    caseId: 'case_peds_malaria_001',
    discipline: 'peds', difficulty: 'beginner', timeLimit: 480,
    hospital: 'UCH Ibadan',
    patient: { name: 'Emeka Adeyemi', age: 4, sex: 'Male', occupation: 'Pre-school', avatar: '👦' },
    presentingComplaint: 'High fever, vomiting and drowsiness for 2 days',
    diagnosis: { primary: 'Severe Malaria (P. falciparum)', keywords: ['malaria','severe malaria','cerebral malaria','falciparum malaria','plasmodium falciparum'] },
    differentials: [
      { name: 'Severe Malaria',       color: '#1A7A6E', initial: 40 },
      { name: 'Bacterial Meningitis', color: '#9B3535', initial: 25 },
      { name: 'Typhoid Encephalopathy', color: '#B86A10', initial: 20 },
      { name: 'Viral Encephalitis',   color: '#5B3F8A', initial: 15 },
    ],
    trapActions: [
      { pattern: /aspirin/i,                                       penalty: 20, explanation: "⛔ Aspirin is contraindicated in children — risk of Reye's syndrome. Deducted −20 pts." },
      { pattern: /chloroquine/i,                                   penalty: 15, explanation: '⚠️ Chloroquine-resistant P. falciparum is widespread in Nigeria. First-line is IV artesunate for severe malaria. Deducted −15 pts.' },
      { pattern: /lumbar puncture.*without|lp.*before.*stabiliz/i, penalty: 15, explanation: '⚠️ LP should only be performed after stabilising the patient and ruling out raised ICP clinically. Deducted −15 pts.' },
    ],
    intentMap: {
      hpc_onset:       { text: "He started with fever 2 days ago — very high. Yesterday he began vomiting and became drowsy. This morning I couldn't wake him properly.", type:'history', label:'Onset' },
      hpc_character:   { text: 'The fever came suddenly and is very high — I could feel the heat from his body. He\'s also been shivering at times.', type:'history', label:'Fever character' },
      sr_fever:        { text: "Yes, very high fever — 39.8°C when we checked. With rigors earlier. It went down slightly with paracetamol but came back.", type:'history', label:'Fever' },
      sr_seizures:     { text: "Yes! He had one fit this morning — he shook all over for about 2–3 minutes. He was confused afterwards.", type:'history', label:'Seizures' },
      sr_consciousness:{ text: "He was alert before, but now he's very drowsy — I have to shake him to wake him. He doesn't recognise me properly.", type:'history', label:'Consciousness' },
      sr_jaundice:     { text: "His eyes looked slightly yellow since yesterday. I wasn't sure if I was imagining it.", type:'history', label:'Jaundice' },
      sr_nausea:       { text: "He has vomited 5–6 times today. He can't keep anything down — not even water.", type:'history', label:'Vomiting' },
      shx_travel:      { text: "We live in Ibadan. Last week we visited relatives in a village near Abeokuta — they have a lot of mosquitoes there.", type:'history', label:'Travel/exposure' },
      pmh_general:     { text: "He had malaria once before at age 2. No other serious illness. He was born well — no complications.", type:'history', label:'Past medical history' },
      immunisation:    { text: "He is up to date on his EPI vaccines. He received the R21 malaria vaccine at age 1.", type:'history', label:'Immunisation' },
      meds_general:    { text: "We gave him paracetamol syrup. That's all — nothing else.", type:'history', label:'Medications' },
      exam_general:    { text: 'General: Very drowsy, responds only to pain. GCS 10/15 (E3V3M4). Temp 39.6°C. Pulse 138 bpm. BP 90/60. RR 38. SpO₂ 94%. Pallor ++. Icteric sclerae. Severe dehydration.', type:'exam', label:'General examination' },
      exam_neuro:      { text: "Neuro: GCS 10. Does not follow commands. Pupils equal and reactive (3mm). Neck: mild stiffness — equivocal. No clonus. Plantar: equivocal.", type:'exam', label:'Neurological examination' },
      exam_abdomen:    { text: "Abdomen: Soft. Liver palpable 4cm below costal margin — hepatomegaly. Spleen palpable 3cm — splenomegaly. No ascites.", type:'exam', label:'Abdominal examination' },
      exam_skin:       { text: "Skin: Pallor ++ (conjunctivae very pale). Mild jaundice. No petechiae or rash. Poor skin turgor (dehydration).", type:'exam', label:'Skin examination' },
      ix_rdt:          { text: 'Malaria RDT:\n• P. falciparum antigen: POSITIVE\n• Non-falciparum species: Negative\n→ Confirms falciparum malaria.', type:'investigation', label:'Malaria RDT' },
      ix_thickfilm:    { text: 'Blood Film (thick & thin):\n• P. falciparum trophozoites and gametocytes identified\n• Parasitaemia: 4.8% (hyperparasitaemia — severe malaria threshold is >2%)\n→ Severe falciparum malaria confirmed.', type:'investigation', label:'Blood film' },
      ix_fbc:          { text: 'FBC:\n• Hb: 5.8 g/dL ↓↓ (severe anaemia)\n• WBC: 14.2 × 10⁹/L ↑ (reactive)\n• Platelets: 48 × 10⁹/L ↓ (thrombocytopaenia — typical in malaria)', type:'investigation', label:'FBC' },
      ix_lft:          { text: 'Renal/Metabolic:\n• Blood glucose: 2.1 mmol/L ↓↓ (HYPOGLYCAEMIA — requires urgent dextrose)\n• Creatinine: 94 μmol/L (normal)\n• Bilirubin: 68 μmol/L ↑ (haemolysis)\n• Na: 130 mmol/L ↓', type:'investigation', label:'Metabolic panel' },
    },
    scoringMap: { mustAsk: ['sr_fever','sr_consciousness','shx_travel','ix_rdt'], shouldAsk: ['sr_seizures','sr_jaundice','ix_thickfilm','ix_fbc','exam_neuro'], pointsBase: 5, pointsMust: 15 },
  },
  {
    caseId: 'case_peds_asthma_001',
    discipline: 'peds', difficulty: 'beginner', timeLimit: 480,
    hospital: 'LUTH Lagos',
    patient: { name: 'Adaeze Obi', age: 8, sex: 'Female', occupation: 'Primary school', avatar: '👧' },
    presentingComplaint: 'Wheezing and difficulty breathing for 4 hours',
    diagnosis: { primary: 'Acute Asthma Exacerbation', keywords: ['asthma','acute asthma','asthma attack','bronchial asthma','asthma exacerbation'] },
    differentials: [
      { name: 'Acute Asthma Exacerbation', color: '#1A7A6E', initial: 50 },
      { name: 'Bronchiolitis',             color: '#5B3F8A', initial: 15 },
      { name: 'Pneumonia',                 color: '#9B3535', initial: 20 },
      { name: 'Foreign Body Aspiration',   color: '#B86A10', initial: 15 },
    ],
    trapActions: [
      { pattern: /beta.?blocker|propranolol|atenolol/i, penalty: 20, explanation: '⛔ Beta-blockers are absolutely contraindicated in asthma — they cause fatal bronchospasm. Deducted −20 pts.' },
      { pattern: /sedative|sedation|diazepam|lorazepam.*asthma/i, penalty: 15, explanation: '⛔ Sedation in a patient with acute respiratory distress can cause respiratory arrest. Deducted −15 pts.' },
    ],
    intentMap: {
      hpc_onset:    { text: "She started wheezing about 4 hours ago after playing football at school. The breathing has been getting worse since then.", type:'history', label:'Onset & trigger' },
      hpc_triggers: { text: "Exercise seems to trigger it. She also gets worse when she's around dust or her uncle's cat. Cold air makes it worse too.", type:'history', label:'Triggers' },
      pmh_general:  { text: "She has had asthma since age 4. She's been admitted twice before — once needed nebulisers in A&E. She also has eczema.", type:'history', label:'Past medical history' },
      meds_general: { text: "She uses a blue inhaler (Salbutamol) when needed. She has a brown inhaler (Beclomethasone) but forgets to use it most days. She's already used her blue inhaler 6 times today with only partial relief.", type:'history', label:'Medications' },
      fhx_general:  { text: "Her father has asthma and her older brother has hay fever. Atopy runs in the family.", type:'history', label:'Family history' },
      shx_general:  { text: "She lives in a flat. We have carpets and a cat at home. She's in primary school — doing well. No smoking in the house.", type:'history', label:'Social history' },
      sr_fever:     { text: "No fever. Temperature is normal — 37.1°C.", type:'history', label:'Fever' },
      hpc_character:{ text: "She's wheezing and can't complete sentences — she speaks in phrases. She says her chest feels \"tight like something is squeezing it.\"", type:'history', label:'Symptoms' },
      exam_general: { text: 'General: Alert but distressed. Speaking in short phrases. Using accessory muscles — intercostal and subcostal recession. RR 36/min. Pulse 128 bpm. Temp 37.1°C. SpO₂ 91% on air.', type:'exam', label:'General examination' },
      exam_chest:   { text: 'Chest: Hyperinflated. Bilateral expiratory wheeze throughout — polyphonic. Reduced air entry at both bases. No crackles. Percussion: resonant bilaterally.', type:'exam', label:'Chest examination' },
      ix_pefr:      { text: 'PEFR: 45% predicted for height/age.\n→ <50% predicted = Severe asthma attack (BTS criteria).\n(Predicted PEFR for 8-year-old female, 125cm: ~200 L/min. Measured: ~90 L/min)', type:'investigation', label:'PEFR' },
      ix_abg:       { text: 'ABG (on air):\n• pH: 7.33 (mild acidosis)\n• PaO₂: 7.8 kPa ↓ (hypoxia)\n• PaCO₂: 5.2 kPa (NORMAL in severe asthma = PRE-ARREST sign)\n→ Life-threatening — a normal or rising CO₂ in acute asthma is an emergency.', type:'investigation', label:'ABG' },
      ix_cxr:       { text: 'CXR:\n• Hyperinflation — 9 posterior ribs visible\n• Flattened diaphragm\n• No consolidation\n• No pneumothorax\n→ Consistent with severe asthma.', type:'investigation', label:'CXR' },
    },
    scoringMap: { mustAsk: ['hpc_triggers','pmh_general','meds_general','exam_chest'], shouldAsk: ['ix_pefr','ix_abg','fhx_general','exam_general'], pointsBase: 5, pointsMust: 15 },
  },
  {
    caseId: 'case_og_preeclampsia_001',
    discipline: 'og', difficulty: 'hard', timeLimit: 720,
    hospital: 'LASUTH Ikeja',
    patient: { name: 'Fatima Bello', age: 26, sex: 'Female', occupation: 'Trader', avatar: '🤰' },
    presentingComplaint: 'Headache and swollen legs at 34 weeks gestation',
    diagnosis: { primary: 'Severe Pre-eclampsia', keywords: ['preeclampsia','pre-eclampsia','severe pre-eclampsia','pregnancy induced hypertension','pih'] },
    differentials: [
      { name: 'Severe Pre-eclampsia',            color: '#8A3F6B', initial: 45 },
      { name: 'Gestational Hypertension',        color: '#5B3F8A', initial: 25 },
      { name: 'Chronic Hypertension in Pregnancy', color: '#2A5A8A', initial: 15 },
      { name: 'HELLP Syndrome',                  color: '#9B3535', initial: 15 },
    ],
    trapActions: [
      { pattern: /nsaid|ibuprofen|diclofenac/i,          penalty: 20, explanation: '⛔ NSAIDs are contraindicated after 30 weeks gestation — risk of premature closure of ductus arteriosus. Deducted −20 pts.' },
      { pattern: /ace.?inhibitor|lisinopril|enalapril|ramipril/i, penalty: 20, explanation: '⛔ ACE inhibitors are absolutely contraindicated in pregnancy — teratogenic in 2nd/3rd trimester. Deducted −20 pts.' },
      { pattern: /methyldopa.*avoid|no.*methyldopa/i,    penalty: 10, explanation: '⚠️ Methyldopa is actually a recommended antihypertensive in pregnancy. Deducted −10 pts.' },
    ],
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
      exam_neuro:      { text: "Neuro: GCS 15. Hyperreflexia +++ (bilateral). Clonus: 3 beats at right ankle. Fundoscopy: papilloedema present.\n→ CNS involvement — risk of eclamptic seizure imminent.", type:'exam', label:'Neurological examination' },
      ix_urinalysis:   { text: 'Urinalysis:\n• Protein: 3+ on dipstick (significant proteinuria)\n• Spot protein:creatinine ratio: 420 mg/mmol (>300 confirms significant proteinuria)', type:'investigation', label:'Urinalysis' },
      ix_fbc:          { text: 'FBC:\n• Hb: 10.8 g/dL\n• WBC: 11.2 × 10⁹/L\n• Platelets: 82 × 10⁹/L ↓↓ (thrombocytopaenia — possible HELLP)\n→ Platelet count <100 is a feature of HELLP syndrome.', type:'investigation', label:'FBC' },
      ix_lft:          { text: 'LFTs:\n• AST: 248 IU/L ↑↑\n• ALT: 196 IU/L ↑↑\n• LDH: 820 IU/L ↑↑ (haemolysis)\n→ HELLP Syndrome: Haemolysis + Elevated Liver enzymes + Low Platelets.', type:'investigation', label:'LFTs' },
      ix_ultrasound:   { text: 'Obstetric USS:\n• Single live fetus, cephalic\n• EFW: 1.7kg (IUGR)\n• AFI: 6cm (oligohydramnios)\n• Doppler: Absent end-diastolic flow in umbilical artery\n→ Fetal compromise. Delivery should be planned urgently.', type:'investigation', label:'Obstetric USS' },
    },
    scoringMap: { mustAsk: ['hpc_character','sr_oedema','antenatal','exam_neuro'], shouldAsk: ['ix_urinalysis','ix_fbc','ix_lft','sr_fetal_movement','parity'], pointsBase: 5, pointsMust: 15 },
  },
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
      { pattern: /nsaid|ibuprofen|diclofenac/i, penalty: 20, explanation: '⛔ NSAIDs cause fluid retention and worsen heart failure. They are contraindicated in cardiac failure. Deducted −20 pts.' },
      { pattern: /verapamil|diltiazem/i,         penalty: 15, explanation: '⚠️ Verapamil and diltiazem are negatively inotropic and contraindicated in systolic heart failure. Deducted −15 pts.' },
    ],
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
      ix_ecg:            { text: 'ECG:\nSinus rhythm. Rate 96. Left bundle branch block (LBBB). LVH pattern. No acute ST changes.', type:'investigation', label:'ECG' },
      ix_cxr:            { text: "CXR:\nCardiomegaly (CTR >0.5). Upper lobe diversion. Bilateral Kerley B lines. Right pleural effusion. Perihilar haze — 'bat-wing' pattern.", type:'investigation', label:'CXR' },
      ix_fbc:            { text: 'FBC:\n• Hb: 10.2 g/dL (normocytic anaemia)\n• WBC: 9.8 × 10⁹/L (normal)\n• Platelets: 220 × 10⁹/L (normal)', type:'investigation', label:'FBC' },
      ix_lft:            { text: 'Renal profile + BNP:\n• Creatinine: 168 μmol/L ↑ (AKI on CKD)\n• eGFR: 36 mL/min\n• Na: 132 mmol/L ↓\n• K: 5.4 mmol/L ↑\n• BNP: 1840 pg/mL ↑↑ (strongly confirms cardiac failure)', type:'investigation', label:'Renal profile / BNP' },
    },
    scoringMap: { mustAsk: ['hpc_character','pmh_general','meds_general','exam_cardiovascular'], shouldAsk: ['sr_oedema','hpc_orthopnoea','ix_cxr','ix_lft'], pointsBase: 5, pointsMust: 15 },
  },
];
