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

  hpc_onset: {
    cooperative:             ["It started {onset}. {context}", "The {character} began {onset}. {context}", "About {onset} ago, doctor. {context}", "It has been going on for {onset} now. {context}", "It came on {onset}. {context}", "I first noticed it {onset}. {context}", "The problem started {onset} \u2014 gradually at first. {context}", "I would say it began around {onset}. {context}", "It has been {onset} since all this started. {context}", "The symptoms appeared {onset}. {context}"],
    anxious:                 ["It started {onset} and I have been worried ever since. {context}", "About {onset} ago, doctor \u2014 I should have come sooner. {context}", "It has been {onset} and keeps getting worse. {context}", "Please doctor, it started {onset}. {context}", "I noticed it {onset} and could not sleep thinking about it. {context}", "{onset} ago. I hoped it would pass. {context}", "I have been panicking since {onset}. {context}", "Started {onset} \u2014 my family said I should have come sooner. {context}", "Since {onset}, nothing has been the same. {context}", "Doctor, it has been {onset} and I am really scared. {context}"],
    stoic:                   ["{onset}. That is when it started.", "It came on {onset}. {context}", "About {onset} ago.", "Started {onset}.", "The onset was {onset}. {context}", "{onset}. I have been managing.", "It began {onset}. Nothing more.", "{onset} ago. I carried on.", "{onset}. I did not think it would last this long.", "{onset}. {context}"],
    reticent:                ["(pause) About {onset}, I suppose. {context}", "Started {onset}. That is all I can say.", "{onset} ago... I did not think it was serious at first. {context}", "(quietly) It began {onset}. {context}", "Hmm... {onset} I think. {context}", "(shrugs) Around {onset}.", "Not sure exactly... maybe {onset}. {context}", "(sighs) {onset}. I do not really want to talk about it.", "About {onset} I suppose. I did not want to bother anyone.", "(looks away) {onset} ago. {context}"],
    frightened_child_proxy:  ["It started {onset}, doctor. {context}", "About {onset} \u2014 we have been so worried. {context}", "It came on {onset}. Please help.", "The child was fine until {onset}. {context}", "{onset} is when we first noticed something was wrong. {context}", "It started {onset}. We prayed it would pass. {context}", "We brought the child immediately \u2014 it started {onset}. {context}", "{onset} ago, doctor. We did not sleep all night. {context}", "It began {onset}. We were frightened. {context}", "Doctor, it started {onset} and we ran here. {context}"],
  },
  hpc_character: {
    cooperative:             ["The {character}. {modifier}", "It is a {character} kind of pain \u2014 {modifier}", "I would describe it as {character}. {modifier}", "It feels {character} in my {location}. {modifier}", "Definitely {character}. {modifier}", "The best way to describe it is {character}. {modifier}", "It is {character} \u2014 just {character}. {modifier}", "I have {character} which is {severity}. {modifier}", "The quality is {character}. {modifier}", "{character} \u2014 that is the only way I can describe it. {modifier}"],
    anxious:                 ["It is a {character} \u2014 is that bad, doctor? {modifier}", "The {character} is very severe. {modifier}", "I have never felt {character} like this before. {modifier}", "It is {character} and I am really scared. {modifier}", "Doctor, the {character} is {severity} \u2014 I have never experienced anything like it. {modifier}", "It is a {character}. When it hit I thought something ruptured. {modifier}", "The {character} wakes me at night. {modifier}", "Every time it happens my heart races. {modifier}", "{character} \u2014 each episode I panic. {modifier}", "I have been Googling the {character} and frightening myself. {modifier}"],
    stoic:                   ["{character}. {modifier}", "The {character}. Not easy but I manage.", "{character} in the {location}. {modifier}", "{character}. I have known worse. {modifier}", "{character} \u2014 {severity}. I cope.", "Just {character}. {modifier}", "{character}. I ignore it and carry on.", "{character} \u2014 I do not dwell on it. {modifier}", "It is {character}. That is all.", "{character}. Working through it."],
    reticent:                ["(reluctantly) {character}, I suppose. {modifier}", "It is {character}... I do not know how else to describe it.", "(quietly) {character}. {modifier}", "{character}... it is hard to explain.", "I would say {character} but I am not sure. {modifier}", "(pause) Something like {character}. {modifier}", "{character}, I think. I do not like talking about pain.", "(looks down) It is {character}. {modifier}", "{character}... I did not want to say how bad it was.", "It feels {character}. That is all I know."],
    frightened_child_proxy:  ["The child keeps crying \u2014 we think it is {character}. {modifier}", "It looks like {character} pain. {modifier}", "A {character} pain \u2014 the child cannot keep still.", "The child screams when we touch the {location}.", "From the way the child holds the {location}, it must be {character}.", "{character} \u2014 the child is doubling over.", "We think it is {character} because the child keeps pressing the {location}.", "The child said it feels {character}. {modifier}", "{character} pain \u2014 the child has cried since {onset}.", "Doctor, it looks {character}. We have never seen the child like this."],
  },
  hpc_radiation: {
    cooperative:             ["It {radiation}.", "The pain {radiation}.", "Yes \u2014 it {radiation}.", "From the {location} it {radiation}.", "It starts in the {location} and {radiation}.", "Definitely \u2014 it {radiation}.", "The {character} {radiation}.", "Yes, it {radiation}. I have noticed that.", "The pain {radiation} \u2014 I feel it there too.", "It {radiation} \u2014 especially when it is worst."],
    anxious:                 ["It {radiation} \u2014 should I be worried?", "Yes and it {radiation}, which frightened me.", "Doctor, it {radiation}. Is that a bad sign?", "It {radiation} \u2014 I did not expect that. {severity}", "The {radiation} really worries me. What does it mean?", "It {radiation} \u2014 I keep thinking it might be my heart.", "It {radiation} \u2014 I told my husband and he insisted I come.", "Yes it {radiation}. I have been scared to say that.", "It {radiation} and sometimes worse than the main pain.", "Doctor, it {radiation} \u2014 that frightened me most."],
    stoic:                   ["{radiation}.", "Goes {radiation}. That is it.", "{radiation}. Not unusual.", "The pain {radiation}. Nothing more.", "{radiation}. I noted it.", "{radiation} \u2014 manageable.", "It {radiation}. I have learnt to live with it.", "It {radiation}. I did not think it mattered.", "{radiation}.", "{radiation}. I carry on."],
    reticent:                ["(thinking) It may {radiation}... I am not sure.", "{radiation}. I had not thought about it.", "(pause) Perhaps it {radiation}. Yes.", "(reluctantly) It {radiation} sometimes.", "I think it {radiation} \u2014 I am not certain.", "(quietly) {radiation}... maybe.", "{radiation} \u2014 I did not mention it as I was not sure.", "(shrugs) It {radiation} I think.", "It {radiation}. Sorry I did not say sooner.", "(hesitating) It {radiation}... yes, I suppose so."],
    frightened_child_proxy:  ["The child seems like the pain {radiation}.", "It looks like it {radiation}.", "The child holds both {location} and where it {radiation}.", "We noticed the child flinching where it {radiation}.", "{radiation} \u2014 the child told us.", "It seems to {radiation} because the child rubs that area too.", "Doctor, we think it {radiation}. The child pointed there.", "It {radiation} \u2014 the child cried when we pressed that spot.", "It {radiation}. We are not sure but that is what the child showed us.", "{radiation} \u2014 the child keeps pointing there."],
  },
  hpc_relieving: {
    cooperative:             ["{modifier}", "Honestly, not much helps. {modifier}", "{modifier} \u2014 that is the only thing that gives some relief.", "I have tried {modifier} but it does not last.", "{modifier} helps a bit. Not much else.", "When I {modifier} it eases off slightly.", "Lying on my side helps \u2014 and {modifier}.", "{modifier} gives 20 to 30 minutes of relief.", "The only thing I have found is {modifier}.", "{modifier} \u2014 but as soon as it wears off it returns."],
    anxious:                 ["Nothing really helps, doctor. {modifier} I am very uncomfortable.", "{modifier} \u2014 but it always comes back.", "I have tried everything \u2014 {modifier} \u2014 nothing works.", "{modifier} only helps a little. I am getting desperate.", "Doctor, {modifier} gives relief but then it comes back worse.", "I keep trying {modifier} but it does not take it away properly.", "Nothing takes it fully away. {modifier} \u2014 and even that barely works.", "I am scared to stop {modifier} because the pain comes straight back.", "{modifier} \u2014 I told my sister and she said I should come here.", "I have been doing {modifier} but it only lasts {duration}. I cannot go on."],
    stoic:                   ["{modifier}", "Not much. {modifier}", "{modifier} \u2014 I manage with that.", "I just keep moving. {modifier}", "{modifier}. I do not dwell on it.", "{modifier} is enough.", "Rest and {modifier}.", "Not much relieves it. {modifier}", "{modifier} \u2014 I have been coping.", "{modifier}. It helps some."],
    reticent:                ["{modifier} maybe.", "I do not know. {modifier}", "(pause) {modifier} \u2014 I think.", "{modifier}... not really sure if it helps.", "(quietly) {modifier}. I do not ask for much.", "{modifier} I suppose.", "I have not really looked for relief. {modifier}", "(reluctantly) {modifier} \u2014 my wife suggested it.", "{modifier}. I do not like tablets.", "{modifier}. I do not complain."],
    frightened_child_proxy:  ["When we hold the child it settles a little. {modifier}", "{modifier} \u2014 it is the only thing that seems to calm them.", "The child stops crying when we do {modifier}.", "{modifier} helps \u2014 but only for a moment.", "We have been rocking the child. {modifier}", "Nothing really helps. {modifier} We are desperate.", "{modifier} \u2014 when we try this the child relaxes slightly.", "We prayed and {modifier} \u2014 that seemed to give some comfort.", "{modifier} \u2014 but the child starts crying again after a short while.", "The child only settles when we {modifier}. Nothing else works."],
  },
  hpc_aggravating: {
    cooperative:             ["{modifier} makes it worse. {context}", "It gets worse with {modifier}. {context}", "Anything that involves {modifier} aggravates it. {context}", "The pain is worse after {modifier}. {context}", "When I do {modifier}, it becomes unbearable. {context}", "Movement \u2014 especially {modifier} \u2014 aggravates it. {context}", "Eating {modifier} triggers it. {context}", "{modifier} every time. {context}", "It flares up with {modifier}. {context}", "The worst thing is {modifier}. {context}"],
    anxious:                 ["{modifier} makes it so much worse \u2014 I am afraid now. {context}", "Even {modifier} sets it off. {context} I do not know what to do.", "I have stopped {modifier} completely because of the pain. Is that normal?", "Doctor, {modifier} makes it unbearable. {context} Please help.", "{modifier} \u2014 and even sitting still can be bad. {context}", "I am scared to eat because {modifier} always makes it worse. {context}", "{modifier} \u2014 I am frightened. {context}", "The pain is worst with {modifier}. {context} I cannot function.", "{modifier} triggers it badly. {context} My family is worried.", "Doctor, {modifier} is the worst trigger. {context} I have been avoiding it."],
    stoic:                   ["{modifier}. {context}", "It is worse with {modifier}. That is it.", "{modifier}. I noted it.", "I avoid {modifier}. {context}", "{modifier} aggravates it. Nothing I can do.", "{modifier}. I just carry on.", "{modifier}. {context} I manage.", "{modifier}. Simple.", "Worse with {modifier}. {context}", "{modifier}. Yes."],
    reticent:                ["(pause) {modifier} maybe. {context}", "{modifier}... I am not sure if that is related.", "(quietly) I think {modifier} makes it worse.", "{modifier} \u2014 I did not think it was worth mentioning.", "(reluctantly) {modifier}. Yes. {context}", "{modifier}... I noticed but did not want to say.", "(hesitating) I think it is worse after {modifier}. {context}", "(shrugs) {modifier} perhaps.", "{modifier}. (long pause) Yes.", "(quietly) {modifier}. That is it."],
    frightened_child_proxy:  ["The child cries more when {modifier}. {context}", "{modifier} \u2014 that is when the child screams loudest. {context}", "We noticed {modifier} makes it worse.", "When the child tries to {modifier}, the pain returns badly.", "{modifier} \u2014 the child refuses because of the pain.", "We discovered that {modifier} sets it off.", "Any time the child {modifier}, it gets worse.", "Touching the {location} \u2014 even lightly \u2014 makes the child scream.", "{modifier} \u2014 and lying flat. {context} Those are the worst.", "{modifier} seems to trigger the episodes. {context}"],
  },
  hpc_severity: {
    cooperative:             ["I would say {severity}.", "On a scale of one to ten \u2014 {severity}.", "{severity}. It interferes with my daily activities.", "The severity is {severity}. {context}", "{severity} \u2014 bad enough to bring me here.", "I would put it at {severity}. {context}", "{severity}. Sometimes a bit less.", "It is {severity} most of the time. {context}", "{severity} \u2014 worse in the {context}.", "At its peak it is {severity}. {context}"],
    anxious:                 ["Doctor, it is {severity} \u2014 I have never had pain this bad.", "{severity}. I cannot function. Please help.", "It is {severity} and it keeps getting worse.", "Doctor, {severity} \u2014 I was crying all night.", "{severity} \u2014 the worst pain of my life. {context}", "At least {severity} if not more. I am in agony.", "{severity} \u2014 I could not eat, could not sleep.", "It is {severity}. My hands are shaking just telling you.", "{severity} doctor. I thought I was going to die.", "Honestly, {severity}. Please something is wrong."],
    stoic:                   ["{severity}.", "{severity}. I manage.", "{severity} \u2014 not unbearable.", "{severity}. I keep going.", "About {severity}. I have had worse.", "{severity}. It is what it is.", "{severity} \u2014 I still went to work.", "{severity}. Not the end of the world.", "{severity}. I do not complain.", "{severity}. Moderate."],
    reticent:                ["(pause) {severity}, I suppose.", "{severity}... I do not really like to say.", "(reluctantly) {severity}. Yes.", "{severity}. I did not want to exaggerate.", "(quietly) {severity}.", "{severity}. I kept it to myself.", "(shrugs) {severity} maybe.", "(sighs) {severity}. I did not want to bother anyone.", "{severity} \u2014 I am not good at describing pain.", "(looks down) {severity}. That is the honest answer."],
    frightened_child_proxy:  ["The child is in severe pain \u2014 {severity}.", "We could tell it was {severity} from the crying.", "{severity} \u2014 the child has not stopped crying.", "Doctor, it must be {severity} because the child will not let us touch it.", "{severity}. The child was screaming.", "It is bad \u2014 {severity}. {context}", "{severity} \u2014 we have never seen the child like this.", "We think {severity}. The child could not tell us exactly.", "{severity}. We brought the child immediately.", "It is {severity} \u2014 God, please help this child."],
  },
  hpc_progression: {
    cooperative:             ["{context}", "It has been gradually getting worse \u2014 {context}.", "The symptoms have {context} over time.", "Since it started \u2014 {context}.", "It progressed from {context}.", "Started mild but now {context}.", "Over {onset} the problem has {context}.", "The trend \u2014 {context}.", "It has been {context}. Worse than before.", "The progression \u2014 {context}."],
    anxious:                 ["{context} \u2014 and it keeps getting worse. I am scared.", "Doctor, {context}. It has not settled.", "It has been getting worse since {onset}. {context} I am very worried.", "{context} \u2014 I thought it would improve. It has not.", "Doctor, {context}. What does that mean?", "{context}. I can see it progressing and it frightens me.", "It was manageable at first but {context}. Please help.", "Doctor, {context} \u2014 it has been a downward trend.", "{context}. I have been tracking it and I am scared.", "It just keeps getting worse. {context} I am desperate."],
    stoic:                   ["{context}.", "Getting worse. {context}", "{context}. Gradual.", "Slow progression. {context}", "{context}. I note it.", "Worse than before. {context}", "{context}. I carry on.", "Progressing \u2014 {context}.", "{context}. Yes.", "It is {context}."],
    reticent:                ["(pause) It is {context}.", "(reluctantly) Getting worse I suppose. {context}", "(quietly) {context}.", "(hesitating) {context}. Yes.", "{context}. I did not want to say.", "(sighs) {context}.", "(looks away) {context}.", "(reluctantly) Worse. {context}", "(quietly) {context}. Gradually.", "{context}. (long pause)"],
    frightened_child_proxy:  ["The child is getting worse. {context}", "Doctor, {context}. It is not settling.", "{context} \u2014 the child is deteriorating.", "Since yesterday \u2014 {context}.", "Doctor, {context}. We are very scared.", "It was bad and now {context}.", "{context}. We need help urgently.", "The child \u2014 {context}. Worse each hour.", "Doctor, {context}. Why is it not getting better?", "{context}. We prayed but it is worse."],
  },
  hpc_timing: {
    cooperative:             ["It is {context}.", "The pain is {context}.", "It is {context} \u2014 comes and goes.", "The timing \u2014 {context}.", "It lasts {duration}. {context}", "{context} in nature. {duration}", "Intermittent \u2014 {context}. {duration}", "It comes on {context}. {duration}", "{context}. {duration} each time.", "The episodes last {duration}. {context}"],
    anxious:                 ["{context} \u2014 and it is becoming more frequent. I am worried.", "It is {context}. {duration} each time. It is not settling.", "Doctor, {context}. The episodes are getting longer.", "{context} \u2014 I track every episode. {duration}", "Each episode lasts {duration}. {context} It is exhausting.", "It is {context} and I do not know when the next one will come.", "Doctor, {context}. {duration} Is that normal?", "{context}. {duration} I am scared of the next episode.", "The pattern \u2014 {context}. {duration} Something is wrong.", "It has been {context} since {onset}. {duration} Please help."],
    stoic:                   ["{context}. {duration}", "Intermittent \u2014 {context}.", "{context}. Lasts {duration}.", "{duration} each time. {context}", "{context}. I manage.", "{context}. {duration}. Yes.", "Comes and goes. {context}", "{context}. Brief.", "Timing \u2014 {context}. {duration}", "{context}. Not constant."],
    reticent:                ["(pause) {context}. {duration}", "{context}... I am not sure.", "(quietly) {context}.", "(reluctantly) {context}. {duration}", "(hesitating) {context} I think.", "{context}. I do not track it.", "(sighs) {context}.", "(looks away) {context}. {duration}", "(quietly) {context}. Not sure of the duration.", "{context}. (pause)"],
    frightened_child_proxy:  ["It comes on {context}. {duration}", "The episodes last {duration}. {context}", "Doctor, {context}. The episodes keep returning.", "{context}. {duration} We time them now.", "Each episode is {duration}. {context}", "It is {context}. We do not know when the next will come.", "Doctor, {context}. {duration} It is frightening.", "{context} \u2014 the episodes are {duration} long.", "{context}. We have been counting.", "{context}. {duration}. It keeps coming back."],
  },
  hpc_orthopnoea: {
    cooperative:             ["{context} {severity}", "I cannot lie flat \u2014 {context}. {severity}", "Orthopnoea \u2014 {context}. {severity}", "Lying flat makes it worse. {context} {severity}", "I sleep with {severity} pillows. {context}", "Breathlessness on lying flat \u2014 {context}. {severity}", "I cannot lie down comfortably. {context} {severity}", "I prop myself up \u2014 {severity} pillows now. {context}", "Worse lying flat. {context} {severity}", "I have to sit upright to breathe. {context} {severity}"],
    anxious:                 ["{context} \u2014 I am scared to sleep. {severity}", "I cannot lie flat, doctor. {context} {severity}", "Doctor, {context}. {severity} I have been sleeping in a chair.", "{context}. {severity} I wake up gasping.", "Orthopnoea \u2014 {context}. {severity} I am terrified to sleep.", "Doctor, {context}. {severity} My wife is very worried.", "{context}. {severity} I dread going to bed.", "Lying flat \u2014 {context}. {severity} I thought I would die.", "Doctor, {context}. {severity} I can only sleep sitting up.", "{context}. {severity} The nights are terrible."],
    stoic:                   ["{context} {severity}", "Cannot lie flat. {severity}", "{context}. I use pillows.", "Worse flat. {context}", "{context}. I manage.", "{severity} pillows. {context}", "Cannot lie down. {context}", "{context}. Yes.", "Orthopnoea. {severity}", "I prop up. {context}"],
    reticent:                ["(quietly) {context}.", "(reluctantly) Cannot lie flat. {severity}", "(pause) {context}. {severity}", "(hesitating) Orthopnoea \u2014 {context}.", "(sighs) {context}. Yes.", "(looks away) {context}. {severity}", "(quietly) I sleep sitting up. {context}", "{context}. I did not say before.", "(reluctantly) {context}. {severity}", "(quietly) Orthopnoea \u2014 {context}."],
    frightened_child_proxy:  ["The child cannot lie flat. {context} {severity}", "The child sleeps propped up. {context}", "Doctor, the child will not lie flat. {context}", "Propped up at {severity} pillows. {context}", "The child struggles lying flat. {context} {severity}", "Doctor, {context}. The child cannot lie down.", "The child \u2014 cannot lie flat. {context} {severity}", "Orthopnoea \u2014 {context}.", "{context}. The child sleeps sitting.", "Doctor, {context}. {severity} The child is breathless lying down."],
  },
  // ── SYSTEMS REVIEW: FEVER ───────────────────────────────
  sr_fever: {
    cooperative:             ["Yes \u2014 fever. {context} {severity}", "{context}. {onset}", "I have had fever. {context} {onset}", "Yes, fever since {onset}. {severity}", "fever for {onset}. {context}", "I noticed fever. {context} {severity}", "{context}. {severity}", "fever \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, fever \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, fever \u2014 {context}. {onset} I am scared.", "fever since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "fever \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "fever \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "fever \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "fever \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["fever. {onset}", "{context}. fever.", "{onset}. fever.", "{context}. {severity}", "fever \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "fever \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) fever. {onset}", "(reluctantly) Yes \u2014 fever. {context}", "(pause) fever \u2014 {context}.", "(hesitating) {context}. fever.", "(sighs) {context}. {onset}", "(looks away) fever \u2014 {context}.", "(quietly) Yes, fever. {context}", "(reluctantly) {context}. fever.", "(pause) fever \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has fever. {onset}", "Doctor, fever \u2014 {onset}. {severity}", "We noticed fever. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "fever \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 fever. {context} {onset} {severity}", "{context}. {severity}", "Doctor, fever \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: NAUSEA/VOMITING ─────────────────────────────────
  sr_nausea: {
    cooperative:             ["Yes \u2014 nausea/vomiting. {context} {severity}", "{context}. {onset}", "I have had nausea/vomiting. {context} {onset}", "Yes, nausea/vomiting since {onset}. {severity}", "nausea/vomiting for {onset}. {context}", "I noticed nausea/vomiting. {context} {severity}", "{context}. {severity}", "nausea/vomiting \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, nausea/vomiting \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, nausea/vomiting \u2014 {context}. {onset} I am scared.", "nausea/vomiting since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "nausea/vomiting \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "nausea/vomiting \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "nausea/vomiting \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "nausea/vomiting \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["nausea/vomiting. {onset}", "{context}. nausea/vomiting.", "{onset}. nausea/vomiting.", "{context}. {severity}", "nausea/vomiting \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "nausea/vomiting \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) nausea/vomiting. {onset}", "(reluctantly) Yes \u2014 nausea/vomiting. {context}", "(pause) nausea/vomiting \u2014 {context}.", "(hesitating) {context}. nausea/vomiting.", "(sighs) {context}. {onset}", "(looks away) nausea/vomiting \u2014 {context}.", "(quietly) Yes, nausea/vomiting. {context}", "(reluctantly) {context}. nausea/vomiting.", "(pause) nausea/vomiting \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has nausea/vomiting. {onset}", "Doctor, nausea/vomiting \u2014 {onset}. {severity}", "We noticed nausea/vomiting. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "nausea/vomiting \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 nausea/vomiting. {context} {onset} {severity}", "{context}. {severity}", "Doctor, nausea/vomiting \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: VOMITING CHARACTER ──────────────────────────────
  sr_vomiting: {
    cooperative:             ["Yes \u2014 vomiting character. {context} {severity}", "{context}. {onset}", "I have had vomiting character. {context} {onset}", "Yes, vomiting character since {onset}. {severity}", "vomiting character for {onset}. {context}", "I noticed vomiting character. {context} {severity}", "{context}. {severity}", "vomiting character \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, vomiting character \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, vomiting character \u2014 {context}. {onset} I am scared.", "vomiting character since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "vomiting character \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "vomiting character \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "vomiting character \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "vomiting character \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["vomiting character. {onset}", "{context}. vomiting character.", "{onset}. vomiting character.", "{context}. {severity}", "vomiting character \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "vomiting character \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) vomiting character. {onset}", "(reluctantly) Yes \u2014 vomiting character. {context}", "(pause) vomiting character \u2014 {context}.", "(hesitating) {context}. vomiting character.", "(sighs) {context}. {onset}", "(looks away) vomiting character \u2014 {context}.", "(quietly) Yes, vomiting character. {context}", "(reluctantly) {context}. vomiting character.", "(pause) vomiting character \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has vomiting character. {onset}", "Doctor, vomiting character \u2014 {onset}. {severity}", "We noticed vomiting character. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "vomiting character \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 vomiting character. {context} {onset} {severity}", "{context}. {severity}", "Doctor, vomiting character \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: BOWELS ──────────────────────────────────────────
  sr_bowels: {
    cooperative:             ["Yes \u2014 bowel changes. {context} {severity}", "{context}. {onset}", "I have had bowel changes. {context} {onset}", "Yes, bowel changes since {onset}. {severity}", "bowel changes for {onset}. {context}", "I noticed bowel changes. {context} {severity}", "{context}. {severity}", "bowel changes \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, bowel changes \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, bowel changes \u2014 {context}. {onset} I am scared.", "bowel changes since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "bowel changes \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "bowel changes \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "bowel changes \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "bowel changes \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["bowel changes. {onset}", "{context}. bowel changes.", "{onset}. bowel changes.", "{context}. {severity}", "bowel changes \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "bowel changes \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) bowel changes. {onset}", "(reluctantly) Yes \u2014 bowel changes. {context}", "(pause) bowel changes \u2014 {context}.", "(hesitating) {context}. bowel changes.", "(sighs) {context}. {onset}", "(looks away) bowel changes \u2014 {context}.", "(quietly) Yes, bowel changes. {context}", "(reluctantly) {context}. bowel changes.", "(pause) bowel changes \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has bowel changes. {onset}", "Doctor, bowel changes \u2014 {onset}. {severity}", "We noticed bowel changes. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "bowel changes \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 bowel changes. {context} {onset} {severity}", "{context}. {severity}", "Doctor, bowel changes \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: URINARY ─────────────────────────────────────────
  sr_urinary: {
    cooperative:             ["Yes \u2014 urinary symptoms. {context} {severity}", "{context}. {onset}", "I have had urinary symptoms. {context} {onset}", "Yes, urinary symptoms since {onset}. {severity}", "urinary symptoms for {onset}. {context}", "I noticed urinary symptoms. {context} {severity}", "{context}. {severity}", "urinary symptoms \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, urinary symptoms \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, urinary symptoms \u2014 {context}. {onset} I am scared.", "urinary symptoms since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "urinary symptoms \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "urinary symptoms \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "urinary symptoms \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "urinary symptoms \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["urinary symptoms. {onset}", "{context}. urinary symptoms.", "{onset}. urinary symptoms.", "{context}. {severity}", "urinary symptoms \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "urinary symptoms \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) urinary symptoms. {onset}", "(reluctantly) Yes \u2014 urinary symptoms. {context}", "(pause) urinary symptoms \u2014 {context}.", "(hesitating) {context}. urinary symptoms.", "(sighs) {context}. {onset}", "(looks away) urinary symptoms \u2014 {context}.", "(quietly) Yes, urinary symptoms. {context}", "(reluctantly) {context}. urinary symptoms.", "(pause) urinary symptoms \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has urinary symptoms. {onset}", "Doctor, urinary symptoms \u2014 {onset}. {severity}", "We noticed urinary symptoms. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "urinary symptoms \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 urinary symptoms. {context} {onset} {severity}", "{context}. {severity}", "Doctor, urinary symptoms \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: CHEST PAIN ──────────────────────────────────────
  sr_chest_pain: {
    cooperative:             ["Yes \u2014 chest pain. {context} {severity}", "{context}. {onset}", "I have had chest pain. {context} {onset}", "Yes, chest pain since {onset}. {severity}", "chest pain for {onset}. {context}", "I noticed chest pain. {context} {severity}", "{context}. {severity}", "chest pain \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, chest pain \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, chest pain \u2014 {context}. {onset} I am scared.", "chest pain since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "chest pain \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "chest pain \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "chest pain \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "chest pain \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["chest pain. {onset}", "{context}. chest pain.", "{onset}. chest pain.", "{context}. {severity}", "chest pain \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "chest pain \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) chest pain. {onset}", "(reluctantly) Yes \u2014 chest pain. {context}", "(pause) chest pain \u2014 {context}.", "(hesitating) {context}. chest pain.", "(sighs) {context}. {onset}", "(looks away) chest pain \u2014 {context}.", "(quietly) Yes, chest pain. {context}", "(reluctantly) {context}. chest pain.", "(pause) chest pain \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has chest pain. {onset}", "Doctor, chest pain \u2014 {onset}. {severity}", "We noticed chest pain. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "chest pain \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 chest pain. {context} {onset} {severity}", "{context}. {severity}", "Doctor, chest pain \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: PALPITATIONS ────────────────────────────────────
  sr_palpitations: {
    cooperative:             ["Yes \u2014 palpitations. {context} {severity}", "{context}. {onset}", "I have had palpitations. {context} {onset}", "Yes, palpitations since {onset}. {severity}", "palpitations for {onset}. {context}", "I noticed palpitations. {context} {severity}", "{context}. {severity}", "palpitations \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, palpitations \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, palpitations \u2014 {context}. {onset} I am scared.", "palpitations since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "palpitations \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "palpitations \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "palpitations \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "palpitations \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["palpitations. {onset}", "{context}. palpitations.", "{onset}. palpitations.", "{context}. {severity}", "palpitations \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "palpitations \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) palpitations. {onset}", "(reluctantly) Yes \u2014 palpitations. {context}", "(pause) palpitations \u2014 {context}.", "(hesitating) {context}. palpitations.", "(sighs) {context}. {onset}", "(looks away) palpitations \u2014 {context}.", "(quietly) Yes, palpitations. {context}", "(reluctantly) {context}. palpitations.", "(pause) palpitations \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has palpitations. {onset}", "Doctor, palpitations \u2014 {onset}. {severity}", "We noticed palpitations. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "palpitations \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 palpitations. {context} {onset} {severity}", "{context}. {severity}", "Doctor, palpitations \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: OEDEMA ──────────────────────────────────────────
  sr_oedema: {
    cooperative:             ["Yes \u2014 oedema/swelling. {context} {severity}", "{context}. {onset}", "I have had oedema/swelling. {context} {onset}", "Yes, oedema/swelling since {onset}. {severity}", "oedema/swelling for {onset}. {context}", "I noticed oedema/swelling. {context} {severity}", "{context}. {severity}", "oedema/swelling \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, oedema/swelling \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, oedema/swelling \u2014 {context}. {onset} I am scared.", "oedema/swelling since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "oedema/swelling \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "oedema/swelling \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "oedema/swelling \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "oedema/swelling \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["oedema/swelling. {onset}", "{context}. oedema/swelling.", "{onset}. oedema/swelling.", "{context}. {severity}", "oedema/swelling \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "oedema/swelling \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) oedema/swelling. {onset}", "(reluctantly) Yes \u2014 oedema/swelling. {context}", "(pause) oedema/swelling \u2014 {context}.", "(hesitating) {context}. oedema/swelling.", "(sighs) {context}. {onset}", "(looks away) oedema/swelling \u2014 {context}.", "(quietly) Yes, oedema/swelling. {context}", "(reluctantly) {context}. oedema/swelling.", "(pause) oedema/swelling \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has oedema/swelling. {onset}", "Doctor, oedema/swelling \u2014 {onset}. {severity}", "We noticed oedema/swelling. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "oedema/swelling \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 oedema/swelling. {context} {onset} {severity}", "{context}. {severity}", "Doctor, oedema/swelling \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: SEIZURES ────────────────────────────────────────
  sr_seizures: {
    cooperative:             ["Yes \u2014 fits/seizures. {context} {severity}", "{context}. {onset}", "I have had fits/seizures. {context} {onset}", "Yes, fits/seizures since {onset}. {severity}", "fits/seizures for {onset}. {context}", "I noticed fits/seizures. {context} {severity}", "{context}. {severity}", "fits/seizures \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, fits/seizures \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, fits/seizures \u2014 {context}. {onset} I am scared.", "fits/seizures since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "fits/seizures \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "fits/seizures \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "fits/seizures \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "fits/seizures \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["fits/seizures. {onset}", "{context}. fits/seizures.", "{onset}. fits/seizures.", "{context}. {severity}", "fits/seizures \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "fits/seizures \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) fits/seizures. {onset}", "(reluctantly) Yes \u2014 fits/seizures. {context}", "(pause) fits/seizures \u2014 {context}.", "(hesitating) {context}. fits/seizures.", "(sighs) {context}. {onset}", "(looks away) fits/seizures \u2014 {context}.", "(quietly) Yes, fits/seizures. {context}", "(reluctantly) {context}. fits/seizures.", "(pause) fits/seizures \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has fits/seizures. {onset}", "Doctor, fits/seizures \u2014 {onset}. {severity}", "We noticed fits/seizures. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "fits/seizures \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 fits/seizures. {context} {onset} {severity}", "{context}. {severity}", "Doctor, fits/seizures \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: CONSCIOUSNESS ───────────────────────────────────
  sr_consciousness: {
    cooperative:             ["Yes \u2014 altered consciousness. {context} {severity}", "{context}. {onset}", "I have had altered consciousness. {context} {onset}", "Yes, altered consciousness since {onset}. {severity}", "altered consciousness for {onset}. {context}", "I noticed altered consciousness. {context} {severity}", "{context}. {severity}", "altered consciousness \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, altered consciousness \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, altered consciousness \u2014 {context}. {onset} I am scared.", "altered consciousness since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "altered consciousness \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "altered consciousness \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "altered consciousness \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "altered consciousness \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["altered consciousness. {onset}", "{context}. altered consciousness.", "{onset}. altered consciousness.", "{context}. {severity}", "altered consciousness \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "altered consciousness \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) altered consciousness. {onset}", "(reluctantly) Yes \u2014 altered consciousness. {context}", "(pause) altered consciousness \u2014 {context}.", "(hesitating) {context}. altered consciousness.", "(sighs) {context}. {onset}", "(looks away) altered consciousness \u2014 {context}.", "(quietly) Yes, altered consciousness. {context}", "(reluctantly) {context}. altered consciousness.", "(pause) altered consciousness \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has altered consciousness. {onset}", "Doctor, altered consciousness \u2014 {onset}. {severity}", "We noticed altered consciousness. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "altered consciousness \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 altered consciousness. {context} {onset} {severity}", "{context}. {severity}", "Doctor, altered consciousness \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: JAUNDICE ────────────────────────────────────────
  sr_jaundice: {
    cooperative:             ["Yes \u2014 jaundice. {context} {severity}", "{context}. {onset}", "I have had jaundice. {context} {onset}", "Yes, jaundice since {onset}. {severity}", "jaundice for {onset}. {context}", "I noticed jaundice. {context} {severity}", "{context}. {severity}", "jaundice \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, jaundice \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, jaundice \u2014 {context}. {onset} I am scared.", "jaundice since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "jaundice \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "jaundice \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "jaundice \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "jaundice \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["jaundice. {onset}", "{context}. jaundice.", "{onset}. jaundice.", "{context}. {severity}", "jaundice \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "jaundice \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) jaundice. {onset}", "(reluctantly) Yes \u2014 jaundice. {context}", "(pause) jaundice \u2014 {context}.", "(hesitating) {context}. jaundice.", "(sighs) {context}. {onset}", "(looks away) jaundice \u2014 {context}.", "(quietly) Yes, jaundice. {context}", "(reluctantly) {context}. jaundice.", "(pause) jaundice \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has jaundice. {onset}", "Doctor, jaundice \u2014 {onset}. {severity}", "We noticed jaundice. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "jaundice \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 jaundice. {context} {onset} {severity}", "{context}. {severity}", "Doctor, jaundice \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: ABDOMINAL PAIN ──────────────────────────────────
  sr_abdominal: {
    cooperative:             ["Yes \u2014 abdominal pain. {context} {severity}", "{context}. {onset}", "I have had abdominal pain. {context} {onset}", "Yes, abdominal pain since {onset}. {severity}", "abdominal pain for {onset}. {context}", "I noticed abdominal pain. {context} {severity}", "{context}. {severity}", "abdominal pain \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, abdominal pain \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, abdominal pain \u2014 {context}. {onset} I am scared.", "abdominal pain since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "abdominal pain \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "abdominal pain \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "abdominal pain \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "abdominal pain \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["abdominal pain. {onset}", "{context}. abdominal pain.", "{onset}. abdominal pain.", "{context}. {severity}", "abdominal pain \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "abdominal pain \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) abdominal pain. {onset}", "(reluctantly) Yes \u2014 abdominal pain. {context}", "(pause) abdominal pain \u2014 {context}.", "(hesitating) {context}. abdominal pain.", "(sighs) {context}. {onset}", "(looks away) abdominal pain \u2014 {context}.", "(quietly) Yes, abdominal pain. {context}", "(reluctantly) {context}. abdominal pain.", "(pause) abdominal pain \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has abdominal pain. {onset}", "Doctor, abdominal pain \u2014 {onset}. {severity}", "We noticed abdominal pain. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "abdominal pain \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 abdominal pain. {context} {onset} {severity}", "{context}. {severity}", "Doctor, abdominal pain \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: FETAL MOVEMENT ──────────────────────────────────
  sr_fetal_movement: {
    cooperative:             ["Yes \u2014 fetal movement changes. {context} {severity}", "{context}. {onset}", "I have had fetal movement changes. {context} {onset}", "Yes, fetal movement changes since {onset}. {severity}", "fetal movement changes for {onset}. {context}", "I noticed fetal movement changes. {context} {severity}", "{context}. {severity}", "fetal movement changes \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, fetal movement changes \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, fetal movement changes \u2014 {context}. {onset} I am scared.", "fetal movement changes since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "fetal movement changes \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "fetal movement changes \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "fetal movement changes \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "fetal movement changes \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["fetal movement changes. {onset}", "{context}. fetal movement changes.", "{onset}. fetal movement changes.", "{context}. {severity}", "fetal movement changes \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "fetal movement changes \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) fetal movement changes. {onset}", "(reluctantly) Yes \u2014 fetal movement changes. {context}", "(pause) fetal movement changes \u2014 {context}.", "(hesitating) {context}. fetal movement changes.", "(sighs) {context}. {onset}", "(looks away) fetal movement changes \u2014 {context}.", "(quietly) Yes, fetal movement changes. {context}", "(reluctantly) {context}. fetal movement changes.", "(pause) fetal movement changes \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has fetal movement changes. {onset}", "Doctor, fetal movement changes \u2014 {onset}. {severity}", "We noticed fetal movement changes. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "fetal movement changes \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 fetal movement changes. {context} {onset} {severity}", "{context}. {severity}", "Doctor, fetal movement changes \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: APPETITE ────────────────────────────────────────
  sr_appetite: {
    cooperative:             ["Yes \u2014 reduced appetite. {context} {severity}", "{context}. {onset}", "I have had reduced appetite. {context} {onset}", "Yes, reduced appetite since {onset}. {severity}", "reduced appetite for {onset}. {context}", "I noticed reduced appetite. {context} {severity}", "{context}. {severity}", "reduced appetite \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, reduced appetite \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, reduced appetite \u2014 {context}. {onset} I am scared.", "reduced appetite since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "reduced appetite \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "reduced appetite \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "reduced appetite \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "reduced appetite \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["reduced appetite. {onset}", "{context}. reduced appetite.", "{onset}. reduced appetite.", "{context}. {severity}", "reduced appetite \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "reduced appetite \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) reduced appetite. {onset}", "(reluctantly) Yes \u2014 reduced appetite. {context}", "(pause) reduced appetite \u2014 {context}.", "(hesitating) {context}. reduced appetite.", "(sighs) {context}. {onset}", "(looks away) reduced appetite \u2014 {context}.", "(quietly) Yes, reduced appetite. {context}", "(reluctantly) {context}. reduced appetite.", "(pause) reduced appetite \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has reduced appetite. {onset}", "Doctor, reduced appetite \u2014 {onset}. {severity}", "We noticed reduced appetite. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "reduced appetite \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 reduced appetite. {context} {onset} {severity}", "{context}. {severity}", "Doctor, reduced appetite \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: WEIGHT LOSS ─────────────────────────────────────
  sr_weight_loss: {
    cooperative:             ["Yes \u2014 weight loss. {context} {severity}", "{context}. {onset}", "I have had weight loss. {context} {onset}", "Yes, weight loss since {onset}. {severity}", "weight loss for {onset}. {context}", "I noticed weight loss. {context} {severity}", "{context}. {severity}", "weight loss \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, weight loss \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, weight loss \u2014 {context}. {onset} I am scared.", "weight loss since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "weight loss \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "weight loss \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "weight loss \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "weight loss \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["weight loss. {onset}", "{context}. weight loss.", "{onset}. weight loss.", "{context}. {severity}", "weight loss \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "weight loss \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) weight loss. {onset}", "(reluctantly) Yes \u2014 weight loss. {context}", "(pause) weight loss \u2014 {context}.", "(hesitating) {context}. weight loss.", "(sighs) {context}. {onset}", "(looks away) weight loss \u2014 {context}.", "(quietly) Yes, weight loss. {context}", "(reluctantly) {context}. weight loss.", "(pause) weight loss \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has weight loss. {onset}", "Doctor, weight loss \u2014 {onset}. {severity}", "We noticed weight loss. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "weight loss \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 weight loss. {context} {onset} {severity}", "{context}. {severity}", "Doctor, weight loss \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: NIGHT SWEATS ────────────────────────────────────
  sr_night_sweats: {
    cooperative:             ["Yes \u2014 night sweats. {context} {severity}", "{context}. {onset}", "I have had night sweats. {context} {onset}", "Yes, night sweats since {onset}. {severity}", "night sweats for {onset}. {context}", "I noticed night sweats. {context} {severity}", "{context}. {severity}", "night sweats \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, night sweats \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, night sweats \u2014 {context}. {onset} I am scared.", "night sweats since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "night sweats \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "night sweats \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "night sweats \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "night sweats \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["night sweats. {onset}", "{context}. night sweats.", "{onset}. night sweats.", "{context}. {severity}", "night sweats \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "night sweats \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) night sweats. {onset}", "(reluctantly) Yes \u2014 night sweats. {context}", "(pause) night sweats \u2014 {context}.", "(hesitating) {context}. night sweats.", "(sighs) {context}. {onset}", "(looks away) night sweats \u2014 {context}.", "(quietly) Yes, night sweats. {context}", "(reluctantly) {context}. night sweats.", "(pause) night sweats \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has night sweats. {onset}", "Doctor, night sweats \u2014 {onset}. {severity}", "We noticed night sweats. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "night sweats \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 night sweats. {context} {onset} {severity}", "{context}. {severity}", "Doctor, night sweats \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: FATIGUE ─────────────────────────────────────────
  sr_fatigue: {
    cooperative:             ["Yes \u2014 fatigue/weakness. {context} {severity}", "{context}. {onset}", "I have had fatigue/weakness. {context} {onset}", "Yes, fatigue/weakness since {onset}. {severity}", "fatigue/weakness for {onset}. {context}", "I noticed fatigue/weakness. {context} {severity}", "{context}. {severity}", "fatigue/weakness \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, fatigue/weakness \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, fatigue/weakness \u2014 {context}. {onset} I am scared.", "fatigue/weakness since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "fatigue/weakness \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "fatigue/weakness \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "fatigue/weakness \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "fatigue/weakness \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["fatigue/weakness. {onset}", "{context}. fatigue/weakness.", "{onset}. fatigue/weakness.", "{context}. {severity}", "fatigue/weakness \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "fatigue/weakness \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) fatigue/weakness. {onset}", "(reluctantly) Yes \u2014 fatigue/weakness. {context}", "(pause) fatigue/weakness \u2014 {context}.", "(hesitating) {context}. fatigue/weakness.", "(sighs) {context}. {onset}", "(looks away) fatigue/weakness \u2014 {context}.", "(quietly) Yes, fatigue/weakness. {context}", "(reluctantly) {context}. fatigue/weakness.", "(pause) fatigue/weakness \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has fatigue/weakness. {onset}", "Doctor, fatigue/weakness \u2014 {onset}. {severity}", "We noticed fatigue/weakness. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "fatigue/weakness \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 fatigue/weakness. {context} {onset} {severity}", "{context}. {severity}", "Doctor, fatigue/weakness \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: DIZZINESS ───────────────────────────────────────
  sr_dizziness: {
    cooperative:             ["Yes \u2014 dizziness/vertigo. {context} {severity}", "{context}. {onset}", "I have had dizziness/vertigo. {context} {onset}", "Yes, dizziness/vertigo since {onset}. {severity}", "dizziness/vertigo for {onset}. {context}", "I noticed dizziness/vertigo. {context} {severity}", "{context}. {severity}", "dizziness/vertigo \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, dizziness/vertigo \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, dizziness/vertigo \u2014 {context}. {onset} I am scared.", "dizziness/vertigo since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "dizziness/vertigo \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "dizziness/vertigo \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "dizziness/vertigo \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "dizziness/vertigo \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["dizziness/vertigo. {onset}", "{context}. dizziness/vertigo.", "{onset}. dizziness/vertigo.", "{context}. {severity}", "dizziness/vertigo \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "dizziness/vertigo \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) dizziness/vertigo. {onset}", "(reluctantly) Yes \u2014 dizziness/vertigo. {context}", "(pause) dizziness/vertigo \u2014 {context}.", "(hesitating) {context}. dizziness/vertigo.", "(sighs) {context}. {onset}", "(looks away) dizziness/vertigo \u2014 {context}.", "(quietly) Yes, dizziness/vertigo. {context}", "(reluctantly) {context}. dizziness/vertigo.", "(pause) dizziness/vertigo \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has dizziness/vertigo. {onset}", "Doctor, dizziness/vertigo \u2014 {onset}. {severity}", "We noticed dizziness/vertigo. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "dizziness/vertigo \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 dizziness/vertigo. {context} {onset} {severity}", "{context}. {severity}", "Doctor, dizziness/vertigo \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: HEADACHE ────────────────────────────────────────
  sr_headache: {
    cooperative:             ["Yes \u2014 headache. {context} {severity}", "{context}. {onset}", "I have had headache. {context} {onset}", "Yes, headache since {onset}. {severity}", "headache for {onset}. {context}", "I noticed headache. {context} {severity}", "{context}. {severity}", "headache \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, headache \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, headache \u2014 {context}. {onset} I am scared.", "headache since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "headache \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "headache \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "headache \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "headache \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["headache. {onset}", "{context}. headache.", "{onset}. headache.", "{context}. {severity}", "headache \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "headache \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) headache. {onset}", "(reluctantly) Yes \u2014 headache. {context}", "(pause) headache \u2014 {context}.", "(hesitating) {context}. headache.", "(sighs) {context}. {onset}", "(looks away) headache \u2014 {context}.", "(quietly) Yes, headache. {context}", "(reluctantly) {context}. headache.", "(pause) headache \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has headache. {onset}", "Doctor, headache \u2014 {onset}. {severity}", "We noticed headache. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "headache \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 headache. {context} {onset} {severity}", "{context}. {severity}", "Doctor, headache \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: RESPIRATORY ─────────────────────────────────────
  sr_respiratory: {
    cooperative:             ["Yes \u2014 breathing difficulty. {context} {severity}", "{context}. {onset}", "I have had breathing difficulty. {context} {onset}", "Yes, breathing difficulty since {onset}. {severity}", "breathing difficulty for {onset}. {context}", "I noticed breathing difficulty. {context} {severity}", "{context}. {severity}", "breathing difficulty \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, breathing difficulty \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, breathing difficulty \u2014 {context}. {onset} I am scared.", "breathing difficulty since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "breathing difficulty \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "breathing difficulty \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "breathing difficulty \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "breathing difficulty \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["breathing difficulty. {onset}", "{context}. breathing difficulty.", "{onset}. breathing difficulty.", "{context}. {severity}", "breathing difficulty \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "breathing difficulty \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) breathing difficulty. {onset}", "(reluctantly) Yes \u2014 breathing difficulty. {context}", "(pause) breathing difficulty \u2014 {context}.", "(hesitating) {context}. breathing difficulty.", "(sighs) {context}. {onset}", "(looks away) breathing difficulty \u2014 {context}.", "(quietly) Yes, breathing difficulty. {context}", "(reluctantly) {context}. breathing difficulty.", "(pause) breathing difficulty \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has breathing difficulty. {onset}", "Doctor, breathing difficulty \u2014 {onset}. {severity}", "We noticed breathing difficulty. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "breathing difficulty \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 breathing difficulty. {context} {onset} {severity}", "{context}. {severity}", "Doctor, breathing difficulty \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: COUGH ───────────────────────────────────────────
  sr_cough: {
    cooperative:             ["Yes \u2014 cough. {context} {severity}", "{context}. {onset}", "I have had cough. {context} {onset}", "Yes, cough since {onset}. {severity}", "cough for {onset}. {context}", "I noticed cough. {context} {severity}", "{context}. {severity}", "cough \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, cough \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, cough \u2014 {context}. {onset} I am scared.", "cough since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "cough \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "cough \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "cough \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "cough \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["cough. {onset}", "{context}. cough.", "{onset}. cough.", "{context}. {severity}", "cough \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "cough \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) cough. {onset}", "(reluctantly) Yes \u2014 cough. {context}", "(pause) cough \u2014 {context}.", "(hesitating) {context}. cough.", "(sighs) {context}. {onset}", "(looks away) cough \u2014 {context}.", "(quietly) Yes, cough. {context}", "(reluctantly) {context}. cough.", "(pause) cough \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has cough. {onset}", "Doctor, cough \u2014 {onset}. {severity}", "We noticed cough. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "cough \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 cough. {context} {onset} {severity}", "{context}. {severity}", "Doctor, cough \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: HAEMATURIA ──────────────────────────────────────
  sr_haematuria: {
    cooperative:             ["Yes \u2014 blood in urine. {context} {severity}", "{context}. {onset}", "I have had blood in urine. {context} {onset}", "Yes, blood in urine since {onset}. {severity}", "blood in urine for {onset}. {context}", "I noticed blood in urine. {context} {severity}", "{context}. {severity}", "blood in urine \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, blood in urine \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, blood in urine \u2014 {context}. {onset} I am scared.", "blood in urine since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "blood in urine \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "blood in urine \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "blood in urine \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "blood in urine \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["blood in urine. {onset}", "{context}. blood in urine.", "{onset}. blood in urine.", "{context}. {severity}", "blood in urine \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "blood in urine \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) blood in urine. {onset}", "(reluctantly) Yes \u2014 blood in urine. {context}", "(pause) blood in urine \u2014 {context}.", "(hesitating) {context}. blood in urine.", "(sighs) {context}. {onset}", "(looks away) blood in urine \u2014 {context}.", "(quietly) Yes, blood in urine. {context}", "(reluctantly) {context}. blood in urine.", "(pause) blood in urine \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has blood in urine. {onset}", "Doctor, blood in urine \u2014 {onset}. {severity}", "We noticed blood in urine. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "blood in urine \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 blood in urine. {context} {onset} {severity}", "{context}. {severity}", "Doctor, blood in urine \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: HAEMOPTYSIS ─────────────────────────────────────
  sr_haemoptysis: {
    cooperative:             ["Yes \u2014 coughing blood. {context} {severity}", "{context}. {onset}", "I have had coughing blood. {context} {onset}", "Yes, coughing blood since {onset}. {severity}", "coughing blood for {onset}. {context}", "I noticed coughing blood. {context} {severity}", "{context}. {severity}", "coughing blood \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, coughing blood \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, coughing blood \u2014 {context}. {onset} I am scared.", "coughing blood since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "coughing blood \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "coughing blood \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "coughing blood \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "coughing blood \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["coughing blood. {onset}", "{context}. coughing blood.", "{onset}. coughing blood.", "{context}. {severity}", "coughing blood \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "coughing blood \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) coughing blood. {onset}", "(reluctantly) Yes \u2014 coughing blood. {context}", "(pause) coughing blood \u2014 {context}.", "(hesitating) {context}. coughing blood.", "(sighs) {context}. {onset}", "(looks away) coughing blood \u2014 {context}.", "(quietly) Yes, coughing blood. {context}", "(reluctantly) {context}. coughing blood.", "(pause) coughing blood \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has coughing blood. {onset}", "Doctor, coughing blood \u2014 {onset}. {severity}", "We noticed coughing blood. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "coughing blood \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 coughing blood. {context} {onset} {severity}", "{context}. {severity}", "Doctor, coughing blood \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: HAEMATEMESIS ────────────────────────────────────
  sr_haematemesis: {
    cooperative:             ["Yes \u2014 vomiting blood. {context} {severity}", "{context}. {onset}", "I have had vomiting blood. {context} {onset}", "Yes, vomiting blood since {onset}. {severity}", "vomiting blood for {onset}. {context}", "I noticed vomiting blood. {context} {severity}", "{context}. {severity}", "vomiting blood \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, vomiting blood \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, vomiting blood \u2014 {context}. {onset} I am scared.", "vomiting blood since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "vomiting blood \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "vomiting blood \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "vomiting blood \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "vomiting blood \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["vomiting blood. {onset}", "{context}. vomiting blood.", "{onset}. vomiting blood.", "{context}. {severity}", "vomiting blood \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "vomiting blood \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) vomiting blood. {onset}", "(reluctantly) Yes \u2014 vomiting blood. {context}", "(pause) vomiting blood \u2014 {context}.", "(hesitating) {context}. vomiting blood.", "(sighs) {context}. {onset}", "(looks away) vomiting blood \u2014 {context}.", "(quietly) Yes, vomiting blood. {context}", "(reluctantly) {context}. vomiting blood.", "(pause) vomiting blood \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has vomiting blood. {onset}", "Doctor, vomiting blood \u2014 {onset}. {severity}", "We noticed vomiting blood. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "vomiting blood \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 vomiting blood. {context} {onset} {severity}", "{context}. {severity}", "Doctor, vomiting blood \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: RECTAL BLEEDING ─────────────────────────────────
  sr_rectal_bleeding: {
    cooperative:             ["Yes \u2014 rectal bleeding. {context} {severity}", "{context}. {onset}", "I have had rectal bleeding. {context} {onset}", "Yes, rectal bleeding since {onset}. {severity}", "rectal bleeding for {onset}. {context}", "I noticed rectal bleeding. {context} {severity}", "{context}. {severity}", "rectal bleeding \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, rectal bleeding \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, rectal bleeding \u2014 {context}. {onset} I am scared.", "rectal bleeding since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "rectal bleeding \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "rectal bleeding \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "rectal bleeding \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "rectal bleeding \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["rectal bleeding. {onset}", "{context}. rectal bleeding.", "{onset}. rectal bleeding.", "{context}. {severity}", "rectal bleeding \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "rectal bleeding \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) rectal bleeding. {onset}", "(reluctantly) Yes \u2014 rectal bleeding. {context}", "(pause) rectal bleeding \u2014 {context}.", "(hesitating) {context}. rectal bleeding.", "(sighs) {context}. {onset}", "(looks away) rectal bleeding \u2014 {context}.", "(quietly) Yes, rectal bleeding. {context}", "(reluctantly) {context}. rectal bleeding.", "(pause) rectal bleeding \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has rectal bleeding. {onset}", "Doctor, rectal bleeding \u2014 {onset}. {severity}", "We noticed rectal bleeding. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "rectal bleeding \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 rectal bleeding. {context} {onset} {severity}", "{context}. {severity}", "Doctor, rectal bleeding \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: DYSPHAGIA ───────────────────────────────────────
  sr_dysphagia: {
    cooperative:             ["Yes \u2014 difficulty swallowing. {context} {severity}", "{context}. {onset}", "I have had difficulty swallowing. {context} {onset}", "Yes, difficulty swallowing since {onset}. {severity}", "difficulty swallowing for {onset}. {context}", "I noticed difficulty swallowing. {context} {severity}", "{context}. {severity}", "difficulty swallowing \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, difficulty swallowing \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, difficulty swallowing \u2014 {context}. {onset} I am scared.", "difficulty swallowing since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "difficulty swallowing \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "difficulty swallowing \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "difficulty swallowing \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "difficulty swallowing \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["difficulty swallowing. {onset}", "{context}. difficulty swallowing.", "{onset}. difficulty swallowing.", "{context}. {severity}", "difficulty swallowing \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "difficulty swallowing \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) difficulty swallowing. {onset}", "(reluctantly) Yes \u2014 difficulty swallowing. {context}", "(pause) difficulty swallowing \u2014 {context}.", "(hesitating) {context}. difficulty swallowing.", "(sighs) {context}. {onset}", "(looks away) difficulty swallowing \u2014 {context}.", "(quietly) Yes, difficulty swallowing. {context}", "(reluctantly) {context}. difficulty swallowing.", "(pause) difficulty swallowing \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has difficulty swallowing. {onset}", "Doctor, difficulty swallowing \u2014 {onset}. {severity}", "We noticed difficulty swallowing. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "difficulty swallowing \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 difficulty swallowing. {context} {onset} {severity}", "{context}. {severity}", "Doctor, difficulty swallowing \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: POLYURIA/POLYDIPSIA ─────────────────────────────
  sr_polyuria_polydipsia: {
    cooperative:             ["Yes \u2014 excessive thirst and urination. {context} {severity}", "{context}. {onset}", "I have had excessive thirst and urination. {context} {onset}", "Yes, excessive thirst and urination since {onset}. {severity}", "excessive thirst and urination for {onset}. {context}", "I noticed excessive thirst and urination. {context} {severity}", "{context}. {severity}", "excessive thirst and urination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, excessive thirst and urination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, excessive thirst and urination \u2014 {context}. {onset} I am scared.", "excessive thirst and urination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "excessive thirst and urination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "excessive thirst and urination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "excessive thirst and urination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "excessive thirst and urination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["excessive thirst and urination. {onset}", "{context}. excessive thirst and urination.", "{onset}. excessive thirst and urination.", "{context}. {severity}", "excessive thirst and urination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "excessive thirst and urination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) excessive thirst and urination. {onset}", "(reluctantly) Yes \u2014 excessive thirst and urination. {context}", "(pause) excessive thirst and urination \u2014 {context}.", "(hesitating) {context}. excessive thirst and urination.", "(sighs) {context}. {onset}", "(looks away) excessive thirst and urination \u2014 {context}.", "(quietly) Yes, excessive thirst and urination. {context}", "(reluctantly) {context}. excessive thirst and urination.", "(pause) excessive thirst and urination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has excessive thirst and urination. {onset}", "Doctor, excessive thirst and urination \u2014 {onset}. {severity}", "We noticed excessive thirst and urination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "excessive thirst and urination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 excessive thirst and urination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, excessive thirst and urination \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: THYROID SYMPTOMS ────────────────────────────────
  sr_thyroid_sx: {
    cooperative:             ["Yes \u2014 thyroid symptoms. {context} {severity}", "{context}. {onset}", "I have had thyroid symptoms. {context} {onset}", "Yes, thyroid symptoms since {onset}. {severity}", "thyroid symptoms for {onset}. {context}", "I noticed thyroid symptoms. {context} {severity}", "{context}. {severity}", "thyroid symptoms \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, thyroid symptoms \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, thyroid symptoms \u2014 {context}. {onset} I am scared.", "thyroid symptoms since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "thyroid symptoms \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "thyroid symptoms \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "thyroid symptoms \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "thyroid symptoms \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["thyroid symptoms. {onset}", "{context}. thyroid symptoms.", "{onset}. thyroid symptoms.", "{context}. {severity}", "thyroid symptoms \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "thyroid symptoms \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) thyroid symptoms. {onset}", "(reluctantly) Yes \u2014 thyroid symptoms. {context}", "(pause) thyroid symptoms \u2014 {context}.", "(hesitating) {context}. thyroid symptoms.", "(sighs) {context}. {onset}", "(looks away) thyroid symptoms \u2014 {context}.", "(quietly) Yes, thyroid symptoms. {context}", "(reluctantly) {context}. thyroid symptoms.", "(pause) thyroid symptoms \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has thyroid symptoms. {onset}", "Doctor, thyroid symptoms \u2014 {onset}. {severity}", "We noticed thyroid symptoms. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "thyroid symptoms \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 thyroid symptoms. {context} {onset} {severity}", "{context}. {severity}", "Doctor, thyroid symptoms \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: JOINT PAIN ──────────────────────────────────────
  sr_joint_pain: {
    cooperative:             ["Yes \u2014 joint pain. {context} {severity}", "{context}. {onset}", "I have had joint pain. {context} {onset}", "Yes, joint pain since {onset}. {severity}", "joint pain for {onset}. {context}", "I noticed joint pain. {context} {severity}", "{context}. {severity}", "joint pain \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, joint pain \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, joint pain \u2014 {context}. {onset} I am scared.", "joint pain since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "joint pain \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "joint pain \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "joint pain \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "joint pain \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["joint pain. {onset}", "{context}. joint pain.", "{onset}. joint pain.", "{context}. {severity}", "joint pain \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "joint pain \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) joint pain. {onset}", "(reluctantly) Yes \u2014 joint pain. {context}", "(pause) joint pain \u2014 {context}.", "(hesitating) {context}. joint pain.", "(sighs) {context}. {onset}", "(looks away) joint pain \u2014 {context}.", "(quietly) Yes, joint pain. {context}", "(reluctantly) {context}. joint pain.", "(pause) joint pain \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has joint pain. {onset}", "Doctor, joint pain \u2014 {onset}. {severity}", "We noticed joint pain. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "joint pain \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 joint pain. {context} {onset} {severity}", "{context}. {severity}", "Doctor, joint pain \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: BACK PAIN ───────────────────────────────────────
  sr_back_pain: {
    cooperative:             ["Yes \u2014 back pain. {context} {severity}", "{context}. {onset}", "I have had back pain. {context} {onset}", "Yes, back pain since {onset}. {severity}", "back pain for {onset}. {context}", "I noticed back pain. {context} {severity}", "{context}. {severity}", "back pain \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, back pain \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, back pain \u2014 {context}. {onset} I am scared.", "back pain since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "back pain \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "back pain \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "back pain \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "back pain \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["back pain. {onset}", "{context}. back pain.", "{onset}. back pain.", "{context}. {severity}", "back pain \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "back pain \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) back pain. {onset}", "(reluctantly) Yes \u2014 back pain. {context}", "(pause) back pain \u2014 {context}.", "(hesitating) {context}. back pain.", "(sighs) {context}. {onset}", "(looks away) back pain \u2014 {context}.", "(quietly) Yes, back pain. {context}", "(reluctantly) {context}. back pain.", "(pause) back pain \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has back pain. {onset}", "Doctor, back pain \u2014 {onset}. {severity}", "We noticed back pain. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "back pain \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 back pain. {context} {onset} {severity}", "{context}. {severity}", "Doctor, back pain \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: VISION ──────────────────────────────────────────
  sr_vision: {
    cooperative:             ["Yes \u2014 visual disturbance. {context} {severity}", "{context}. {onset}", "I have had visual disturbance. {context} {onset}", "Yes, visual disturbance since {onset}. {severity}", "visual disturbance for {onset}. {context}", "I noticed visual disturbance. {context} {severity}", "{context}. {severity}", "visual disturbance \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, visual disturbance \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, visual disturbance \u2014 {context}. {onset} I am scared.", "visual disturbance since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "visual disturbance \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "visual disturbance \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "visual disturbance \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "visual disturbance \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["visual disturbance. {onset}", "{context}. visual disturbance.", "{onset}. visual disturbance.", "{context}. {severity}", "visual disturbance \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "visual disturbance \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) visual disturbance. {onset}", "(reluctantly) Yes \u2014 visual disturbance. {context}", "(pause) visual disturbance \u2014 {context}.", "(hesitating) {context}. visual disturbance.", "(sighs) {context}. {onset}", "(looks away) visual disturbance \u2014 {context}.", "(quietly) Yes, visual disturbance. {context}", "(reluctantly) {context}. visual disturbance.", "(pause) visual disturbance \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has visual disturbance. {onset}", "Doctor, visual disturbance \u2014 {onset}. {severity}", "We noticed visual disturbance. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "visual disturbance \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 visual disturbance. {context} {onset} {severity}", "{context}. {severity}", "Doctor, visual disturbance \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: RASH ────────────────────────────────────────────
  sr_rash: {
    cooperative:             ["Yes \u2014 skin rash. {context} {severity}", "{context}. {onset}", "I have had skin rash. {context} {onset}", "Yes, skin rash since {onset}. {severity}", "skin rash for {onset}. {context}", "I noticed skin rash. {context} {severity}", "{context}. {severity}", "skin rash \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, skin rash \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, skin rash \u2014 {context}. {onset} I am scared.", "skin rash since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "skin rash \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "skin rash \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "skin rash \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "skin rash \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["skin rash. {onset}", "{context}. skin rash.", "{onset}. skin rash.", "{context}. {severity}", "skin rash \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "skin rash \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) skin rash. {onset}", "(reluctantly) Yes \u2014 skin rash. {context}", "(pause) skin rash \u2014 {context}.", "(hesitating) {context}. skin rash.", "(sighs) {context}. {onset}", "(looks away) skin rash \u2014 {context}.", "(quietly) Yes, skin rash. {context}", "(reluctantly) {context}. skin rash.", "(pause) skin rash \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has skin rash. {onset}", "Doctor, skin rash \u2014 {onset}. {severity}", "We noticed skin rash. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "skin rash \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 skin rash. {context} {onset} {severity}", "{context}. {severity}", "Doctor, skin rash \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: LYMPH NODES ─────────────────────────────────────
  sr_lymph_nodes: {
    cooperative:             ["Yes \u2014 swollen glands. {context} {severity}", "{context}. {onset}", "I have had swollen glands. {context} {onset}", "Yes, swollen glands since {onset}. {severity}", "swollen glands for {onset}. {context}", "I noticed swollen glands. {context} {severity}", "{context}. {severity}", "swollen glands \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, swollen glands \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, swollen glands \u2014 {context}. {onset} I am scared.", "swollen glands since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "swollen glands \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "swollen glands \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "swollen glands \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "swollen glands \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["swollen glands. {onset}", "{context}. swollen glands.", "{onset}. swollen glands.", "{context}. {severity}", "swollen glands \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "swollen glands \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) swollen glands. {onset}", "(reluctantly) Yes \u2014 swollen glands. {context}", "(pause) swollen glands \u2014 {context}.", "(hesitating) {context}. swollen glands.", "(sighs) {context}. {onset}", "(looks away) swollen glands \u2014 {context}.", "(quietly) Yes, swollen glands. {context}", "(reluctantly) {context}. swollen glands.", "(pause) swollen glands \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has swollen glands. {onset}", "Doctor, swollen glands \u2014 {onset}. {severity}", "We noticed swollen glands. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "swollen glands \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 swollen glands. {context} {onset} {severity}", "{context}. {severity}", "Doctor, swollen glands \u2014 {context}. {onset} {severity}"],
  },
  // ── SR: MENSTRUAL ───────────────────────────────────────
  sr_menstrual: {
    cooperative:             ["Yes \u2014 menstrual changes. {context} {severity}", "{context}. {onset}", "I have had menstrual changes. {context} {onset}", "Yes, menstrual changes since {onset}. {severity}", "menstrual changes for {onset}. {context}", "I noticed menstrual changes. {context} {severity}", "{context}. {severity}", "menstrual changes \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, menstrual changes \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, menstrual changes \u2014 {context}. {onset} I am scared.", "menstrual changes since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "menstrual changes \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "menstrual changes \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "menstrual changes \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "menstrual changes \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["menstrual changes. {onset}", "{context}. menstrual changes.", "{onset}. menstrual changes.", "{context}. {severity}", "menstrual changes \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "menstrual changes \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) menstrual changes. {onset}", "(reluctantly) Yes \u2014 menstrual changes. {context}", "(pause) menstrual changes \u2014 {context}.", "(hesitating) {context}. menstrual changes.", "(sighs) {context}. {onset}", "(looks away) menstrual changes \u2014 {context}.", "(quietly) Yes, menstrual changes. {context}", "(reluctantly) {context}. menstrual changes.", "(pause) menstrual changes \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has menstrual changes. {onset}", "Doctor, menstrual changes \u2014 {onset}. {severity}", "We noticed menstrual changes. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "menstrual changes \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 menstrual changes. {context} {onset} {severity}", "{context}. {severity}", "Doctor, menstrual changes \u2014 {context}. {onset} {severity}"],
  },
  // ── PAEDS: BIRTH HISTORY ────────────────────────────────
  peds_birth_history: {
    cooperative:             ["Yes \u2014 birth/perinatal history. {context} {severity}", "{context}. {onset}", "I have had birth/perinatal history. {context} {onset}", "Yes, birth/perinatal history since {onset}. {severity}", "birth/perinatal history for {onset}. {context}", "I noticed birth/perinatal history. {context} {severity}", "{context}. {severity}", "birth/perinatal history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, birth/perinatal history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, birth/perinatal history \u2014 {context}. {onset} I am scared.", "birth/perinatal history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "birth/perinatal history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "birth/perinatal history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "birth/perinatal history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "birth/perinatal history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["birth/perinatal history. {onset}", "{context}. birth/perinatal history.", "{onset}. birth/perinatal history.", "{context}. {severity}", "birth/perinatal history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "birth/perinatal history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) birth/perinatal history. {onset}", "(reluctantly) Yes \u2014 birth/perinatal history. {context}", "(pause) birth/perinatal history \u2014 {context}.", "(hesitating) {context}. birth/perinatal history.", "(sighs) {context}. {onset}", "(looks away) birth/perinatal history \u2014 {context}.", "(quietly) Yes, birth/perinatal history. {context}", "(reluctantly) {context}. birth/perinatal history.", "(pause) birth/perinatal history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has birth/perinatal history. {onset}", "Doctor, birth/perinatal history \u2014 {onset}. {severity}", "We noticed birth/perinatal history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "birth/perinatal history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 birth/perinatal history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, birth/perinatal history \u2014 {context}. {onset} {severity}"],
  },
  // ── PAEDS: DEVELOPMENTAL HISTORY ────────────────────────
  peds_dev_history: {
    cooperative:             ["Yes \u2014 developmental milestones. {context} {severity}", "{context}. {onset}", "I have had developmental milestones. {context} {onset}", "Yes, developmental milestones since {onset}. {severity}", "developmental milestones for {onset}. {context}", "I noticed developmental milestones. {context} {severity}", "{context}. {severity}", "developmental milestones \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, developmental milestones \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, developmental milestones \u2014 {context}. {onset} I am scared.", "developmental milestones since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "developmental milestones \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "developmental milestones \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "developmental milestones \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "developmental milestones \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["developmental milestones. {onset}", "{context}. developmental milestones.", "{onset}. developmental milestones.", "{context}. {severity}", "developmental milestones \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "developmental milestones \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) developmental milestones. {onset}", "(reluctantly) Yes \u2014 developmental milestones. {context}", "(pause) developmental milestones \u2014 {context}.", "(hesitating) {context}. developmental milestones.", "(sighs) {context}. {onset}", "(looks away) developmental milestones \u2014 {context}.", "(quietly) Yes, developmental milestones. {context}", "(reluctantly) {context}. developmental milestones.", "(pause) developmental milestones \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has developmental milestones. {onset}", "Doctor, developmental milestones \u2014 {onset}. {severity}", "We noticed developmental milestones. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "developmental milestones \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 developmental milestones. {context} {onset} {severity}", "{context}. {severity}", "Doctor, developmental milestones \u2014 {context}. {onset} {severity}"],
  },
  // ── PAEDS: FEEDING ──────────────────────────────────────
  peds_feeding: {
    cooperative:             ["Yes \u2014 feeding history. {context} {severity}", "{context}. {onset}", "I have had feeding history. {context} {onset}", "Yes, feeding history since {onset}. {severity}", "feeding history for {onset}. {context}", "I noticed feeding history. {context} {severity}", "{context}. {severity}", "feeding history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, feeding history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, feeding history \u2014 {context}. {onset} I am scared.", "feeding history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "feeding history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "feeding history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "feeding history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "feeding history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["feeding history. {onset}", "{context}. feeding history.", "{onset}. feeding history.", "{context}. {severity}", "feeding history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "feeding history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) feeding history. {onset}", "(reluctantly) Yes \u2014 feeding history. {context}", "(pause) feeding history \u2014 {context}.", "(hesitating) {context}. feeding history.", "(sighs) {context}. {onset}", "(looks away) feeding history \u2014 {context}.", "(quietly) Yes, feeding history. {context}", "(reluctantly) {context}. feeding history.", "(pause) feeding history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has feeding history. {onset}", "Doctor, feeding history \u2014 {onset}. {severity}", "We noticed feeding history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "feeding history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 feeding history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, feeding history \u2014 {context}. {onset} {severity}"],
  },
  // ── PAEDS: GROWTH ───────────────────────────────────────
  peds_growth: {
    cooperative:             ["Yes \u2014 growth/weight. {context} {severity}", "{context}. {onset}", "I have had growth/weight. {context} {onset}", "Yes, growth/weight since {onset}. {severity}", "growth/weight for {onset}. {context}", "I noticed growth/weight. {context} {severity}", "{context}. {severity}", "growth/weight \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, growth/weight \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, growth/weight \u2014 {context}. {onset} I am scared.", "growth/weight since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "growth/weight \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "growth/weight \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "growth/weight \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "growth/weight \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["growth/weight. {onset}", "{context}. growth/weight.", "{onset}. growth/weight.", "{context}. {severity}", "growth/weight \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "growth/weight \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) growth/weight. {onset}", "(reluctantly) Yes \u2014 growth/weight. {context}", "(pause) growth/weight \u2014 {context}.", "(hesitating) {context}. growth/weight.", "(sighs) {context}. {onset}", "(looks away) growth/weight \u2014 {context}.", "(quietly) Yes, growth/weight. {context}", "(reluctantly) {context}. growth/weight.", "(pause) growth/weight \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has growth/weight. {onset}", "Doctor, growth/weight \u2014 {onset}. {severity}", "We noticed growth/weight. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "growth/weight \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 growth/weight. {context} {onset} {severity}", "{context}. {severity}", "Doctor, growth/weight \u2014 {context}. {onset} {severity}"],
  },
  // ── PAEDS: BEHAVIOUR ────────────────────────────────────
  peds_behaviour: {
    cooperative:             ["Yes \u2014 behavioural changes. {context} {severity}", "{context}. {onset}", "I have had behavioural changes. {context} {onset}", "Yes, behavioural changes since {onset}. {severity}", "behavioural changes for {onset}. {context}", "I noticed behavioural changes. {context} {severity}", "{context}. {severity}", "behavioural changes \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, behavioural changes \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, behavioural changes \u2014 {context}. {onset} I am scared.", "behavioural changes since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "behavioural changes \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "behavioural changes \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "behavioural changes \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "behavioural changes \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["behavioural changes. {onset}", "{context}. behavioural changes.", "{onset}. behavioural changes.", "{context}. {severity}", "behavioural changes \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "behavioural changes \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) behavioural changes. {onset}", "(reluctantly) Yes \u2014 behavioural changes. {context}", "(pause) behavioural changes \u2014 {context}.", "(hesitating) {context}. behavioural changes.", "(sighs) {context}. {onset}", "(looks away) behavioural changes \u2014 {context}.", "(quietly) Yes, behavioural changes. {context}", "(reluctantly) {context}. behavioural changes.", "(pause) behavioural changes \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has behavioural changes. {onset}", "Doctor, behavioural changes \u2014 {onset}. {severity}", "We noticed behavioural changes. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "behavioural changes \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 behavioural changes. {context} {onset} {severity}", "{context}. {severity}", "Doctor, behavioural changes \u2014 {context}. {onset} {severity}"],
  },
  // ── PAEDS: SCHOOL ───────────────────────────────────────
  peds_school: {
    cooperative:             ["Yes \u2014 school performance. {context} {severity}", "{context}. {onset}", "I have had school performance. {context} {onset}", "Yes, school performance since {onset}. {severity}", "school performance for {onset}. {context}", "I noticed school performance. {context} {severity}", "{context}. {severity}", "school performance \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, school performance \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, school performance \u2014 {context}. {onset} I am scared.", "school performance since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "school performance \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "school performance \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "school performance \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "school performance \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["school performance. {onset}", "{context}. school performance.", "{onset}. school performance.", "{context}. {severity}", "school performance \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "school performance \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) school performance. {onset}", "(reluctantly) Yes \u2014 school performance. {context}", "(pause) school performance \u2014 {context}.", "(hesitating) {context}. school performance.", "(sighs) {context}. {onset}", "(looks away) school performance \u2014 {context}.", "(quietly) Yes, school performance. {context}", "(reluctantly) {context}. school performance.", "(pause) school performance \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has school performance. {onset}", "Doctor, school performance \u2014 {onset}. {severity}", "We noticed school performance. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "school performance \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 school performance. {context} {onset} {severity}", "{context}. {severity}", "Doctor, school performance \u2014 {context}. {onset} {severity}"],
  },
  // ── PAEDS: IMMUNISATION ─────────────────────────────────
  immunisation: {
    cooperative:             ["Yes \u2014 immunisation history. {context} {severity}", "{context}. {onset}", "I have had immunisation history. {context} {onset}", "Yes, immunisation history since {onset}. {severity}", "immunisation history for {onset}. {context}", "I noticed immunisation history. {context} {severity}", "{context}. {severity}", "immunisation history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, immunisation history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, immunisation history \u2014 {context}. {onset} I am scared.", "immunisation history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "immunisation history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "immunisation history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "immunisation history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "immunisation history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["immunisation history. {onset}", "{context}. immunisation history.", "{onset}. immunisation history.", "{context}. {severity}", "immunisation history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "immunisation history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) immunisation history. {onset}", "(reluctantly) Yes \u2014 immunisation history. {context}", "(pause) immunisation history \u2014 {context}.", "(hesitating) {context}. immunisation history.", "(sighs) {context}. {onset}", "(looks away) immunisation history \u2014 {context}.", "(quietly) Yes, immunisation history. {context}", "(reluctantly) {context}. immunisation history.", "(pause) immunisation history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has immunisation history. {onset}", "Doctor, immunisation history \u2014 {onset}. {severity}", "We noticed immunisation history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "immunisation history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 immunisation history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, immunisation history \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: ANTENATAL ──────────────────────────────────────
  antenatal: {
    cooperative:             ["Yes \u2014 antenatal care. {context} {severity}", "{context}. {onset}", "I have had antenatal care. {context} {onset}", "Yes, antenatal care since {onset}. {severity}", "antenatal care for {onset}. {context}", "I noticed antenatal care. {context} {severity}", "{context}. {severity}", "antenatal care \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, antenatal care \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, antenatal care \u2014 {context}. {onset} I am scared.", "antenatal care since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "antenatal care \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "antenatal care \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "antenatal care \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "antenatal care \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["antenatal care. {onset}", "{context}. antenatal care.", "{onset}. antenatal care.", "{context}. {severity}", "antenatal care \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "antenatal care \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) antenatal care. {onset}", "(reluctantly) Yes \u2014 antenatal care. {context}", "(pause) antenatal care \u2014 {context}.", "(hesitating) {context}. antenatal care.", "(sighs) {context}. {onset}", "(looks away) antenatal care \u2014 {context}.", "(quietly) Yes, antenatal care. {context}", "(reluctantly) {context}. antenatal care.", "(pause) antenatal care \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has antenatal care. {onset}", "Doctor, antenatal care \u2014 {onset}. {severity}", "We noticed antenatal care. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "antenatal care \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 antenatal care. {context} {onset} {severity}", "{context}. {severity}", "Doctor, antenatal care \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: PARITY ─────────────────────────────────────────
  parity: {
    cooperative:             ["Yes \u2014 obstetric/parity history. {context} {severity}", "{context}. {onset}", "I have had obstetric/parity history. {context} {onset}", "Yes, obstetric/parity history since {onset}. {severity}", "obstetric/parity history for {onset}. {context}", "I noticed obstetric/parity history. {context} {severity}", "{context}. {severity}", "obstetric/parity history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, obstetric/parity history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, obstetric/parity history \u2014 {context}. {onset} I am scared.", "obstetric/parity history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "obstetric/parity history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "obstetric/parity history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "obstetric/parity history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "obstetric/parity history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["obstetric/parity history. {onset}", "{context}. obstetric/parity history.", "{onset}. obstetric/parity history.", "{context}. {severity}", "obstetric/parity history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "obstetric/parity history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) obstetric/parity history. {onset}", "(reluctantly) Yes \u2014 obstetric/parity history. {context}", "(pause) obstetric/parity history \u2014 {context}.", "(hesitating) {context}. obstetric/parity history.", "(sighs) {context}. {onset}", "(looks away) obstetric/parity history \u2014 {context}.", "(quietly) Yes, obstetric/parity history. {context}", "(reluctantly) {context}. obstetric/parity history.", "(pause) obstetric/parity history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has obstetric/parity history. {onset}", "Doctor, obstetric/parity history \u2014 {onset}. {severity}", "We noticed obstetric/parity history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "obstetric/parity history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 obstetric/parity history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, obstetric/parity history \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: LMP ────────────────────────────────────────────
  og_lmp: {
    cooperative:             ["Yes \u2014 last menstrual period. {context} {severity}", "{context}. {onset}", "I have had last menstrual period. {context} {onset}", "Yes, last menstrual period since {onset}. {severity}", "last menstrual period for {onset}. {context}", "I noticed last menstrual period. {context} {severity}", "{context}. {severity}", "last menstrual period \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, last menstrual period \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, last menstrual period \u2014 {context}. {onset} I am scared.", "last menstrual period since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "last menstrual period \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "last menstrual period \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "last menstrual period \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "last menstrual period \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["last menstrual period. {onset}", "{context}. last menstrual period.", "{onset}. last menstrual period.", "{context}. {severity}", "last menstrual period \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "last menstrual period \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) last menstrual period. {onset}", "(reluctantly) Yes \u2014 last menstrual period. {context}", "(pause) last menstrual period \u2014 {context}.", "(hesitating) {context}. last menstrual period.", "(sighs) {context}. {onset}", "(looks away) last menstrual period \u2014 {context}.", "(quietly) Yes, last menstrual period. {context}", "(reluctantly) {context}. last menstrual period.", "(pause) last menstrual period \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has last menstrual period. {onset}", "Doctor, last menstrual period \u2014 {onset}. {severity}", "We noticed last menstrual period. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "last menstrual period \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 last menstrual period. {context} {onset} {severity}", "{context}. {severity}", "Doctor, last menstrual period \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: CYCLE ──────────────────────────────────────────
  og_cycle: {
    cooperative:             ["Yes \u2014 menstrual cycle. {context} {severity}", "{context}. {onset}", "I have had menstrual cycle. {context} {onset}", "Yes, menstrual cycle since {onset}. {severity}", "menstrual cycle for {onset}. {context}", "I noticed menstrual cycle. {context} {severity}", "{context}. {severity}", "menstrual cycle \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, menstrual cycle \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, menstrual cycle \u2014 {context}. {onset} I am scared.", "menstrual cycle since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "menstrual cycle \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "menstrual cycle \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "menstrual cycle \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "menstrual cycle \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["menstrual cycle. {onset}", "{context}. menstrual cycle.", "{onset}. menstrual cycle.", "{context}. {severity}", "menstrual cycle \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "menstrual cycle \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) menstrual cycle. {onset}", "(reluctantly) Yes \u2014 menstrual cycle. {context}", "(pause) menstrual cycle \u2014 {context}.", "(hesitating) {context}. menstrual cycle.", "(sighs) {context}. {onset}", "(looks away) menstrual cycle \u2014 {context}.", "(quietly) Yes, menstrual cycle. {context}", "(reluctantly) {context}. menstrual cycle.", "(pause) menstrual cycle \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has menstrual cycle. {onset}", "Doctor, menstrual cycle \u2014 {onset}. {severity}", "We noticed menstrual cycle. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "menstrual cycle \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 menstrual cycle. {context} {onset} {severity}", "{context}. {severity}", "Doctor, menstrual cycle \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: DISCHARGE ──────────────────────────────────────
  og_discharge: {
    cooperative:             ["Yes \u2014 vaginal discharge. {context} {severity}", "{context}. {onset}", "I have had vaginal discharge. {context} {onset}", "Yes, vaginal discharge since {onset}. {severity}", "vaginal discharge for {onset}. {context}", "I noticed vaginal discharge. {context} {severity}", "{context}. {severity}", "vaginal discharge \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, vaginal discharge \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, vaginal discharge \u2014 {context}. {onset} I am scared.", "vaginal discharge since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "vaginal discharge \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "vaginal discharge \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "vaginal discharge \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "vaginal discharge \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["vaginal discharge. {onset}", "{context}. vaginal discharge.", "{onset}. vaginal discharge.", "{context}. {severity}", "vaginal discharge \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "vaginal discharge \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) vaginal discharge. {onset}", "(reluctantly) Yes \u2014 vaginal discharge. {context}", "(pause) vaginal discharge \u2014 {context}.", "(hesitating) {context}. vaginal discharge.", "(sighs) {context}. {onset}", "(looks away) vaginal discharge \u2014 {context}.", "(quietly) Yes, vaginal discharge. {context}", "(reluctantly) {context}. vaginal discharge.", "(pause) vaginal discharge \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has vaginal discharge. {onset}", "Doctor, vaginal discharge \u2014 {onset}. {severity}", "We noticed vaginal discharge. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "vaginal discharge \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 vaginal discharge. {context} {onset} {severity}", "{context}. {severity}", "Doctor, vaginal discharge \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: PV BLEEDING ────────────────────────────────────
  og_bleeding_pv: {
    cooperative:             ["Yes \u2014 PV bleeding. {context} {severity}", "{context}. {onset}", "I have had PV bleeding. {context} {onset}", "Yes, PV bleeding since {onset}. {severity}", "PV bleeding for {onset}. {context}", "I noticed PV bleeding. {context} {severity}", "{context}. {severity}", "PV bleeding \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, PV bleeding \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, PV bleeding \u2014 {context}. {onset} I am scared.", "PV bleeding since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "PV bleeding \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "PV bleeding \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "PV bleeding \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "PV bleeding \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["PV bleeding. {onset}", "{context}. PV bleeding.", "{onset}. PV bleeding.", "{context}. {severity}", "PV bleeding \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "PV bleeding \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) PV bleeding. {onset}", "(reluctantly) Yes \u2014 PV bleeding. {context}", "(pause) PV bleeding \u2014 {context}.", "(hesitating) {context}. PV bleeding.", "(sighs) {context}. {onset}", "(looks away) PV bleeding \u2014 {context}.", "(quietly) Yes, PV bleeding. {context}", "(reluctantly) {context}. PV bleeding.", "(pause) PV bleeding \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has PV bleeding. {onset}", "Doctor, PV bleeding \u2014 {onset}. {severity}", "We noticed PV bleeding. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "PV bleeding \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 PV bleeding. {context} {onset} {severity}", "{context}. {severity}", "Doctor, PV bleeding \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: PELVIC PAIN ────────────────────────────────────
  og_pain_pv: {
    cooperative:             ["Yes \u2014 pelvic/lower abdominal pain. {context} {severity}", "{context}. {onset}", "I have had pelvic/lower abdominal pain. {context} {onset}", "Yes, pelvic/lower abdominal pain since {onset}. {severity}", "pelvic/lower abdominal pain for {onset}. {context}", "I noticed pelvic/lower abdominal pain. {context} {severity}", "{context}. {severity}", "pelvic/lower abdominal pain \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, pelvic/lower abdominal pain \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, pelvic/lower abdominal pain \u2014 {context}. {onset} I am scared.", "pelvic/lower abdominal pain since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "pelvic/lower abdominal pain \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "pelvic/lower abdominal pain \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "pelvic/lower abdominal pain \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "pelvic/lower abdominal pain \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["pelvic/lower abdominal pain. {onset}", "{context}. pelvic/lower abdominal pain.", "{onset}. pelvic/lower abdominal pain.", "{context}. {severity}", "pelvic/lower abdominal pain \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "pelvic/lower abdominal pain \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) pelvic/lower abdominal pain. {onset}", "(reluctantly) Yes \u2014 pelvic/lower abdominal pain. {context}", "(pause) pelvic/lower abdominal pain \u2014 {context}.", "(hesitating) {context}. pelvic/lower abdominal pain.", "(sighs) {context}. {onset}", "(looks away) pelvic/lower abdominal pain \u2014 {context}.", "(quietly) Yes, pelvic/lower abdominal pain. {context}", "(reluctantly) {context}. pelvic/lower abdominal pain.", "(pause) pelvic/lower abdominal pain \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has pelvic/lower abdominal pain. {onset}", "Doctor, pelvic/lower abdominal pain \u2014 {onset}. {severity}", "We noticed pelvic/lower abdominal pain. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "pelvic/lower abdominal pain \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 pelvic/lower abdominal pain. {context} {onset} {severity}", "{context}. {severity}", "Doctor, pelvic/lower abdominal pain \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: CONTRACEPTION ──────────────────────────────────
  og_contraception: {
    cooperative:             ["Yes \u2014 contraception. {context} {severity}", "{context}. {onset}", "I have had contraception. {context} {onset}", "Yes, contraception since {onset}. {severity}", "contraception for {onset}. {context}", "I noticed contraception. {context} {severity}", "{context}. {severity}", "contraception \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, contraception \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, contraception \u2014 {context}. {onset} I am scared.", "contraception since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "contraception \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "contraception \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "contraception \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "contraception \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["contraception. {onset}", "{context}. contraception.", "{onset}. contraception.", "{context}. {severity}", "contraception \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "contraception \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) contraception. {onset}", "(reluctantly) Yes \u2014 contraception. {context}", "(pause) contraception \u2014 {context}.", "(hesitating) {context}. contraception.", "(sighs) {context}. {onset}", "(looks away) contraception \u2014 {context}.", "(quietly) Yes, contraception. {context}", "(reluctantly) {context}. contraception.", "(pause) contraception \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has contraception. {onset}", "Doctor, contraception \u2014 {onset}. {severity}", "We noticed contraception. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "contraception \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 contraception. {context} {onset} {severity}", "{context}. {severity}", "Doctor, contraception \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: SMEAR ──────────────────────────────────────────
  og_smear: {
    cooperative:             ["Yes \u2014 cervical smear history. {context} {severity}", "{context}. {onset}", "I have had cervical smear history. {context} {onset}", "Yes, cervical smear history since {onset}. {severity}", "cervical smear history for {onset}. {context}", "I noticed cervical smear history. {context} {severity}", "{context}. {severity}", "cervical smear history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, cervical smear history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, cervical smear history \u2014 {context}. {onset} I am scared.", "cervical smear history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "cervical smear history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "cervical smear history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "cervical smear history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "cervical smear history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["cervical smear history. {onset}", "{context}. cervical smear history.", "{onset}. cervical smear history.", "{context}. {severity}", "cervical smear history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "cervical smear history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) cervical smear history. {onset}", "(reluctantly) Yes \u2014 cervical smear history. {context}", "(pause) cervical smear history \u2014 {context}.", "(hesitating) {context}. cervical smear history.", "(sighs) {context}. {onset}", "(looks away) cervical smear history \u2014 {context}.", "(quietly) Yes, cervical smear history. {context}", "(reluctantly) {context}. cervical smear history.", "(pause) cervical smear history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has cervical smear history. {onset}", "Doctor, cervical smear history \u2014 {onset}. {severity}", "We noticed cervical smear history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "cervical smear history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 cervical smear history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, cervical smear history \u2014 {context}. {onset} {severity}"],
  },
  // ── O&G: FERTILITY ──────────────────────────────────────
  og_fertility: {
    cooperative:             ["Yes \u2014 fertility history. {context} {severity}", "{context}. {onset}", "I have had fertility history. {context} {onset}", "Yes, fertility history since {onset}. {severity}", "fertility history for {onset}. {context}", "I noticed fertility history. {context} {severity}", "{context}. {severity}", "fertility history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, fertility history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, fertility history \u2014 {context}. {onset} I am scared.", "fertility history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "fertility history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "fertility history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "fertility history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "fertility history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["fertility history. {onset}", "{context}. fertility history.", "{onset}. fertility history.", "{context}. {severity}", "fertility history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "fertility history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) fertility history. {onset}", "(reluctantly) Yes \u2014 fertility history. {context}", "(pause) fertility history \u2014 {context}.", "(hesitating) {context}. fertility history.", "(sighs) {context}. {onset}", "(looks away) fertility history \u2014 {context}.", "(quietly) Yes, fertility history. {context}", "(reluctantly) {context}. fertility history.", "(pause) fertility history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has fertility history. {onset}", "Doctor, fertility history \u2014 {onset}. {severity}", "We noticed fertility history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "fertility history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 fertility history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, fertility history \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: WOUND ──────────────────────────────────────
  surg_wound: {
    cooperative:             ["Yes \u2014 wound changes. {context} {severity}", "{context}. {onset}", "I have had wound changes. {context} {onset}", "Yes, wound changes since {onset}. {severity}", "wound changes for {onset}. {context}", "I noticed wound changes. {context} {severity}", "{context}. {severity}", "wound changes \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, wound changes \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, wound changes \u2014 {context}. {onset} I am scared.", "wound changes since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "wound changes \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "wound changes \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "wound changes \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "wound changes \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["wound changes. {onset}", "{context}. wound changes.", "{onset}. wound changes.", "{context}. {severity}", "wound changes \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "wound changes \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) wound changes. {onset}", "(reluctantly) Yes \u2014 wound changes. {context}", "(pause) wound changes \u2014 {context}.", "(hesitating) {context}. wound changes.", "(sighs) {context}. {onset}", "(looks away) wound changes \u2014 {context}.", "(quietly) Yes, wound changes. {context}", "(reluctantly) {context}. wound changes.", "(pause) wound changes \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has wound changes. {onset}", "Doctor, wound changes \u2014 {onset}. {severity}", "We noticed wound changes. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "wound changes \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 wound changes. {context} {onset} {severity}", "{context}. {severity}", "Doctor, wound changes \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: BLEEDING ───────────────────────────────────
  surg_bleeding: {
    cooperative:             ["Yes \u2014 surgical/acute bleeding. {context} {severity}", "{context}. {onset}", "I have had surgical/acute bleeding. {context} {onset}", "Yes, surgical/acute bleeding since {onset}. {severity}", "surgical/acute bleeding for {onset}. {context}", "I noticed surgical/acute bleeding. {context} {severity}", "{context}. {severity}", "surgical/acute bleeding \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, surgical/acute bleeding \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, surgical/acute bleeding \u2014 {context}. {onset} I am scared.", "surgical/acute bleeding since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "surgical/acute bleeding \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "surgical/acute bleeding \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "surgical/acute bleeding \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "surgical/acute bleeding \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["surgical/acute bleeding. {onset}", "{context}. surgical/acute bleeding.", "{onset}. surgical/acute bleeding.", "{context}. {severity}", "surgical/acute bleeding \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "surgical/acute bleeding \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) surgical/acute bleeding. {onset}", "(reluctantly) Yes \u2014 surgical/acute bleeding. {context}", "(pause) surgical/acute bleeding \u2014 {context}.", "(hesitating) {context}. surgical/acute bleeding.", "(sighs) {context}. {onset}", "(looks away) surgical/acute bleeding \u2014 {context}.", "(quietly) Yes, surgical/acute bleeding. {context}", "(reluctantly) {context}. surgical/acute bleeding.", "(pause) surgical/acute bleeding \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has surgical/acute bleeding. {onset}", "Doctor, surgical/acute bleeding \u2014 {onset}. {severity}", "We noticed surgical/acute bleeding. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "surgical/acute bleeding \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 surgical/acute bleeding. {context} {onset} {severity}", "{context}. {severity}", "Doctor, surgical/acute bleeding \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: SWELLING ───────────────────────────────────
  surg_swelling: {
    cooperative:             ["Yes \u2014 lump/swelling. {context} {severity}", "{context}. {onset}", "I have had lump/swelling. {context} {onset}", "Yes, lump/swelling since {onset}. {severity}", "lump/swelling for {onset}. {context}", "I noticed lump/swelling. {context} {severity}", "{context}. {severity}", "lump/swelling \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, lump/swelling \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, lump/swelling \u2014 {context}. {onset} I am scared.", "lump/swelling since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "lump/swelling \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "lump/swelling \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "lump/swelling \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "lump/swelling \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["lump/swelling. {onset}", "{context}. lump/swelling.", "{onset}. lump/swelling.", "{context}. {severity}", "lump/swelling \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "lump/swelling \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) lump/swelling. {onset}", "(reluctantly) Yes \u2014 lump/swelling. {context}", "(pause) lump/swelling \u2014 {context}.", "(hesitating) {context}. lump/swelling.", "(sighs) {context}. {onset}", "(looks away) lump/swelling \u2014 {context}.", "(quietly) Yes, lump/swelling. {context}", "(reluctantly) {context}. lump/swelling.", "(pause) lump/swelling \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has lump/swelling. {onset}", "Doctor, lump/swelling \u2014 {onset}. {severity}", "We noticed lump/swelling. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "lump/swelling \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 lump/swelling. {context} {onset} {severity}", "{context}. {severity}", "Doctor, lump/swelling \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: BOWEL HABIT ────────────────────────────────
  surg_bowel_habit: {
    cooperative:             ["Yes \u2014 change in bowel habit. {context} {severity}", "{context}. {onset}", "I have had change in bowel habit. {context} {onset}", "Yes, change in bowel habit since {onset}. {severity}", "change in bowel habit for {onset}. {context}", "I noticed change in bowel habit. {context} {severity}", "{context}. {severity}", "change in bowel habit \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, change in bowel habit \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, change in bowel habit \u2014 {context}. {onset} I am scared.", "change in bowel habit since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "change in bowel habit \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "change in bowel habit \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "change in bowel habit \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "change in bowel habit \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["change in bowel habit. {onset}", "{context}. change in bowel habit.", "{onset}. change in bowel habit.", "{context}. {severity}", "change in bowel habit \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "change in bowel habit \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) change in bowel habit. {onset}", "(reluctantly) Yes \u2014 change in bowel habit. {context}", "(pause) change in bowel habit \u2014 {context}.", "(hesitating) {context}. change in bowel habit.", "(sighs) {context}. {onset}", "(looks away) change in bowel habit \u2014 {context}.", "(quietly) Yes, change in bowel habit. {context}", "(reluctantly) {context}. change in bowel habit.", "(pause) change in bowel habit \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has change in bowel habit. {onset}", "Doctor, change in bowel habit \u2014 {onset}. {severity}", "We noticed change in bowel habit. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "change in bowel habit \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 change in bowel habit. {context} {onset} {severity}", "{context}. {severity}", "Doctor, change in bowel habit \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: URINE OUTPUT ───────────────────────────────
  surg_urine_output: {
    cooperative:             ["Yes \u2014 urine output. {context} {severity}", "{context}. {onset}", "I have had urine output. {context} {onset}", "Yes, urine output since {onset}. {severity}", "urine output for {onset}. {context}", "I noticed urine output. {context} {severity}", "{context}. {severity}", "urine output \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, urine output \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, urine output \u2014 {context}. {onset} I am scared.", "urine output since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "urine output \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "urine output \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "urine output \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "urine output \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["urine output. {onset}", "{context}. urine output.", "{onset}. urine output.", "{context}. {severity}", "urine output \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "urine output \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) urine output. {onset}", "(reluctantly) Yes \u2014 urine output. {context}", "(pause) urine output \u2014 {context}.", "(hesitating) {context}. urine output.", "(sighs) {context}. {onset}", "(looks away) urine output \u2014 {context}.", "(quietly) Yes, urine output. {context}", "(reluctantly) {context}. urine output.", "(pause) urine output \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has urine output. {onset}", "Doctor, urine output \u2014 {onset}. {severity}", "We noticed urine output. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "urine output \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 urine output. {context} {onset} {severity}", "{context}. {severity}", "Doctor, urine output \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: PERITONISM ─────────────────────────────────
  surg_peritonism: {
    cooperative:             ["Yes \u2014 peritonism signs. {context} {severity}", "{context}. {onset}", "I have had peritonism signs. {context} {onset}", "Yes, peritonism signs since {onset}. {severity}", "peritonism signs for {onset}. {context}", "I noticed peritonism signs. {context} {severity}", "{context}. {severity}", "peritonism signs \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, peritonism signs \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, peritonism signs \u2014 {context}. {onset} I am scared.", "peritonism signs since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "peritonism signs \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "peritonism signs \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "peritonism signs \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "peritonism signs \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["peritonism signs. {onset}", "{context}. peritonism signs.", "{onset}. peritonism signs.", "{context}. {severity}", "peritonism signs \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "peritonism signs \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) peritonism signs. {onset}", "(reluctantly) Yes \u2014 peritonism signs. {context}", "(pause) peritonism signs \u2014 {context}.", "(hesitating) {context}. peritonism signs.", "(sighs) {context}. {onset}", "(looks away) peritonism signs \u2014 {context}.", "(quietly) Yes, peritonism signs. {context}", "(reluctantly) {context}. peritonism signs.", "(pause) peritonism signs \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has peritonism signs. {onset}", "Doctor, peritonism signs \u2014 {onset}. {severity}", "We noticed peritonism signs. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "peritonism signs \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 peritonism signs. {context} {onset} {severity}", "{context}. {severity}", "Doctor, peritonism signs \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: HERNIA ─────────────────────────────────────
  surg_hernia: {
    cooperative:             ["Yes \u2014 hernia. {context} {severity}", "{context}. {onset}", "I have had hernia. {context} {onset}", "Yes, hernia since {onset}. {severity}", "hernia for {onset}. {context}", "I noticed hernia. {context} {severity}", "{context}. {severity}", "hernia \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, hernia \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, hernia \u2014 {context}. {onset} I am scared.", "hernia since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "hernia \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "hernia \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "hernia \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "hernia \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["hernia. {onset}", "{context}. hernia.", "{onset}. hernia.", "{context}. {severity}", "hernia \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "hernia \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) hernia. {onset}", "(reluctantly) Yes \u2014 hernia. {context}", "(pause) hernia \u2014 {context}.", "(hesitating) {context}. hernia.", "(sighs) {context}. {onset}", "(looks away) hernia \u2014 {context}.", "(quietly) Yes, hernia. {context}", "(reluctantly) {context}. hernia.", "(pause) hernia \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has hernia. {onset}", "Doctor, hernia \u2014 {onset}. {severity}", "We noticed hernia. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "hernia \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 hernia. {context} {onset} {severity}", "{context}. {severity}", "Doctor, hernia \u2014 {context}. {onset} {severity}"],
  },
  // ── SURGERY: TRAUMA ─────────────────────────────────────
  surg_trauma: {
    cooperative:             ["Yes \u2014 trauma/mechanism of injury. {context} {severity}", "{context}. {onset}", "I have had trauma/mechanism of injury. {context} {onset}", "Yes, trauma/mechanism of injury since {onset}. {severity}", "trauma/mechanism of injury for {onset}. {context}", "I noticed trauma/mechanism of injury. {context} {severity}", "{context}. {severity}", "trauma/mechanism of injury \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, trauma/mechanism of injury \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, trauma/mechanism of injury \u2014 {context}. {onset} I am scared.", "trauma/mechanism of injury since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "trauma/mechanism of injury \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "trauma/mechanism of injury \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "trauma/mechanism of injury \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "trauma/mechanism of injury \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["trauma/mechanism of injury. {onset}", "{context}. trauma/mechanism of injury.", "{onset}. trauma/mechanism of injury.", "{context}. {severity}", "trauma/mechanism of injury \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "trauma/mechanism of injury \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) trauma/mechanism of injury. {onset}", "(reluctantly) Yes \u2014 trauma/mechanism of injury. {context}", "(pause) trauma/mechanism of injury \u2014 {context}.", "(hesitating) {context}. trauma/mechanism of injury.", "(sighs) {context}. {onset}", "(looks away) trauma/mechanism of injury \u2014 {context}.", "(quietly) Yes, trauma/mechanism of injury. {context}", "(reluctantly) {context}. trauma/mechanism of injury.", "(pause) trauma/mechanism of injury \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has trauma/mechanism of injury. {onset}", "Doctor, trauma/mechanism of injury \u2014 {onset}. {severity}", "We noticed trauma/mechanism of injury. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "trauma/mechanism of injury \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 trauma/mechanism of injury. {context} {onset} {severity}", "{context}. {severity}", "Doctor, trauma/mechanism of injury \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: PMH ────────────────────────────────────────
  pmh_general: {
    cooperative:             ["Yes \u2014 past medical history. {context} {severity}", "{context}. {onset}", "I have had past medical history. {context} {onset}", "Yes, past medical history since {onset}. {severity}", "past medical history for {onset}. {context}", "I noticed past medical history. {context} {severity}", "{context}. {severity}", "past medical history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, past medical history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, past medical history \u2014 {context}. {onset} I am scared.", "past medical history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "past medical history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "past medical history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "past medical history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "past medical history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["past medical history. {onset}", "{context}. past medical history.", "{onset}. past medical history.", "{context}. {severity}", "past medical history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "past medical history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) past medical history. {onset}", "(reluctantly) Yes \u2014 past medical history. {context}", "(pause) past medical history \u2014 {context}.", "(hesitating) {context}. past medical history.", "(sighs) {context}. {onset}", "(looks away) past medical history \u2014 {context}.", "(quietly) Yes, past medical history. {context}", "(reluctantly) {context}. past medical history.", "(pause) past medical history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has past medical history. {onset}", "Doctor, past medical history \u2014 {onset}. {severity}", "We noticed past medical history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "past medical history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 past medical history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, past medical history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: SURGICAL PMH ───────────────────────────────
  pmh_surgical: {
    cooperative:             ["Yes \u2014 surgical history. {context} {severity}", "{context}. {onset}", "I have had surgical history. {context} {onset}", "Yes, surgical history since {onset}. {severity}", "surgical history for {onset}. {context}", "I noticed surgical history. {context} {severity}", "{context}. {severity}", "surgical history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, surgical history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, surgical history \u2014 {context}. {onset} I am scared.", "surgical history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "surgical history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "surgical history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "surgical history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "surgical history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["surgical history. {onset}", "{context}. surgical history.", "{onset}. surgical history.", "{context}. {severity}", "surgical history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "surgical history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) surgical history. {onset}", "(reluctantly) Yes \u2014 surgical history. {context}", "(pause) surgical history \u2014 {context}.", "(hesitating) {context}. surgical history.", "(sighs) {context}. {onset}", "(looks away) surgical history \u2014 {context}.", "(quietly) Yes, surgical history. {context}", "(reluctantly) {context}. surgical history.", "(pause) surgical history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has surgical history. {onset}", "Doctor, surgical history \u2014 {onset}. {severity}", "We noticed surgical history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "surgical history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 surgical history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, surgical history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: PAEDS PMH ──────────────────────────────────
  pmh_paediatric: {
    cooperative:             ["Yes \u2014 birth/neonatal history. {context} {severity}", "{context}. {onset}", "I have had birth/neonatal history. {context} {onset}", "Yes, birth/neonatal history since {onset}. {severity}", "birth/neonatal history for {onset}. {context}", "I noticed birth/neonatal history. {context} {severity}", "{context}. {severity}", "birth/neonatal history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, birth/neonatal history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, birth/neonatal history \u2014 {context}. {onset} I am scared.", "birth/neonatal history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "birth/neonatal history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "birth/neonatal history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "birth/neonatal history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "birth/neonatal history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["birth/neonatal history. {onset}", "{context}. birth/neonatal history.", "{onset}. birth/neonatal history.", "{context}. {severity}", "birth/neonatal history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "birth/neonatal history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) birth/neonatal history. {onset}", "(reluctantly) Yes \u2014 birth/neonatal history. {context}", "(pause) birth/neonatal history \u2014 {context}.", "(hesitating) {context}. birth/neonatal history.", "(sighs) {context}. {onset}", "(looks away) birth/neonatal history \u2014 {context}.", "(quietly) Yes, birth/neonatal history. {context}", "(reluctantly) {context}. birth/neonatal history.", "(pause) birth/neonatal history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has birth/neonatal history. {onset}", "Doctor, birth/neonatal history \u2014 {onset}. {severity}", "We noticed birth/neonatal history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "birth/neonatal history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 birth/neonatal history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, birth/neonatal history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: MEDICATIONS ────────────────────────────────
  meds_general: {
    cooperative:             ["Yes \u2014 medications. {context} {severity}", "{context}. {onset}", "I have had medications. {context} {onset}", "Yes, medications since {onset}. {severity}", "medications for {onset}. {context}", "I noticed medications. {context} {severity}", "{context}. {severity}", "medications \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, medications \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, medications \u2014 {context}. {onset} I am scared.", "medications since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "medications \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "medications \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "medications \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "medications \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["medications. {onset}", "{context}. medications.", "{onset}. medications.", "{context}. {severity}", "medications \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "medications \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) medications. {onset}", "(reluctantly) Yes \u2014 medications. {context}", "(pause) medications \u2014 {context}.", "(hesitating) {context}. medications.", "(sighs) {context}. {onset}", "(looks away) medications \u2014 {context}.", "(quietly) Yes, medications. {context}", "(reluctantly) {context}. medications.", "(pause) medications \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has medications. {onset}", "Doctor, medications \u2014 {onset}. {severity}", "We noticed medications. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "medications \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 medications. {context} {onset} {severity}", "{context}. {severity}", "Doctor, medications \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: OTC DRUGS ──────────────────────────────────
  meds_otc: {
    cooperative:             ["Yes \u2014 OTC self-medication. {context} {severity}", "{context}. {onset}", "I have had OTC self-medication. {context} {onset}", "Yes, OTC self-medication since {onset}. {severity}", "OTC self-medication for {onset}. {context}", "I noticed OTC self-medication. {context} {severity}", "{context}. {severity}", "OTC self-medication \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, OTC self-medication \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, OTC self-medication \u2014 {context}. {onset} I am scared.", "OTC self-medication since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "OTC self-medication \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "OTC self-medication \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "OTC self-medication \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "OTC self-medication \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["OTC self-medication. {onset}", "{context}. OTC self-medication.", "{onset}. OTC self-medication.", "{context}. {severity}", "OTC self-medication \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "OTC self-medication \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) OTC self-medication. {onset}", "(reluctantly) Yes \u2014 OTC self-medication. {context}", "(pause) OTC self-medication \u2014 {context}.", "(hesitating) {context}. OTC self-medication.", "(sighs) {context}. {onset}", "(looks away) OTC self-medication \u2014 {context}.", "(quietly) Yes, OTC self-medication. {context}", "(reluctantly) {context}. OTC self-medication.", "(pause) OTC self-medication \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has OTC self-medication. {onset}", "Doctor, OTC self-medication \u2014 {onset}. {severity}", "We noticed OTC self-medication. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "OTC self-medication \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 OTC self-medication. {context} {onset} {severity}", "{context}. {severity}", "Doctor, OTC self-medication \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: HERBAL MEDICINE ────────────────────────────
  meds_herbal: {
    cooperative:             ["Yes \u2014 herbal/traditional medicine. {context} {severity}", "{context}. {onset}", "I have had herbal/traditional medicine. {context} {onset}", "Yes, herbal/traditional medicine since {onset}. {severity}", "herbal/traditional medicine for {onset}. {context}", "I noticed herbal/traditional medicine. {context} {severity}", "{context}. {severity}", "herbal/traditional medicine \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, herbal/traditional medicine \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, herbal/traditional medicine \u2014 {context}. {onset} I am scared.", "herbal/traditional medicine since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "herbal/traditional medicine \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "herbal/traditional medicine \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "herbal/traditional medicine \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "herbal/traditional medicine \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["herbal/traditional medicine. {onset}", "{context}. herbal/traditional medicine.", "{onset}. herbal/traditional medicine.", "{context}. {severity}", "herbal/traditional medicine \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "herbal/traditional medicine \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) herbal/traditional medicine. {onset}", "(reluctantly) Yes \u2014 herbal/traditional medicine. {context}", "(pause) herbal/traditional medicine \u2014 {context}.", "(hesitating) {context}. herbal/traditional medicine.", "(sighs) {context}. {onset}", "(looks away) herbal/traditional medicine \u2014 {context}.", "(quietly) Yes, herbal/traditional medicine. {context}", "(reluctantly) {context}. herbal/traditional medicine.", "(pause) herbal/traditional medicine \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has herbal/traditional medicine. {onset}", "Doctor, herbal/traditional medicine \u2014 {onset}. {severity}", "We noticed herbal/traditional medicine. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "herbal/traditional medicine \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 herbal/traditional medicine. {context} {onset} {severity}", "{context}. {severity}", "Doctor, herbal/traditional medicine \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: ALLERGIES ──────────────────────────────────
  allergies_general: {
    cooperative:             ["Yes \u2014 allergies. {context} {severity}", "{context}. {onset}", "I have had allergies. {context} {onset}", "Yes, allergies since {onset}. {severity}", "allergies for {onset}. {context}", "I noticed allergies. {context} {severity}", "{context}. {severity}", "allergies \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, allergies \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, allergies \u2014 {context}. {onset} I am scared.", "allergies since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "allergies \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "allergies \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "allergies \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "allergies \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["allergies. {onset}", "{context}. allergies.", "{onset}. allergies.", "{context}. {severity}", "allergies \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "allergies \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) allergies. {onset}", "(reluctantly) Yes \u2014 allergies. {context}", "(pause) allergies \u2014 {context}.", "(hesitating) {context}. allergies.", "(sighs) {context}. {onset}", "(looks away) allergies \u2014 {context}.", "(quietly) Yes, allergies. {context}", "(reluctantly) {context}. allergies.", "(pause) allergies \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has allergies. {onset}", "Doctor, allergies \u2014 {onset}. {severity}", "We noticed allergies. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "allergies \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 allergies. {context} {onset} {severity}", "{context}. {severity}", "Doctor, allergies \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: FAMILY HISTORY ─────────────────────────────
  fhx_general: {
    cooperative:             ["Yes \u2014 family history. {context} {severity}", "{context}. {onset}", "I have had family history. {context} {onset}", "Yes, family history since {onset}. {severity}", "family history for {onset}. {context}", "I noticed family history. {context} {severity}", "{context}. {severity}", "family history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, family history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, family history \u2014 {context}. {onset} I am scared.", "family history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "family history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "family history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "family history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "family history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["family history. {onset}", "{context}. family history.", "{onset}. family history.", "{context}. {severity}", "family history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "family history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) family history. {onset}", "(reluctantly) Yes \u2014 family history. {context}", "(pause) family history \u2014 {context}.", "(hesitating) {context}. family history.", "(sighs) {context}. {onset}", "(looks away) family history \u2014 {context}.", "(quietly) Yes, family history. {context}", "(reluctantly) {context}. family history.", "(pause) family history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has family history. {onset}", "Doctor, family history \u2014 {onset}. {severity}", "We noticed family history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "family history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 family history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, family history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: FHx CARDIAC ────────────────────────────────
  fhx_cardiovascular: {
    cooperative:             ["Yes \u2014 cardiac family history. {context} {severity}", "{context}. {onset}", "I have had cardiac family history. {context} {onset}", "Yes, cardiac family history since {onset}. {severity}", "cardiac family history for {onset}. {context}", "I noticed cardiac family history. {context} {severity}", "{context}. {severity}", "cardiac family history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, cardiac family history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, cardiac family history \u2014 {context}. {onset} I am scared.", "cardiac family history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "cardiac family history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "cardiac family history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "cardiac family history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "cardiac family history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["cardiac family history. {onset}", "{context}. cardiac family history.", "{onset}. cardiac family history.", "{context}. {severity}", "cardiac family history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "cardiac family history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) cardiac family history. {onset}", "(reluctantly) Yes \u2014 cardiac family history. {context}", "(pause) cardiac family history \u2014 {context}.", "(hesitating) {context}. cardiac family history.", "(sighs) {context}. {onset}", "(looks away) cardiac family history \u2014 {context}.", "(quietly) Yes, cardiac family history. {context}", "(reluctantly) {context}. cardiac family history.", "(pause) cardiac family history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has cardiac family history. {onset}", "Doctor, cardiac family history \u2014 {onset}. {severity}", "We noticed cardiac family history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "cardiac family history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 cardiac family history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, cardiac family history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: FHx MALIGNANCY ─────────────────────────────
  fhx_malignancy: {
    cooperative:             ["Yes \u2014 cancer family history. {context} {severity}", "{context}. {onset}", "I have had cancer family history. {context} {onset}", "Yes, cancer family history since {onset}. {severity}", "cancer family history for {onset}. {context}", "I noticed cancer family history. {context} {severity}", "{context}. {severity}", "cancer family history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, cancer family history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, cancer family history \u2014 {context}. {onset} I am scared.", "cancer family history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "cancer family history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "cancer family history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "cancer family history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "cancer family history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["cancer family history. {onset}", "{context}. cancer family history.", "{onset}. cancer family history.", "{context}. {severity}", "cancer family history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "cancer family history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) cancer family history. {onset}", "(reluctantly) Yes \u2014 cancer family history. {context}", "(pause) cancer family history \u2014 {context}.", "(hesitating) {context}. cancer family history.", "(sighs) {context}. {onset}", "(looks away) cancer family history \u2014 {context}.", "(quietly) Yes, cancer family history. {context}", "(reluctantly) {context}. cancer family history.", "(pause) cancer family history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has cancer family history. {onset}", "Doctor, cancer family history \u2014 {onset}. {severity}", "We noticed cancer family history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "cancer family history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 cancer family history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, cancer family history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: FHx ENDOCRINE ──────────────────────────────
  fhx_endocrine: {
    cooperative:             ["Yes \u2014 endocrine family history. {context} {severity}", "{context}. {onset}", "I have had endocrine family history. {context} {onset}", "Yes, endocrine family history since {onset}. {severity}", "endocrine family history for {onset}. {context}", "I noticed endocrine family history. {context} {severity}", "{context}. {severity}", "endocrine family history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, endocrine family history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, endocrine family history \u2014 {context}. {onset} I am scared.", "endocrine family history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "endocrine family history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "endocrine family history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "endocrine family history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "endocrine family history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["endocrine family history. {onset}", "{context}. endocrine family history.", "{onset}. endocrine family history.", "{context}. {severity}", "endocrine family history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "endocrine family history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) endocrine family history. {onset}", "(reluctantly) Yes \u2014 endocrine family history. {context}", "(pause) endocrine family history \u2014 {context}.", "(hesitating) {context}. endocrine family history.", "(sighs) {context}. {onset}", "(looks away) endocrine family history \u2014 {context}.", "(quietly) Yes, endocrine family history. {context}", "(reluctantly) {context}. endocrine family history.", "(pause) endocrine family history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has endocrine family history. {onset}", "Doctor, endocrine family history \u2014 {onset}. {severity}", "We noticed endocrine family history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "endocrine family history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 endocrine family history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, endocrine family history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: SOCIAL ─────────────────────────────────────
  shx_general: {
    cooperative:             ["Yes \u2014 social history. {context} {severity}", "{context}. {onset}", "I have had social history. {context} {onset}", "Yes, social history since {onset}. {severity}", "social history for {onset}. {context}", "I noticed social history. {context} {severity}", "{context}. {severity}", "social history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, social history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, social history \u2014 {context}. {onset} I am scared.", "social history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "social history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "social history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "social history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "social history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["social history. {onset}", "{context}. social history.", "{onset}. social history.", "{context}. {severity}", "social history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "social history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) social history. {onset}", "(reluctantly) Yes \u2014 social history. {context}", "(pause) social history \u2014 {context}.", "(hesitating) {context}. social history.", "(sighs) {context}. {onset}", "(looks away) social history \u2014 {context}.", "(quietly) Yes, social history. {context}", "(reluctantly) {context}. social history.", "(pause) social history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has social history. {onset}", "Doctor, social history \u2014 {onset}. {severity}", "We noticed social history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "social history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 social history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, social history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: OCCUPATION ─────────────────────────────────
  shx_occupation: {
    cooperative:             ["Yes \u2014 occupation. {context} {severity}", "{context}. {onset}", "I have had occupation. {context} {onset}", "Yes, occupation since {onset}. {severity}", "occupation for {onset}. {context}", "I noticed occupation. {context} {severity}", "{context}. {severity}", "occupation \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, occupation \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, occupation \u2014 {context}. {onset} I am scared.", "occupation since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "occupation \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "occupation \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "occupation \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "occupation \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["occupation. {onset}", "{context}. occupation.", "{onset}. occupation.", "{context}. {severity}", "occupation \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "occupation \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) occupation. {onset}", "(reluctantly) Yes \u2014 occupation. {context}", "(pause) occupation \u2014 {context}.", "(hesitating) {context}. occupation.", "(sighs) {context}. {onset}", "(looks away) occupation \u2014 {context}.", "(quietly) Yes, occupation. {context}", "(reluctantly) {context}. occupation.", "(pause) occupation \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has occupation. {onset}", "Doctor, occupation \u2014 {onset}. {severity}", "We noticed occupation. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "occupation \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 occupation. {context} {onset} {severity}", "{context}. {severity}", "Doctor, occupation \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: SMOKING ────────────────────────────────────
  shx_smoking: {
    cooperative:             ["Yes \u2014 smoking history. {context} {severity}", "{context}. {onset}", "I have had smoking history. {context} {onset}", "Yes, smoking history since {onset}. {severity}", "smoking history for {onset}. {context}", "I noticed smoking history. {context} {severity}", "{context}. {severity}", "smoking history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, smoking history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, smoking history \u2014 {context}. {onset} I am scared.", "smoking history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "smoking history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "smoking history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "smoking history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "smoking history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["smoking history. {onset}", "{context}. smoking history.", "{onset}. smoking history.", "{context}. {severity}", "smoking history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "smoking history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) smoking history. {onset}", "(reluctantly) Yes \u2014 smoking history. {context}", "(pause) smoking history \u2014 {context}.", "(hesitating) {context}. smoking history.", "(sighs) {context}. {onset}", "(looks away) smoking history \u2014 {context}.", "(quietly) Yes, smoking history. {context}", "(reluctantly) {context}. smoking history.", "(pause) smoking history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has smoking history. {onset}", "Doctor, smoking history \u2014 {onset}. {severity}", "We noticed smoking history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "smoking history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 smoking history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, smoking history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: ALCOHOL ────────────────────────────────────
  shx_alcohol: {
    cooperative:             ["Yes \u2014 alcohol history. {context} {severity}", "{context}. {onset}", "I have had alcohol history. {context} {onset}", "Yes, alcohol history since {onset}. {severity}", "alcohol history for {onset}. {context}", "I noticed alcohol history. {context} {severity}", "{context}. {severity}", "alcohol history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, alcohol history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, alcohol history \u2014 {context}. {onset} I am scared.", "alcohol history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "alcohol history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "alcohol history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "alcohol history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "alcohol history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["alcohol history. {onset}", "{context}. alcohol history.", "{onset}. alcohol history.", "{context}. {severity}", "alcohol history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "alcohol history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) alcohol history. {onset}", "(reluctantly) Yes \u2014 alcohol history. {context}", "(pause) alcohol history \u2014 {context}.", "(hesitating) {context}. alcohol history.", "(sighs) {context}. {onset}", "(looks away) alcohol history \u2014 {context}.", "(quietly) Yes, alcohol history. {context}", "(reluctantly) {context}. alcohol history.", "(pause) alcohol history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has alcohol history. {onset}", "Doctor, alcohol history \u2014 {onset}. {severity}", "We noticed alcohol history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "alcohol history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 alcohol history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, alcohol history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: DRUGS ──────────────────────────────────────
  shx_drugs: {
    cooperative:             ["Yes \u2014 recreational drug use. {context} {severity}", "{context}. {onset}", "I have had recreational drug use. {context} {onset}", "Yes, recreational drug use since {onset}. {severity}", "recreational drug use for {onset}. {context}", "I noticed recreational drug use. {context} {severity}", "{context}. {severity}", "recreational drug use \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, recreational drug use \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, recreational drug use \u2014 {context}. {onset} I am scared.", "recreational drug use since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "recreational drug use \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "recreational drug use \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "recreational drug use \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "recreational drug use \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["recreational drug use. {onset}", "{context}. recreational drug use.", "{onset}. recreational drug use.", "{context}. {severity}", "recreational drug use \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "recreational drug use \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) recreational drug use. {onset}", "(reluctantly) Yes \u2014 recreational drug use. {context}", "(pause) recreational drug use \u2014 {context}.", "(hesitating) {context}. recreational drug use.", "(sighs) {context}. {onset}", "(looks away) recreational drug use \u2014 {context}.", "(quietly) Yes, recreational drug use. {context}", "(reluctantly) {context}. recreational drug use.", "(pause) recreational drug use \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has recreational drug use. {onset}", "Doctor, recreational drug use \u2014 {onset}. {severity}", "We noticed recreational drug use. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "recreational drug use \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 recreational drug use. {context} {onset} {severity}", "{context}. {severity}", "Doctor, recreational drug use \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: TRAVEL ─────────────────────────────────────
  shx_travel: {
    cooperative:             ["Yes \u2014 travel history. {context} {severity}", "{context}. {onset}", "I have had travel history. {context} {onset}", "Yes, travel history since {onset}. {severity}", "travel history for {onset}. {context}", "I noticed travel history. {context} {severity}", "{context}. {severity}", "travel history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, travel history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, travel history \u2014 {context}. {onset} I am scared.", "travel history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "travel history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "travel history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "travel history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "travel history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["travel history. {onset}", "{context}. travel history.", "{onset}. travel history.", "{context}. {severity}", "travel history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "travel history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) travel history. {onset}", "(reluctantly) Yes \u2014 travel history. {context}", "(pause) travel history \u2014 {context}.", "(hesitating) {context}. travel history.", "(sighs) {context}. {onset}", "(looks away) travel history \u2014 {context}.", "(quietly) Yes, travel history. {context}", "(reluctantly) {context}. travel history.", "(pause) travel history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has travel history. {onset}", "Doctor, travel history \u2014 {onset}. {severity}", "We noticed travel history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "travel history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 travel history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, travel history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: SEXUAL ─────────────────────────────────────
  shx_sexual: {
    cooperative:             ["Yes \u2014 sexual history. {context} {severity}", "{context}. {onset}", "I have had sexual history. {context} {onset}", "Yes, sexual history since {onset}. {severity}", "sexual history for {onset}. {context}", "I noticed sexual history. {context} {severity}", "{context}. {severity}", "sexual history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, sexual history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, sexual history \u2014 {context}. {onset} I am scared.", "sexual history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "sexual history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "sexual history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "sexual history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "sexual history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["sexual history. {onset}", "{context}. sexual history.", "{onset}. sexual history.", "{context}. {severity}", "sexual history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "sexual history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) sexual history. {onset}", "(reluctantly) Yes \u2014 sexual history. {context}", "(pause) sexual history \u2014 {context}.", "(hesitating) {context}. sexual history.", "(sighs) {context}. {onset}", "(looks away) sexual history \u2014 {context}.", "(quietly) Yes, sexual history. {context}", "(reluctantly) {context}. sexual history.", "(pause) sexual history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has sexual history. {onset}", "Doctor, sexual history \u2014 {onset}. {severity}", "We noticed sexual history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "sexual history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 sexual history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, sexual history \u2014 {context}. {onset} {severity}"],
  },
  // ── HISTORY: DIET ───────────────────────────────────────
  shx_diet: {
    cooperative:             ["Yes \u2014 dietary history. {context} {severity}", "{context}. {onset}", "I have had dietary history. {context} {onset}", "Yes, dietary history since {onset}. {severity}", "dietary history for {onset}. {context}", "I noticed dietary history. {context} {severity}", "{context}. {severity}", "dietary history \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, dietary history \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, dietary history \u2014 {context}. {onset} I am scared.", "dietary history since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "dietary history \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "dietary history \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "dietary history \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "dietary history \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["dietary history. {onset}", "{context}. dietary history.", "{onset}. dietary history.", "{context}. {severity}", "dietary history \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "dietary history \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) dietary history. {onset}", "(reluctantly) Yes \u2014 dietary history. {context}", "(pause) dietary history \u2014 {context}.", "(hesitating) {context}. dietary history.", "(sighs) {context}. {onset}", "(looks away) dietary history \u2014 {context}.", "(quietly) Yes, dietary history. {context}", "(reluctantly) {context}. dietary history.", "(pause) dietary history \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has dietary history. {onset}", "Doctor, dietary history \u2014 {onset}. {severity}", "We noticed dietary history. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "dietary history \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 dietary history. {context} {onset} {severity}", "{context}. {severity}", "Doctor, dietary history \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: GENERAL ───────────────────────────────────────
  exam_general: {
    cooperative:             ["Yes \u2014 general examination. {context} {severity}", "{context}. {onset}", "I have had general examination. {context} {onset}", "Yes, general examination since {onset}. {severity}", "general examination for {onset}. {context}", "I noticed general examination. {context} {severity}", "{context}. {severity}", "general examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, general examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, general examination \u2014 {context}. {onset} I am scared.", "general examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "general examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "general examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "general examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "general examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["general examination. {onset}", "{context}. general examination.", "{onset}. general examination.", "{context}. {severity}", "general examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "general examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) general examination. {onset}", "(reluctantly) Yes \u2014 general examination. {context}", "(pause) general examination \u2014 {context}.", "(hesitating) {context}. general examination.", "(sighs) {context}. {onset}", "(looks away) general examination \u2014 {context}.", "(quietly) Yes, general examination. {context}", "(reluctantly) {context}. general examination.", "(pause) general examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has general examination. {onset}", "Doctor, general examination \u2014 {onset}. {severity}", "We noticed general examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "general examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 general examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, general examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: CARDIOVASCULAR ────────────────────────────────
  exam_cardiovascular: {
    cooperative:             ["Yes \u2014 CVS examination. {context} {severity}", "{context}. {onset}", "I have had CVS examination. {context} {onset}", "Yes, CVS examination since {onset}. {severity}", "CVS examination for {onset}. {context}", "I noticed CVS examination. {context} {severity}", "{context}. {severity}", "CVS examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, CVS examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, CVS examination \u2014 {context}. {onset} I am scared.", "CVS examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "CVS examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "CVS examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "CVS examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "CVS examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["CVS examination. {onset}", "{context}. CVS examination.", "{onset}. CVS examination.", "{context}. {severity}", "CVS examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "CVS examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) CVS examination. {onset}", "(reluctantly) Yes \u2014 CVS examination. {context}", "(pause) CVS examination \u2014 {context}.", "(hesitating) {context}. CVS examination.", "(sighs) {context}. {onset}", "(looks away) CVS examination \u2014 {context}.", "(quietly) Yes, CVS examination. {context}", "(reluctantly) {context}. CVS examination.", "(pause) CVS examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has CVS examination. {onset}", "Doctor, CVS examination \u2014 {onset}. {severity}", "We noticed CVS examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "CVS examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 CVS examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, CVS examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: CHEST ─────────────────────────────────────────
  exam_chest: {
    cooperative:             ["Yes \u2014 chest/respiratory examination. {context} {severity}", "{context}. {onset}", "I have had chest/respiratory examination. {context} {onset}", "Yes, chest/respiratory examination since {onset}. {severity}", "chest/respiratory examination for {onset}. {context}", "I noticed chest/respiratory examination. {context} {severity}", "{context}. {severity}", "chest/respiratory examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, chest/respiratory examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, chest/respiratory examination \u2014 {context}. {onset} I am scared.", "chest/respiratory examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "chest/respiratory examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "chest/respiratory examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "chest/respiratory examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "chest/respiratory examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["chest/respiratory examination. {onset}", "{context}. chest/respiratory examination.", "{onset}. chest/respiratory examination.", "{context}. {severity}", "chest/respiratory examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "chest/respiratory examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) chest/respiratory examination. {onset}", "(reluctantly) Yes \u2014 chest/respiratory examination. {context}", "(pause) chest/respiratory examination \u2014 {context}.", "(hesitating) {context}. chest/respiratory examination.", "(sighs) {context}. {onset}", "(looks away) chest/respiratory examination \u2014 {context}.", "(quietly) Yes, chest/respiratory examination. {context}", "(reluctantly) {context}. chest/respiratory examination.", "(pause) chest/respiratory examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has chest/respiratory examination. {onset}", "Doctor, chest/respiratory examination \u2014 {onset}. {severity}", "We noticed chest/respiratory examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "chest/respiratory examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 chest/respiratory examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, chest/respiratory examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: ABDOMEN ───────────────────────────────────────
  exam_abdomen: {
    cooperative:             ["Yes \u2014 abdominal examination. {context} {severity}", "{context}. {onset}", "I have had abdominal examination. {context} {onset}", "Yes, abdominal examination since {onset}. {severity}", "abdominal examination for {onset}. {context}", "I noticed abdominal examination. {context} {severity}", "{context}. {severity}", "abdominal examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, abdominal examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, abdominal examination \u2014 {context}. {onset} I am scared.", "abdominal examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "abdominal examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "abdominal examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "abdominal examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "abdominal examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["abdominal examination. {onset}", "{context}. abdominal examination.", "{onset}. abdominal examination.", "{context}. {severity}", "abdominal examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "abdominal examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) abdominal examination. {onset}", "(reluctantly) Yes \u2014 abdominal examination. {context}", "(pause) abdominal examination \u2014 {context}.", "(hesitating) {context}. abdominal examination.", "(sighs) {context}. {onset}", "(looks away) abdominal examination \u2014 {context}.", "(quietly) Yes, abdominal examination. {context}", "(reluctantly) {context}. abdominal examination.", "(pause) abdominal examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has abdominal examination. {onset}", "Doctor, abdominal examination \u2014 {onset}. {severity}", "We noticed abdominal examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "abdominal examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 abdominal examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, abdominal examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: NEUROLOGICAL ──────────────────────────────────
  exam_neuro: {
    cooperative:             ["Yes \u2014 neurological examination. {context} {severity}", "{context}. {onset}", "I have had neurological examination. {context} {onset}", "Yes, neurological examination since {onset}. {severity}", "neurological examination for {onset}. {context}", "I noticed neurological examination. {context} {severity}", "{context}. {severity}", "neurological examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, neurological examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, neurological examination \u2014 {context}. {onset} I am scared.", "neurological examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "neurological examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "neurological examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "neurological examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "neurological examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["neurological examination. {onset}", "{context}. neurological examination.", "{onset}. neurological examination.", "{context}. {severity}", "neurological examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "neurological examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) neurological examination. {onset}", "(reluctantly) Yes \u2014 neurological examination. {context}", "(pause) neurological examination \u2014 {context}.", "(hesitating) {context}. neurological examination.", "(sighs) {context}. {onset}", "(looks away) neurological examination \u2014 {context}.", "(quietly) Yes, neurological examination. {context}", "(reluctantly) {context}. neurological examination.", "(pause) neurological examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has neurological examination. {onset}", "Doctor, neurological examination \u2014 {onset}. {severity}", "We noticed neurological examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "neurological examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 neurological examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, neurological examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: SKIN ──────────────────────────────────────────
  exam_skin: {
    cooperative:             ["Yes \u2014 skin/dermatological examination. {context} {severity}", "{context}. {onset}", "I have had skin/dermatological examination. {context} {onset}", "Yes, skin/dermatological examination since {onset}. {severity}", "skin/dermatological examination for {onset}. {context}", "I noticed skin/dermatological examination. {context} {severity}", "{context}. {severity}", "skin/dermatological examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, skin/dermatological examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, skin/dermatological examination \u2014 {context}. {onset} I am scared.", "skin/dermatological examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "skin/dermatological examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "skin/dermatological examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "skin/dermatological examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "skin/dermatological examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["skin/dermatological examination. {onset}", "{context}. skin/dermatological examination.", "{onset}. skin/dermatological examination.", "{context}. {severity}", "skin/dermatological examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "skin/dermatological examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) skin/dermatological examination. {onset}", "(reluctantly) Yes \u2014 skin/dermatological examination. {context}", "(pause) skin/dermatological examination \u2014 {context}.", "(hesitating) {context}. skin/dermatological examination.", "(sighs) {context}. {onset}", "(looks away) skin/dermatological examination \u2014 {context}.", "(quietly) Yes, skin/dermatological examination. {context}", "(reluctantly) {context}. skin/dermatological examination.", "(pause) skin/dermatological examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has skin/dermatological examination. {onset}", "Doctor, skin/dermatological examination \u2014 {onset}. {severity}", "We noticed skin/dermatological examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "skin/dermatological examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 skin/dermatological examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, skin/dermatological examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: SPECIFIC SIGNS ────────────────────────────────
  exam_specific_signs: {
    cooperative:             ["Yes \u2014 specific clinical signs. {context} {severity}", "{context}. {onset}", "I have had specific clinical signs. {context} {onset}", "Yes, specific clinical signs since {onset}. {severity}", "specific clinical signs for {onset}. {context}", "I noticed specific clinical signs. {context} {severity}", "{context}. {severity}", "specific clinical signs \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, specific clinical signs \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, specific clinical signs \u2014 {context}. {onset} I am scared.", "specific clinical signs since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "specific clinical signs \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "specific clinical signs \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "specific clinical signs \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "specific clinical signs \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["specific clinical signs. {onset}", "{context}. specific clinical signs.", "{onset}. specific clinical signs.", "{context}. {severity}", "specific clinical signs \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "specific clinical signs \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) specific clinical signs. {onset}", "(reluctantly) Yes \u2014 specific clinical signs. {context}", "(pause) specific clinical signs \u2014 {context}.", "(hesitating) {context}. specific clinical signs.", "(sighs) {context}. {onset}", "(looks away) specific clinical signs \u2014 {context}.", "(quietly) Yes, specific clinical signs. {context}", "(reluctantly) {context}. specific clinical signs.", "(pause) specific clinical signs \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has specific clinical signs. {onset}", "Doctor, specific clinical signs \u2014 {onset}. {severity}", "We noticed specific clinical signs. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "specific clinical signs \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 specific clinical signs. {context} {onset} {severity}", "{context}. {severity}", "Doctor, specific clinical signs \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: MSK ───────────────────────────────────────────
  exam_musculoskeletal: {
    cooperative:             ["Yes \u2014 MSK examination. {context} {severity}", "{context}. {onset}", "I have had MSK examination. {context} {onset}", "Yes, MSK examination since {onset}. {severity}", "MSK examination for {onset}. {context}", "I noticed MSK examination. {context} {severity}", "{context}. {severity}", "MSK examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, MSK examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, MSK examination \u2014 {context}. {onset} I am scared.", "MSK examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "MSK examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "MSK examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "MSK examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "MSK examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["MSK examination. {onset}", "{context}. MSK examination.", "{onset}. MSK examination.", "{context}. {severity}", "MSK examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "MSK examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) MSK examination. {onset}", "(reluctantly) Yes \u2014 MSK examination. {context}", "(pause) MSK examination \u2014 {context}.", "(hesitating) {context}. MSK examination.", "(sighs) {context}. {onset}", "(looks away) MSK examination \u2014 {context}.", "(quietly) Yes, MSK examination. {context}", "(reluctantly) {context}. MSK examination.", "(pause) MSK examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has MSK examination. {onset}", "Doctor, MSK examination \u2014 {onset}. {severity}", "We noticed MSK examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "MSK examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 MSK examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, MSK examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: THYROID ───────────────────────────────────────
  exam_thyroid: {
    cooperative:             ["Yes \u2014 thyroid/neck examination. {context} {severity}", "{context}. {onset}", "I have had thyroid/neck examination. {context} {onset}", "Yes, thyroid/neck examination since {onset}. {severity}", "thyroid/neck examination for {onset}. {context}", "I noticed thyroid/neck examination. {context} {severity}", "{context}. {severity}", "thyroid/neck examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, thyroid/neck examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, thyroid/neck examination \u2014 {context}. {onset} I am scared.", "thyroid/neck examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "thyroid/neck examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "thyroid/neck examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "thyroid/neck examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "thyroid/neck examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["thyroid/neck examination. {onset}", "{context}. thyroid/neck examination.", "{onset}. thyroid/neck examination.", "{context}. {severity}", "thyroid/neck examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "thyroid/neck examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) thyroid/neck examination. {onset}", "(reluctantly) Yes \u2014 thyroid/neck examination. {context}", "(pause) thyroid/neck examination \u2014 {context}.", "(hesitating) {context}. thyroid/neck examination.", "(sighs) {context}. {onset}", "(looks away) thyroid/neck examination \u2014 {context}.", "(quietly) Yes, thyroid/neck examination. {context}", "(reluctantly) {context}. thyroid/neck examination.", "(pause) thyroid/neck examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has thyroid/neck examination. {onset}", "Doctor, thyroid/neck examination \u2014 {onset}. {severity}", "We noticed thyroid/neck examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "thyroid/neck examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 thyroid/neck examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, thyroid/neck examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: LYMPH NODES ───────────────────────────────────
  exam_lymph_nodes: {
    cooperative:             ["Yes \u2014 lymph node examination. {context} {severity}", "{context}. {onset}", "I have had lymph node examination. {context} {onset}", "Yes, lymph node examination since {onset}. {severity}", "lymph node examination for {onset}. {context}", "I noticed lymph node examination. {context} {severity}", "{context}. {severity}", "lymph node examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, lymph node examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, lymph node examination \u2014 {context}. {onset} I am scared.", "lymph node examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "lymph node examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "lymph node examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "lymph node examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "lymph node examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["lymph node examination. {onset}", "{context}. lymph node examination.", "{onset}. lymph node examination.", "{context}. {severity}", "lymph node examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "lymph node examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) lymph node examination. {onset}", "(reluctantly) Yes \u2014 lymph node examination. {context}", "(pause) lymph node examination \u2014 {context}.", "(hesitating) {context}. lymph node examination.", "(sighs) {context}. {onset}", "(looks away) lymph node examination \u2014 {context}.", "(quietly) Yes, lymph node examination. {context}", "(reluctantly) {context}. lymph node examination.", "(pause) lymph node examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has lymph node examination. {onset}", "Doctor, lymph node examination \u2014 {onset}. {severity}", "We noticed lymph node examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "lymph node examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 lymph node examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, lymph node examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: BREAST ────────────────────────────────────────
  exam_breast: {
    cooperative:             ["Yes \u2014 breast examination. {context} {severity}", "{context}. {onset}", "I have had breast examination. {context} {onset}", "Yes, breast examination since {onset}. {severity}", "breast examination for {onset}. {context}", "I noticed breast examination. {context} {severity}", "{context}. {severity}", "breast examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, breast examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, breast examination \u2014 {context}. {onset} I am scared.", "breast examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "breast examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "breast examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "breast examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "breast examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["breast examination. {onset}", "{context}. breast examination.", "{onset}. breast examination.", "{context}. {severity}", "breast examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "breast examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) breast examination. {onset}", "(reluctantly) Yes \u2014 breast examination. {context}", "(pause) breast examination \u2014 {context}.", "(hesitating) {context}. breast examination.", "(sighs) {context}. {onset}", "(looks away) breast examination \u2014 {context}.", "(quietly) Yes, breast examination. {context}", "(reluctantly) {context}. breast examination.", "(pause) breast examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has breast examination. {onset}", "Doctor, breast examination \u2014 {onset}. {severity}", "We noticed breast examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "breast examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 breast examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, breast examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: RECTAL ────────────────────────────────────────
  exam_rectal: {
    cooperative:             ["Yes \u2014 rectal examination. {context} {severity}", "{context}. {onset}", "I have had rectal examination. {context} {onset}", "Yes, rectal examination since {onset}. {severity}", "rectal examination for {onset}. {context}", "I noticed rectal examination. {context} {severity}", "{context}. {severity}", "rectal examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, rectal examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, rectal examination \u2014 {context}. {onset} I am scared.", "rectal examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "rectal examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "rectal examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "rectal examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "rectal examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["rectal examination. {onset}", "{context}. rectal examination.", "{onset}. rectal examination.", "{context}. {severity}", "rectal examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "rectal examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) rectal examination. {onset}", "(reluctantly) Yes \u2014 rectal examination. {context}", "(pause) rectal examination \u2014 {context}.", "(hesitating) {context}. rectal examination.", "(sighs) {context}. {onset}", "(looks away) rectal examination \u2014 {context}.", "(quietly) Yes, rectal examination. {context}", "(reluctantly) {context}. rectal examination.", "(pause) rectal examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has rectal examination. {onset}", "Doctor, rectal examination \u2014 {onset}. {severity}", "We noticed rectal examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "rectal examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 rectal examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, rectal examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: PELVIC ────────────────────────────────────────
  exam_pelvic: {
    cooperative:             ["Yes \u2014 pelvic examination. {context} {severity}", "{context}. {onset}", "I have had pelvic examination. {context} {onset}", "Yes, pelvic examination since {onset}. {severity}", "pelvic examination for {onset}. {context}", "I noticed pelvic examination. {context} {severity}", "{context}. {severity}", "pelvic examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, pelvic examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, pelvic examination \u2014 {context}. {onset} I am scared.", "pelvic examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "pelvic examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "pelvic examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "pelvic examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "pelvic examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["pelvic examination. {onset}", "{context}. pelvic examination.", "{onset}. pelvic examination.", "{context}. {severity}", "pelvic examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "pelvic examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) pelvic examination. {onset}", "(reluctantly) Yes \u2014 pelvic examination. {context}", "(pause) pelvic examination \u2014 {context}.", "(hesitating) {context}. pelvic examination.", "(sighs) {context}. {onset}", "(looks away) pelvic examination \u2014 {context}.", "(quietly) Yes, pelvic examination. {context}", "(reluctantly) {context}. pelvic examination.", "(pause) pelvic examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has pelvic examination. {onset}", "Doctor, pelvic examination \u2014 {onset}. {severity}", "We noticed pelvic examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "pelvic examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 pelvic examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, pelvic examination \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: FUNDAL HEIGHT ─────────────────────────────────
  exam_fundal_height: {
    cooperative:             ["Yes \u2014 fundal height. {context} {severity}", "{context}. {onset}", "I have had fundal height. {context} {onset}", "Yes, fundal height since {onset}. {severity}", "fundal height for {onset}. {context}", "I noticed fundal height. {context} {severity}", "{context}. {severity}", "fundal height \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, fundal height \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, fundal height \u2014 {context}. {onset} I am scared.", "fundal height since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "fundal height \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "fundal height \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "fundal height \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "fundal height \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["fundal height. {onset}", "{context}. fundal height.", "{onset}. fundal height.", "{context}. {severity}", "fundal height \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "fundal height \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) fundal height. {onset}", "(reluctantly) Yes \u2014 fundal height. {context}", "(pause) fundal height \u2014 {context}.", "(hesitating) {context}. fundal height.", "(sighs) {context}. {onset}", "(looks away) fundal height \u2014 {context}.", "(quietly) Yes, fundal height. {context}", "(reluctantly) {context}. fundal height.", "(pause) fundal height \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has fundal height. {onset}", "Doctor, fundal height \u2014 {onset}. {severity}", "We noticed fundal height. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "fundal height \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 fundal height. {context} {onset} {severity}", "{context}. {severity}", "Doctor, fundal height \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: FETAL PRESENTATION ────────────────────────────
  exam_fetal_presentation: {
    cooperative:             ["Yes \u2014 fetal presentation. {context} {severity}", "{context}. {onset}", "I have had fetal presentation. {context} {onset}", "Yes, fetal presentation since {onset}. {severity}", "fetal presentation for {onset}. {context}", "I noticed fetal presentation. {context} {severity}", "{context}. {severity}", "fetal presentation \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, fetal presentation \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, fetal presentation \u2014 {context}. {onset} I am scared.", "fetal presentation since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "fetal presentation \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "fetal presentation \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "fetal presentation \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "fetal presentation \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["fetal presentation. {onset}", "{context}. fetal presentation.", "{onset}. fetal presentation.", "{context}. {severity}", "fetal presentation \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "fetal presentation \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) fetal presentation. {onset}", "(reluctantly) Yes \u2014 fetal presentation. {context}", "(pause) fetal presentation \u2014 {context}.", "(hesitating) {context}. fetal presentation.", "(sighs) {context}. {onset}", "(looks away) fetal presentation \u2014 {context}.", "(quietly) Yes, fetal presentation. {context}", "(reluctantly) {context}. fetal presentation.", "(pause) fetal presentation \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has fetal presentation. {onset}", "Doctor, fetal presentation \u2014 {onset}. {severity}", "We noticed fetal presentation. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "fetal presentation \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 fetal presentation. {context} {onset} {severity}", "{context}. {severity}", "Doctor, fetal presentation \u2014 {context}. {onset} {severity}"],
  },
  // ── EXAM: NEWBORN ───────────────────────────────────────
  exam_newborn: {
    cooperative:             ["Yes \u2014 newborn examination. {context} {severity}", "{context}. {onset}", "I have had newborn examination. {context} {onset}", "Yes, newborn examination since {onset}. {severity}", "newborn examination for {onset}. {context}", "I noticed newborn examination. {context} {severity}", "{context}. {severity}", "newborn examination \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, newborn examination \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, newborn examination \u2014 {context}. {onset} I am scared.", "newborn examination since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "newborn examination \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "newborn examination \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "newborn examination \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "newborn examination \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["newborn examination. {onset}", "{context}. newborn examination.", "{onset}. newborn examination.", "{context}. {severity}", "newborn examination \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "newborn examination \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) newborn examination. {onset}", "(reluctantly) Yes \u2014 newborn examination. {context}", "(pause) newborn examination \u2014 {context}.", "(hesitating) {context}. newborn examination.", "(sighs) {context}. {onset}", "(looks away) newborn examination \u2014 {context}.", "(quietly) Yes, newborn examination. {context}", "(reluctantly) {context}. newborn examination.", "(pause) newborn examination \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has newborn examination. {onset}", "Doctor, newborn examination \u2014 {onset}. {severity}", "We noticed newborn examination. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "newborn examination \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 newborn examination. {context} {onset} {severity}", "{context}. {severity}", "Doctor, newborn examination \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: FBC ─────────────────────────────────────────────
  ix_fbc: {
    cooperative:             ["Yes \u2014 FBC result. {context} {severity}", "{context}. {onset}", "I have had FBC result. {context} {onset}", "Yes, FBC result since {onset}. {severity}", "FBC result for {onset}. {context}", "I noticed FBC result. {context} {severity}", "{context}. {severity}", "FBC result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, FBC result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, FBC result \u2014 {context}. {onset} I am scared.", "FBC result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "FBC result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "FBC result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "FBC result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "FBC result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["FBC result. {onset}", "{context}. FBC result.", "{onset}. FBC result.", "{context}. {severity}", "FBC result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "FBC result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) FBC result. {onset}", "(reluctantly) Yes \u2014 FBC result. {context}", "(pause) FBC result \u2014 {context}.", "(hesitating) {context}. FBC result.", "(sighs) {context}. {onset}", "(looks away) FBC result \u2014 {context}.", "(quietly) Yes, FBC result. {context}", "(reluctantly) {context}. FBC result.", "(pause) FBC result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has FBC result. {onset}", "Doctor, FBC result \u2014 {onset}. {severity}", "We noticed FBC result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "FBC result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 FBC result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, FBC result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: LFTs ────────────────────────────────────────────
  ix_lft: {
    cooperative:             ["Yes \u2014 LFT result. {context} {severity}", "{context}. {onset}", "I have had LFT result. {context} {onset}", "Yes, LFT result since {onset}. {severity}", "LFT result for {onset}. {context}", "I noticed LFT result. {context} {severity}", "{context}. {severity}", "LFT result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, LFT result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, LFT result \u2014 {context}. {onset} I am scared.", "LFT result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "LFT result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "LFT result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "LFT result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "LFT result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["LFT result. {onset}", "{context}. LFT result.", "{onset}. LFT result.", "{context}. {severity}", "LFT result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "LFT result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) LFT result. {onset}", "(reluctantly) Yes \u2014 LFT result. {context}", "(pause) LFT result \u2014 {context}.", "(hesitating) {context}. LFT result.", "(sighs) {context}. {onset}", "(looks away) LFT result \u2014 {context}.", "(quietly) Yes, LFT result. {context}", "(reluctantly) {context}. LFT result.", "(pause) LFT result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has LFT result. {onset}", "Doctor, LFT result \u2014 {onset}. {severity}", "We noticed LFT result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "LFT result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 LFT result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, LFT result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: CRP ─────────────────────────────────────────────
  ix_crp: {
    cooperative:             ["Yes \u2014 CRP/inflammatory markers. {context} {severity}", "{context}. {onset}", "I have had CRP/inflammatory markers. {context} {onset}", "Yes, CRP/inflammatory markers since {onset}. {severity}", "CRP/inflammatory markers for {onset}. {context}", "I noticed CRP/inflammatory markers. {context} {severity}", "{context}. {severity}", "CRP/inflammatory markers \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, CRP/inflammatory markers \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, CRP/inflammatory markers \u2014 {context}. {onset} I am scared.", "CRP/inflammatory markers since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "CRP/inflammatory markers \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "CRP/inflammatory markers \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "CRP/inflammatory markers \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "CRP/inflammatory markers \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["CRP/inflammatory markers. {onset}", "{context}. CRP/inflammatory markers.", "{onset}. CRP/inflammatory markers.", "{context}. {severity}", "CRP/inflammatory markers \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "CRP/inflammatory markers \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) CRP/inflammatory markers. {onset}", "(reluctantly) Yes \u2014 CRP/inflammatory markers. {context}", "(pause) CRP/inflammatory markers \u2014 {context}.", "(hesitating) {context}. CRP/inflammatory markers.", "(sighs) {context}. {onset}", "(looks away) CRP/inflammatory markers \u2014 {context}.", "(quietly) Yes, CRP/inflammatory markers. {context}", "(reluctantly) {context}. CRP/inflammatory markers.", "(pause) CRP/inflammatory markers \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has CRP/inflammatory markers. {onset}", "Doctor, CRP/inflammatory markers \u2014 {onset}. {severity}", "We noticed CRP/inflammatory markers. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "CRP/inflammatory markers \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 CRP/inflammatory markers. {context} {onset} {severity}", "{context}. {severity}", "Doctor, CRP/inflammatory markers \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: URINALYSIS ──────────────────────────────────────
  ix_urinalysis: {
    cooperative:             ["Yes \u2014 urinalysis result. {context} {severity}", "{context}. {onset}", "I have had urinalysis result. {context} {onset}", "Yes, urinalysis result since {onset}. {severity}", "urinalysis result for {onset}. {context}", "I noticed urinalysis result. {context} {severity}", "{context}. {severity}", "urinalysis result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, urinalysis result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, urinalysis result \u2014 {context}. {onset} I am scared.", "urinalysis result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "urinalysis result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "urinalysis result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "urinalysis result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "urinalysis result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["urinalysis result. {onset}", "{context}. urinalysis result.", "{onset}. urinalysis result.", "{context}. {severity}", "urinalysis result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "urinalysis result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) urinalysis result. {onset}", "(reluctantly) Yes \u2014 urinalysis result. {context}", "(pause) urinalysis result \u2014 {context}.", "(hesitating) {context}. urinalysis result.", "(sighs) {context}. {onset}", "(looks away) urinalysis result \u2014 {context}.", "(quietly) Yes, urinalysis result. {context}", "(reluctantly) {context}. urinalysis result.", "(pause) urinalysis result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has urinalysis result. {onset}", "Doctor, urinalysis result \u2014 {onset}. {severity}", "We noticed urinalysis result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "urinalysis result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 urinalysis result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, urinalysis result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: ECG ─────────────────────────────────────────────
  ix_ecg: {
    cooperative:             ["Yes \u2014 ECG result. {context} {severity}", "{context}. {onset}", "I have had ECG result. {context} {onset}", "Yes, ECG result since {onset}. {severity}", "ECG result for {onset}. {context}", "I noticed ECG result. {context} {severity}", "{context}. {severity}", "ECG result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, ECG result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, ECG result \u2014 {context}. {onset} I am scared.", "ECG result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "ECG result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "ECG result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "ECG result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "ECG result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["ECG result. {onset}", "{context}. ECG result.", "{onset}. ECG result.", "{context}. {severity}", "ECG result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "ECG result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) ECG result. {onset}", "(reluctantly) Yes \u2014 ECG result. {context}", "(pause) ECG result \u2014 {context}.", "(hesitating) {context}. ECG result.", "(sighs) {context}. {onset}", "(looks away) ECG result \u2014 {context}.", "(quietly) Yes, ECG result. {context}", "(reluctantly) {context}. ECG result.", "(pause) ECG result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has ECG result. {onset}", "Doctor, ECG result \u2014 {onset}. {severity}", "We noticed ECG result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "ECG result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 ECG result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, ECG result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: CXR ─────────────────────────────────────────────
  ix_cxr: {
    cooperative:             ["Yes \u2014 chest X-ray result. {context} {severity}", "{context}. {onset}", "I have had chest X-ray result. {context} {onset}", "Yes, chest X-ray result since {onset}. {severity}", "chest X-ray result for {onset}. {context}", "I noticed chest X-ray result. {context} {severity}", "{context}. {severity}", "chest X-ray result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, chest X-ray result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, chest X-ray result \u2014 {context}. {onset} I am scared.", "chest X-ray result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "chest X-ray result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "chest X-ray result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "chest X-ray result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "chest X-ray result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["chest X-ray result. {onset}", "{context}. chest X-ray result.", "{onset}. chest X-ray result.", "{context}. {severity}", "chest X-ray result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "chest X-ray result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) chest X-ray result. {onset}", "(reluctantly) Yes \u2014 chest X-ray result. {context}", "(pause) chest X-ray result \u2014 {context}.", "(hesitating) {context}. chest X-ray result.", "(sighs) {context}. {onset}", "(looks away) chest X-ray result \u2014 {context}.", "(quietly) Yes, chest X-ray result. {context}", "(reluctantly) {context}. chest X-ray result.", "(pause) chest X-ray result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has chest X-ray result. {onset}", "Doctor, chest X-ray result \u2014 {onset}. {severity}", "We noticed chest X-ray result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "chest X-ray result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 chest X-ray result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, chest X-ray result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: ULTRASOUND ──────────────────────────────────────
  ix_ultrasound: {
    cooperative:             ["Yes \u2014 ultrasound result. {context} {severity}", "{context}. {onset}", "I have had ultrasound result. {context} {onset}", "Yes, ultrasound result since {onset}. {severity}", "ultrasound result for {onset}. {context}", "I noticed ultrasound result. {context} {severity}", "{context}. {severity}", "ultrasound result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, ultrasound result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, ultrasound result \u2014 {context}. {onset} I am scared.", "ultrasound result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "ultrasound result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "ultrasound result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "ultrasound result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "ultrasound result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["ultrasound result. {onset}", "{context}. ultrasound result.", "{onset}. ultrasound result.", "{context}. {severity}", "ultrasound result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "ultrasound result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) ultrasound result. {onset}", "(reluctantly) Yes \u2014 ultrasound result. {context}", "(pause) ultrasound result \u2014 {context}.", "(hesitating) {context}. ultrasound result.", "(sighs) {context}. {onset}", "(looks away) ultrasound result \u2014 {context}.", "(quietly) Yes, ultrasound result. {context}", "(reluctantly) {context}. ultrasound result.", "(pause) ultrasound result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has ultrasound result. {onset}", "Doctor, ultrasound result \u2014 {onset}. {severity}", "We noticed ultrasound result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "ultrasound result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 ultrasound result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, ultrasound result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: RDT ─────────────────────────────────────────────
  ix_rdt: {
    cooperative:             ["Yes \u2014 malaria RDT result. {context} {severity}", "{context}. {onset}", "I have had malaria RDT result. {context} {onset}", "Yes, malaria RDT result since {onset}. {severity}", "malaria RDT result for {onset}. {context}", "I noticed malaria RDT result. {context} {severity}", "{context}. {severity}", "malaria RDT result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, malaria RDT result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, malaria RDT result \u2014 {context}. {onset} I am scared.", "malaria RDT result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "malaria RDT result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "malaria RDT result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "malaria RDT result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "malaria RDT result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["malaria RDT result. {onset}", "{context}. malaria RDT result.", "{onset}. malaria RDT result.", "{context}. {severity}", "malaria RDT result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "malaria RDT result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) malaria RDT result. {onset}", "(reluctantly) Yes \u2014 malaria RDT result. {context}", "(pause) malaria RDT result \u2014 {context}.", "(hesitating) {context}. malaria RDT result.", "(sighs) {context}. {onset}", "(looks away) malaria RDT result \u2014 {context}.", "(quietly) Yes, malaria RDT result. {context}", "(reluctantly) {context}. malaria RDT result.", "(pause) malaria RDT result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has malaria RDT result. {onset}", "Doctor, malaria RDT result \u2014 {onset}. {severity}", "We noticed malaria RDT result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "malaria RDT result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 malaria RDT result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, malaria RDT result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: BLOOD FILM ──────────────────────────────────────
  ix_thickfilm: {
    cooperative:             ["Yes \u2014 blood film result. {context} {severity}", "{context}. {onset}", "I have had blood film result. {context} {onset}", "Yes, blood film result since {onset}. {severity}", "blood film result for {onset}. {context}", "I noticed blood film result. {context} {severity}", "{context}. {severity}", "blood film result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, blood film result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, blood film result \u2014 {context}. {onset} I am scared.", "blood film result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "blood film result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "blood film result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "blood film result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "blood film result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["blood film result. {onset}", "{context}. blood film result.", "{onset}. blood film result.", "{context}. {severity}", "blood film result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "blood film result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) blood film result. {onset}", "(reluctantly) Yes \u2014 blood film result. {context}", "(pause) blood film result \u2014 {context}.", "(hesitating) {context}. blood film result.", "(sighs) {context}. {onset}", "(looks away) blood film result \u2014 {context}.", "(quietly) Yes, blood film result. {context}", "(reluctantly) {context}. blood film result.", "(pause) blood film result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has blood film result. {onset}", "Doctor, blood film result \u2014 {onset}. {severity}", "We noticed blood film result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "blood film result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 blood film result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, blood film result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: PEFR ────────────────────────────────────────────
  ix_pefr: {
    cooperative:             ["Yes \u2014 peak flow result. {context} {severity}", "{context}. {onset}", "I have had peak flow result. {context} {onset}", "Yes, peak flow result since {onset}. {severity}", "peak flow result for {onset}. {context}", "I noticed peak flow result. {context} {severity}", "{context}. {severity}", "peak flow result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, peak flow result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, peak flow result \u2014 {context}. {onset} I am scared.", "peak flow result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "peak flow result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "peak flow result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "peak flow result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "peak flow result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["peak flow result. {onset}", "{context}. peak flow result.", "{onset}. peak flow result.", "{context}. {severity}", "peak flow result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "peak flow result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) peak flow result. {onset}", "(reluctantly) Yes \u2014 peak flow result. {context}", "(pause) peak flow result \u2014 {context}.", "(hesitating) {context}. peak flow result.", "(sighs) {context}. {onset}", "(looks away) peak flow result \u2014 {context}.", "(quietly) Yes, peak flow result. {context}", "(reluctantly) {context}. peak flow result.", "(pause) peak flow result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has peak flow result. {onset}", "Doctor, peak flow result \u2014 {onset}. {severity}", "We noticed peak flow result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "peak flow result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 peak flow result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, peak flow result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: ABG ─────────────────────────────────────────────
  ix_abg: {
    cooperative:             ["Yes \u2014 ABG result. {context} {severity}", "{context}. {onset}", "I have had ABG result. {context} {onset}", "Yes, ABG result since {onset}. {severity}", "ABG result for {onset}. {context}", "I noticed ABG result. {context} {severity}", "{context}. {severity}", "ABG result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, ABG result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, ABG result \u2014 {context}. {onset} I am scared.", "ABG result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "ABG result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "ABG result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "ABG result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "ABG result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["ABG result. {onset}", "{context}. ABG result.", "{onset}. ABG result.", "{context}. {severity}", "ABG result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "ABG result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) ABG result. {onset}", "(reluctantly) Yes \u2014 ABG result. {context}", "(pause) ABG result \u2014 {context}.", "(hesitating) {context}. ABG result.", "(sighs) {context}. {onset}", "(looks away) ABG result \u2014 {context}.", "(quietly) Yes, ABG result. {context}", "(reluctantly) {context}. ABG result.", "(pause) ABG result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has ABG result. {onset}", "Doctor, ABG result \u2014 {onset}. {severity}", "We noticed ABG result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "ABG result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 ABG result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, ABG result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: ECHO ────────────────────────────────────────────
  ix_echo: {
    cooperative:             ["Yes \u2014 echocardiogram result. {context} {severity}", "{context}. {onset}", "I have had echocardiogram result. {context} {onset}", "Yes, echocardiogram result since {onset}. {severity}", "echocardiogram result for {onset}. {context}", "I noticed echocardiogram result. {context} {severity}", "{context}. {severity}", "echocardiogram result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, echocardiogram result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, echocardiogram result \u2014 {context}. {onset} I am scared.", "echocardiogram result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "echocardiogram result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "echocardiogram result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "echocardiogram result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "echocardiogram result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["echocardiogram result. {onset}", "{context}. echocardiogram result.", "{onset}. echocardiogram result.", "{context}. {severity}", "echocardiogram result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "echocardiogram result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) echocardiogram result. {onset}", "(reluctantly) Yes \u2014 echocardiogram result. {context}", "(pause) echocardiogram result \u2014 {context}.", "(hesitating) {context}. echocardiogram result.", "(sighs) {context}. {onset}", "(looks away) echocardiogram result \u2014 {context}.", "(quietly) Yes, echocardiogram result. {context}", "(reluctantly) {context}. echocardiogram result.", "(pause) echocardiogram result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has echocardiogram result. {onset}", "Doctor, echocardiogram result \u2014 {onset}. {severity}", "We noticed echocardiogram result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "echocardiogram result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 echocardiogram result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, echocardiogram result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: MRI/CT ──────────────────────────────────────────
  ix_mri_ct: {
    cooperative:             ["Yes \u2014 MRI/CT result. {context} {severity}", "{context}. {onset}", "I have had MRI/CT result. {context} {onset}", "Yes, MRI/CT result since {onset}. {severity}", "MRI/CT result for {onset}. {context}", "I noticed MRI/CT result. {context} {severity}", "{context}. {severity}", "MRI/CT result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, MRI/CT result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, MRI/CT result \u2014 {context}. {onset} I am scared.", "MRI/CT result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "MRI/CT result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "MRI/CT result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "MRI/CT result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "MRI/CT result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["MRI/CT result. {onset}", "{context}. MRI/CT result.", "{onset}. MRI/CT result.", "{context}. {severity}", "MRI/CT result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "MRI/CT result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) MRI/CT result. {onset}", "(reluctantly) Yes \u2014 MRI/CT result. {context}", "(pause) MRI/CT result \u2014 {context}.", "(hesitating) {context}. MRI/CT result.", "(sighs) {context}. {onset}", "(looks away) MRI/CT result \u2014 {context}.", "(quietly) Yes, MRI/CT result. {context}", "(reluctantly) {context}. MRI/CT result.", "(pause) MRI/CT result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has MRI/CT result. {onset}", "Doctor, MRI/CT result \u2014 {onset}. {severity}", "We noticed MRI/CT result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "MRI/CT result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 MRI/CT result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, MRI/CT result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: GLUCOSE ─────────────────────────────────────────
  ix_glucose: {
    cooperative:             ["Yes \u2014 blood glucose result. {context} {severity}", "{context}. {onset}", "I have had blood glucose result. {context} {onset}", "Yes, blood glucose result since {onset}. {severity}", "blood glucose result for {onset}. {context}", "I noticed blood glucose result. {context} {severity}", "{context}. {severity}", "blood glucose result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, blood glucose result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, blood glucose result \u2014 {context}. {onset} I am scared.", "blood glucose result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "blood glucose result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "blood glucose result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "blood glucose result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "blood glucose result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["blood glucose result. {onset}", "{context}. blood glucose result.", "{onset}. blood glucose result.", "{context}. {severity}", "blood glucose result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "blood glucose result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) blood glucose result. {onset}", "(reluctantly) Yes \u2014 blood glucose result. {context}", "(pause) blood glucose result \u2014 {context}.", "(hesitating) {context}. blood glucose result.", "(sighs) {context}. {onset}", "(looks away) blood glucose result \u2014 {context}.", "(quietly) Yes, blood glucose result. {context}", "(reluctantly) {context}. blood glucose result.", "(pause) blood glucose result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has blood glucose result. {onset}", "Doctor, blood glucose result \u2014 {onset}. {severity}", "We noticed blood glucose result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "blood glucose result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 blood glucose result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, blood glucose result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: CULTURES ────────────────────────────────────────
  ix_cultures: {
    cooperative:             ["Yes \u2014 culture and sensitivity result. {context} {severity}", "{context}. {onset}", "I have had culture and sensitivity result. {context} {onset}", "Yes, culture and sensitivity result since {onset}. {severity}", "culture and sensitivity result for {onset}. {context}", "I noticed culture and sensitivity result. {context} {severity}", "{context}. {severity}", "culture and sensitivity result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, culture and sensitivity result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, culture and sensitivity result \u2014 {context}. {onset} I am scared.", "culture and sensitivity result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "culture and sensitivity result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "culture and sensitivity result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "culture and sensitivity result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "culture and sensitivity result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["culture and sensitivity result. {onset}", "{context}. culture and sensitivity result.", "{onset}. culture and sensitivity result.", "{context}. {severity}", "culture and sensitivity result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "culture and sensitivity result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) culture and sensitivity result. {onset}", "(reluctantly) Yes \u2014 culture and sensitivity result. {context}", "(pause) culture and sensitivity result \u2014 {context}.", "(hesitating) {context}. culture and sensitivity result.", "(sighs) {context}. {onset}", "(looks away) culture and sensitivity result \u2014 {context}.", "(quietly) Yes, culture and sensitivity result. {context}", "(reluctantly) {context}. culture and sensitivity result.", "(pause) culture and sensitivity result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has culture and sensitivity result. {onset}", "Doctor, culture and sensitivity result \u2014 {onset}. {severity}", "We noticed culture and sensitivity result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "culture and sensitivity result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 culture and sensitivity result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, culture and sensitivity result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: COAGULATION ─────────────────────────────────────
  ix_coagulation: {
    cooperative:             ["Yes \u2014 coagulation screen result. {context} {severity}", "{context}. {onset}", "I have had coagulation screen result. {context} {onset}", "Yes, coagulation screen result since {onset}. {severity}", "coagulation screen result for {onset}. {context}", "I noticed coagulation screen result. {context} {severity}", "{context}. {severity}", "coagulation screen result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, coagulation screen result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, coagulation screen result \u2014 {context}. {onset} I am scared.", "coagulation screen result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "coagulation screen result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "coagulation screen result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "coagulation screen result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "coagulation screen result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["coagulation screen result. {onset}", "{context}. coagulation screen result.", "{onset}. coagulation screen result.", "{context}. {severity}", "coagulation screen result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "coagulation screen result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) coagulation screen result. {onset}", "(reluctantly) Yes \u2014 coagulation screen result. {context}", "(pause) coagulation screen result \u2014 {context}.", "(hesitating) {context}. coagulation screen result.", "(sighs) {context}. {onset}", "(looks away) coagulation screen result \u2014 {context}.", "(quietly) Yes, coagulation screen result. {context}", "(reluctantly) {context}. coagulation screen result.", "(pause) coagulation screen result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has coagulation screen result. {onset}", "Doctor, coagulation screen result \u2014 {onset}. {severity}", "We noticed coagulation screen result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "coagulation screen result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 coagulation screen result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, coagulation screen result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: HORMONES ────────────────────────────────────────
  ix_hormones: {
    cooperative:             ["Yes \u2014 hormone levels. {context} {severity}", "{context}. {onset}", "I have had hormone levels. {context} {onset}", "Yes, hormone levels since {onset}. {severity}", "hormone levels for {onset}. {context}", "I noticed hormone levels. {context} {severity}", "{context}. {severity}", "hormone levels \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, hormone levels \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, hormone levels \u2014 {context}. {onset} I am scared.", "hormone levels since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "hormone levels \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "hormone levels \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "hormone levels \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "hormone levels \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["hormone levels. {onset}", "{context}. hormone levels.", "{onset}. hormone levels.", "{context}. {severity}", "hormone levels \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "hormone levels \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) hormone levels. {onset}", "(reluctantly) Yes \u2014 hormone levels. {context}", "(pause) hormone levels \u2014 {context}.", "(hesitating) {context}. hormone levels.", "(sighs) {context}. {onset}", "(looks away) hormone levels \u2014 {context}.", "(quietly) Yes, hormone levels. {context}", "(reluctantly) {context}. hormone levels.", "(pause) hormone levels \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has hormone levels. {onset}", "Doctor, hormone levels \u2014 {onset}. {severity}", "We noticed hormone levels. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "hormone levels \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 hormone levels. {context} {onset} {severity}", "{context}. {severity}", "Doctor, hormone levels \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: TUMOUR MARKERS ──────────────────────────────────
  ix_tumour_markers: {
    cooperative:             ["Yes \u2014 tumour markers. {context} {severity}", "{context}. {onset}", "I have had tumour markers. {context} {onset}", "Yes, tumour markers since {onset}. {severity}", "tumour markers for {onset}. {context}", "I noticed tumour markers. {context} {severity}", "{context}. {severity}", "tumour markers \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, tumour markers \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, tumour markers \u2014 {context}. {onset} I am scared.", "tumour markers since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "tumour markers \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "tumour markers \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "tumour markers \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "tumour markers \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["tumour markers. {onset}", "{context}. tumour markers.", "{onset}. tumour markers.", "{context}. {severity}", "tumour markers \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "tumour markers \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) tumour markers. {onset}", "(reluctantly) Yes \u2014 tumour markers. {context}", "(pause) tumour markers \u2014 {context}.", "(hesitating) {context}. tumour markers.", "(sighs) {context}. {onset}", "(looks away) tumour markers \u2014 {context}.", "(quietly) Yes, tumour markers. {context}", "(reluctantly) {context}. tumour markers.", "(pause) tumour markers \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has tumour markers. {onset}", "Doctor, tumour markers \u2014 {onset}. {severity}", "We noticed tumour markers. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "tumour markers \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 tumour markers. {context} {onset} {severity}", "{context}. {severity}", "Doctor, tumour markers \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: SPIROMETRY ──────────────────────────────────────
  ix_spirometry: {
    cooperative:             ["Yes \u2014 spirometry result. {context} {severity}", "{context}. {onset}", "I have had spirometry result. {context} {onset}", "Yes, spirometry result since {onset}. {severity}", "spirometry result for {onset}. {context}", "I noticed spirometry result. {context} {severity}", "{context}. {severity}", "spirometry result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, spirometry result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, spirometry result \u2014 {context}. {onset} I am scared.", "spirometry result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "spirometry result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "spirometry result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "spirometry result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "spirometry result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["spirometry result. {onset}", "{context}. spirometry result.", "{onset}. spirometry result.", "{context}. {severity}", "spirometry result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "spirometry result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) spirometry result. {onset}", "(reluctantly) Yes \u2014 spirometry result. {context}", "(pause) spirometry result \u2014 {context}.", "(hesitating) {context}. spirometry result.", "(sighs) {context}. {onset}", "(looks away) spirometry result \u2014 {context}.", "(quietly) Yes, spirometry result. {context}", "(reluctantly) {context}. spirometry result.", "(pause) spirometry result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has spirometry result. {onset}", "Doctor, spirometry result \u2014 {onset}. {severity}", "We noticed spirometry result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "spirometry result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 spirometry result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, spirometry result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: BONE PROFILE ────────────────────────────────────
  ix_bone_profile: {
    cooperative:             ["Yes \u2014 bone profile result. {context} {severity}", "{context}. {onset}", "I have had bone profile result. {context} {onset}", "Yes, bone profile result since {onset}. {severity}", "bone profile result for {onset}. {context}", "I noticed bone profile result. {context} {severity}", "{context}. {severity}", "bone profile result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, bone profile result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, bone profile result \u2014 {context}. {onset} I am scared.", "bone profile result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "bone profile result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "bone profile result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "bone profile result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "bone profile result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["bone profile result. {onset}", "{context}. bone profile result.", "{onset}. bone profile result.", "{context}. {severity}", "bone profile result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "bone profile result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) bone profile result. {onset}", "(reluctantly) Yes \u2014 bone profile result. {context}", "(pause) bone profile result \u2014 {context}.", "(hesitating) {context}. bone profile result.", "(sighs) {context}. {onset}", "(looks away) bone profile result \u2014 {context}.", "(quietly) Yes, bone profile result. {context}", "(reluctantly) {context}. bone profile result.", "(pause) bone profile result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has bone profile result. {onset}", "Doctor, bone profile result \u2014 {onset}. {severity}", "We noticed bone profile result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "bone profile result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 bone profile result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, bone profile result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: TFTs ────────────────────────────────────────────
  ix_thyroid_function: {
    cooperative:             ["Yes \u2014 thyroid function result. {context} {severity}", "{context}. {onset}", "I have had thyroid function result. {context} {onset}", "Yes, thyroid function result since {onset}. {severity}", "thyroid function result for {onset}. {context}", "I noticed thyroid function result. {context} {severity}", "{context}. {severity}", "thyroid function result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, thyroid function result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, thyroid function result \u2014 {context}. {onset} I am scared.", "thyroid function result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "thyroid function result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "thyroid function result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "thyroid function result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "thyroid function result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["thyroid function result. {onset}", "{context}. thyroid function result.", "{onset}. thyroid function result.", "{context}. {severity}", "thyroid function result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "thyroid function result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) thyroid function result. {onset}", "(reluctantly) Yes \u2014 thyroid function result. {context}", "(pause) thyroid function result \u2014 {context}.", "(hesitating) {context}. thyroid function result.", "(sighs) {context}. {onset}", "(looks away) thyroid function result \u2014 {context}.", "(quietly) Yes, thyroid function result. {context}", "(reluctantly) {context}. thyroid function result.", "(pause) thyroid function result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has thyroid function result. {onset}", "Doctor, thyroid function result \u2014 {onset}. {severity}", "We noticed thyroid function result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "thyroid function result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 thyroid function result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, thyroid function result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: LIPIDS ──────────────────────────────────────────
  ix_lipid_profile: {
    cooperative:             ["Yes \u2014 lipid profile result. {context} {severity}", "{context}. {onset}", "I have had lipid profile result. {context} {onset}", "Yes, lipid profile result since {onset}. {severity}", "lipid profile result for {onset}. {context}", "I noticed lipid profile result. {context} {severity}", "{context}. {severity}", "lipid profile result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, lipid profile result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, lipid profile result \u2014 {context}. {onset} I am scared.", "lipid profile result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "lipid profile result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "lipid profile result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "lipid profile result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "lipid profile result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["lipid profile result. {onset}", "{context}. lipid profile result.", "{onset}. lipid profile result.", "{context}. {severity}", "lipid profile result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "lipid profile result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) lipid profile result. {onset}", "(reluctantly) Yes \u2014 lipid profile result. {context}", "(pause) lipid profile result \u2014 {context}.", "(hesitating) {context}. lipid profile result.", "(sighs) {context}. {onset}", "(looks away) lipid profile result \u2014 {context}.", "(quietly) Yes, lipid profile result. {context}", "(reluctantly) {context}. lipid profile result.", "(pause) lipid profile result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has lipid profile result. {onset}", "Doctor, lipid profile result \u2014 {onset}. {severity}", "We noticed lipid profile result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "lipid profile result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 lipid profile result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, lipid profile result \u2014 {context}. {onset} {severity}"],
  },
  // ── IX: HbA1c ───────────────────────────────────────────
  ix_hba1c: {
    cooperative:             ["Yes \u2014 HbA1c result. {context} {severity}", "{context}. {onset}", "I have had HbA1c result. {context} {onset}", "Yes, HbA1c result since {onset}. {severity}", "HbA1c result for {onset}. {context}", "I noticed HbA1c result. {context} {severity}", "{context}. {severity}", "HbA1c result \u2014 {character}. {onset} {severity}", "{context}. {onset}", "Yes, HbA1c result \u2014 {onset}. {character}"],
    anxious:                 ["Doctor, HbA1c result \u2014 {context}. {onset} I am scared.", "HbA1c result since {onset}. {severity} I am worried.", "Doctor, {context}. {severity} Something is wrong.", "HbA1c result \u2014 {onset}. {severity} I am frightened.", "Doctor, {context}. {severity} Please help.", "HbA1c result \u2014 {onset}. {severity} I have been desperate.", "Doctor, {context}. {severity} I nearly fainted.", "HbA1c result \u2014 {context}. {onset} It will not stop.", "Doctor, {context}. {severity} I should have come sooner.", "HbA1c result \u2014 {severity}. {onset} I am desperate."],
    stoic:                   ["HbA1c result. {onset}", "{context}. HbA1c result.", "{onset}. HbA1c result.", "{context}. {severity}", "HbA1c result \u2014 {character}.", "Yes \u2014 {context}.", "{context}. Noted.", "HbA1c result \u2014 {severity}. {onset}", "{context}. I manage.", "{context}."],
    reticent:                ["(quietly) HbA1c result. {onset}", "(reluctantly) Yes \u2014 HbA1c result. {context}", "(pause) HbA1c result \u2014 {context}.", "(hesitating) {context}. HbA1c result.", "(sighs) {context}. {onset}", "(looks away) HbA1c result \u2014 {context}.", "(quietly) Yes, HbA1c result. {context}", "(reluctantly) {context}. HbA1c result.", "(pause) HbA1c result \u2014 {context}. {onset}", "(quietly) {context}. Yes."],
    frightened_child_proxy:  ["The child has HbA1c result. {onset}", "Doctor, HbA1c result \u2014 {onset}. {severity}", "We noticed HbA1c result. {context} {onset}", "{context}. {onset} {severity}", "Doctor, {context}. {severity}", "HbA1c result \u2014 {context}. {onset}", "Doctor, {context}. {onset}", "The child \u2014 HbA1c result. {context} {onset} {severity}", "{context}. {severity}", "Doctor, HbA1c result \u2014 {context}. {onset} {severity}"],
  },
  _default: {
    cooperative:             ["{context}", "{context} {severity}", "{context} {onset}", "Yes \u2014 {context}.", "To answer that \u2014 {context}.", "It is {context}. {severity}", "{context}. {onset} {severity}", "Yes \u2014 {context}. {modifier}", "I would say {context}.", "{context}. I hope that helps."],
    anxious:                 ["{context}", "{context} \u2014 is that serious?", "Doctor, {context}. I am worried.", "{context}. {severity} Please help.", "Doctor, {context}. I have been scared.", "{context}. Could it be serious?", "{context}. {severity} I need to know.", "Doctor, {context}. I have not slept.", "{context}. What does it mean?", "Doctor, {context}. I am frightened."],
    stoic:                   ["{context}", "{context}.", "{context}. Yes.", "{context}. That is all.", "{context}. Noted.", "{context}. I manage.", "{context}. Nothing more.", "{context}. I carry on.", "{context}. Yes.", "{context}. Done."],
    reticent:                ["{context}", "(pause) {context}", "(reluctantly) {context}.", "(quietly) {context}.", "(hesitating) {context}. Yes.", "(sighs) {context}.", "(looks away) {context}.", "(reluctantly) {context}. That is all.", "(quietly) {context}. I hope that is enough.", "(pause) {context}. Yes."],
    frightened_child_proxy:  ["{context}", "Doctor, {context}.", "The child \u2014 {context}.", "{context}. {severity}", "Doctor, {context}. Please help.", "{context}. We are worried.", "Doctor, {context}. {onset}", "{context}. {severity} Please.", "Doctor, {context}. We came as fast as we could.", "{context}. God please help this child."],
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
 * countIntentAsks(intentId, conversationHistory, askedIntents)
 * How many times has this exact intent been asked before?
 *
 * Uses askedIntents array (always sent by frontend) as the primary
 * counter. conversationHistory intentId tags are used as a secondary
 * check if available. askedIntents is a Set on the client so it only
 * tells us IF it was asked, not HOW MANY TIMES — we use
 * conversationHistory length filtered by intentId for true count,
 * but fall back to: 0 = not in askedIntents, 1 = in askedIntents
 * (first repeat), escalating by conversationHistory if tagged.
 */
function countIntentAsks(intentId, conversationHistory, askedIntents) {
  // Primary: count tagged turns in conversationHistory (most accurate)
  const historyCount = (conversationHistory || [])
    .filter(t => t.intentId === intentId).length;

  if (historyCount > 0) return historyCount;

  // Secondary: if askedIntents includes this id, it's been asked at least once
  // before this current request — so this is a repeat (count = 1)
  if (askedIntents && askedIntents.includes(intentId)) return 1;

  return 0;
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

function generateConversation({
  facts,
  baseText,
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
  // ── Step 1: Dynamic temperament drift ───────────────────────
  const dynamicTemperament = shiftTemperament(
    baseTemperament, cumulativePenalties, phaseViolationOccurred);

  let reply;

  // askCount uses BOTH conversationHistory intentId tags (accurate after
  // frontend fix) AND askedIntents array (reliable fallback before fix)
  const askCount = countIntentAsks(intentId, conversationHistory, askedIntents);

  if (facts) {
    // ── Step 2: Tier-first resolution ───────────────────────────
    if (askCount === 0 && facts.tier1) {
      reply = facts.tier1;
    } else if (askCount === 1 && facts.tier2) {
      reply = facts.tier2;
    } else if (askCount >= 2 && facts.tier3) {
      reply = `(Sighs) ${facts.tier3}`;
    } else if (askCount >= 2 && facts.tier2) {
      reply = `I already told you — ${facts.tier2}`;
    } else if (facts.tier1) {
      reply = facts.tier1;
    } else {
      // Facts exist but no tier text — use context or template
      if (facts.context) {
        reply = facts.context;
      } else {
        const template = selectTemplate(intentId, dynamicTemperament, isDistressed, rng);
        reply = fillSlots(template, facts);
      }
    }

    // ── Step 3: Back-reference (first ask only, history intents) ─
    if (askCount === 0 && !intentId.startsWith('exam_') && !intentId.startsWith('ix_')) {
      const backRef = buildBackReference(intentId, conversationHistory, rng);
      if (backRef && reply) {
        reply = backRef + reply.charAt(0).toLowerCase() + reply.slice(1);
      }
    }

  } else {
    // ── No facts — legacy v5.0 pipeline ────────────────────────
    reply = applyPersonality(baseText, dynamicTemperament, isDistressed, rng);
  }

  // ── Step 4: Progressive fatigue (repeat-ask marker) ─────────
  reply = applyProgressiveDisclosure(reply, intentId, askedIntents);

  // ── Step 5: Nigerian cultural context ───────────────────────
  reply = injectNigerianContext(reply, intentId, rng);

  // ── Step 6: Jargon confusion guard ──────────────────────────
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
