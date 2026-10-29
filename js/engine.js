/**
 * ============================================================================
 * MindTrace — Diagnostic Engine
 * ============================================================================
 *
 * Responsibilities:
 *   - Firebase (anonymous auth + Firestore) session persistence
 *   - Deterministic math referee (checkMathEquivalence)
 *   - Prompt construction and dispatch via /api/proxy
 *   - Diagnosis normalization (guarantee schema even if LLM fails)
 *   - Adaptive probe generation targeting identified gaps
 *   - Aggregated cognitive profile computation
 *
 * SECURITY: This module NEVER holds an API key. All model calls go through
 * /api/proxy (a Vercel serverless function). The key lives only in the
 * serverless function's environment variables.
 * ============================================================================
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  initializeFirestore, collection, addDoc, serverTimestamp,
  query, where, orderBy, limit, getDocs, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

export const firebaseConfig = {
  apiKey: "AIzaSyAh0ueLquQJGcwAGHh8HLxfG0blFR--eBE",
  authDomain: "mindtrace-e36c4.firebaseapp.com",
  projectId: "mindtrace-e36c4",
  storageBucket: "mindtrace-e36c4.firebasestorage.app",
  messagingSenderId: "666861010182",
  appId: "1:666861010182:web:0bdbcd3b0da14cebb87287",
  measurementId: "G-VB8DKKGNTL"
};

const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, { experimentalForceLongPolling: true });
export const auth = getAuth(app);

export async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser.uid;
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      if (user) return resolve(user.uid);
      signInAnonymously(auth).then((c) => resolve(c.user.uid)).catch(reject);
    }, reject);
  });
}
export async function resetAuth() { await signOut(auth); }

const META_MODEL = localStorage.getItem("META_MODEL") || "muse-spark-open-1026";

/* ============================================================================
 * DETERMINISTIC MATH REFEREE
 * ----------------------------------------------------------------------------
 * Compares the student's final answer to the stored correct answer with
 * numeric equivalence. Handles:
 *   "x=5" vs "5"            → CORRECT (variable prefix stripped)
 *   "x=5" vs "x=5.0"        → CORRECT (float tolerance)
 *   "1/2" vs "0.5"          → CORRECT (fraction evaluation)
 *   "no solution"           → passes through as UNKNOWN
 *
 * Rejects:
 *   "x=5" vs "x=50"         → INCORRECT
 *   "x=5" vs "x=5.5"        → INCORRECT
 *   "x=5" vs "y=5"          → INCORRECT (different variables)
 *
 * The verdict is injected into the LLM prompt as GROUND TRUTH to prevent
 * hallucinated "you are correct" when the math says otherwise.
 * ========================================================================== */
export function checkMathEquivalence(studentStep, correctAnswer) {
  if (!studentStep || !correctAnswer) return "UNKNOWN";
  const normalize = (s) => String(s).replace(/\s+/g, "").toLowerCase().replace(/−/g, "-");
  const s = normalize(studentStep);
  const a = normalize(correctAnswer);
  if (!s || !a) return "UNKNOWN";
  if (s === a) return "CORRECT";

  const extractVar = (str) => {
    const m = str.match(/^([a-zA-Z])\s*=/);
    return m ? m[1].toLowerCase() : null;
  };
  const sv = extractVar(s);
  const av = extractVar(a);
  if (sv && av && sv !== av) return "INCORRECT";

  const extractValue = (str) => {
    const parts = str.split("=");
    const rhs = parts.length > 1 ? parts[parts.length - 1] : str;
    const cleaned = rhs.replace(/[^0-9.\-+*\/()]/g, "");
    if (!cleaned) return null;
    try {
      const val = Function('"use strict";return (' + cleaned + ')')();
      return Number.isFinite(val) ? val : null;
    } catch { return null; }
  };
  try {
    const sNum = extractValue(s);
    const aNum = extractValue(a);
    if (sNum !== null && aNum !== null) {
      return Math.abs(sNum - aNum) < 1e-9 ? "CORRECT" : "INCORRECT";
    }
  } catch {}
  return "UNKNOWN";
}

/* ---------- Helpers ---------- */
function normalizeGap(g) { return String(g || "").trim().toLowerCase().replace(/\s+/g, " "); }

function sessionSecondsOf(s) {
  if (s?.timestamp?.seconds) return s.timestamp.seconds;
  if (typeof s?.timestamp?.toMillis === "function") {
    try { return Math.floor(s.timestamp.toMillis() / 1000); } catch {}
  }
  if (s?.clientTime) return Math.floor(s.clientTime / 1000);
  return 0;
}

async function fetchRecentSessionsForProfile(studentId, n = 12) {
  const uid = auth.currentUser?.uid;
  if (!studentId || studentId !== uid) return [];
  try {
    const q = query(collection(db, "student_sessions"),
      where("studentId", "==", studentId),
      orderBy("timestamp", "desc"),
      limit(n));
    const snap = await getDocs(q);
    const out = []; snap.forEach((d) => out.push(d.data()));
    return out;
  } catch {
    try {
      const q2 = query(collection(db, "student_sessions"),
        where("studentId", "==", studentId), limit(n * 2));
      const snap2 = await getDocs(q2);
      const out2 = []; snap2.forEach((d) => out2.push(d.data()));
      out2.sort((a, b) => sessionSecondsOf(b) - sessionSecondsOf(a));
      return out2.slice(0, n);
    } catch { return []; }
  }
}

/* ---------- Aggregated cognitive profile ---------- */
function computeAggregatedProfile(sessions) {
  const sorted = [...sessions].sort((a, b) => sessionSecondsOf(b) - sessionSecondsOf(a));
  const threeDaysAgoSeconds = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000);

  const gapCounts = new Map();
  const gapToTopics = new Map();
  const topicStats = new Map();
  const recentTopicSessions = new Map();

  for (let idx = 0; idx < sorted.length; idx++) {
    const s = sorted[idx];
    const d = s.diagnosis || {};
    const gapRaw = d.gap_node || d.gap_identified || d.rule_to_focus || "";
    const isCorrect = String(d.status || "").toLowerCase().includes("correct");
    const topic = String(s.topic || "General").trim();
    const secs = sessionSecondsOf(s);

    if (!isCorrect) {
      const key = normalizeGap(gapRaw);
      if (key && key !== "general understanding" && key !== "unknown gap") {
        const display = String(gapRaw).trim();
        if (!gapCounts.has(key)) gapCounts.set(key, { label: display, count: 0, lastIdx: idx });
        const entry = gapCounts.get(key);
        entry.count++;
        if (idx < entry.lastIdx) entry.lastIdx = idx;
        if (!gapToTopics.has(key)) gapToTopics.set(key, new Set());
        gapToTopics.get(key).add(topic);
      }
    }

    if (secs >= threeDaysAgoSeconds) {
      if (!recentTopicSessions.has(topic)) recentTopicSessions.set(topic, []);
      if (recentTopicSessions.get(topic).length < 3) {
        recentTopicSessions.get(topic).push(isCorrect);
      }
      if (!topicStats.has(topic)) topicStats.set(topic, { correct: 0, total: 0 });
      const st = topicStats.get(topic);
      if (isCorrect) st.correct++;
      st.total++;
    }
  }

  const recoveredTopics = new Set();
  for (const [topic, rec] of recentTopicSessions.entries()) {
    if (rec.length >= 2 && rec[0] && rec[1]) recoveredTopics.add(topic);
  }

  const last3 = sorted.slice(0, 3).map((s) => String(s.diagnosis?.status || "").toLowerCase().includes("correct"));
  const globalStreak3 = last3.length >= 3 && last3.every(Boolean);
  const last2 = sorted.slice(0, 2).map((s) => String(s.diagnosis?.status || "").toLowerCase().includes("correct"));
  const globalStreak2 = last2.length >= 2 && last2.every(Boolean);

  let weaknessesEntries = Array.from(gapCounts.entries());
  if (globalStreak3) weaknessesEntries = [];
  else {
    weaknessesEntries = weaknessesEntries.filter(([, v]) => {
      const topics = gapToTopics.get(normalizeGap(v.label)) || new Set();
      for (const t of topics) if (recoveredTopics.has(t)) return false;
      if (globalStreak2 && v.lastIdx >= 2) return false;
      return true;
    });
  }
  const weaknessesSorted = weaknessesEntries
    .sort((a, b) => b[1].count - a[1].count || a[1].lastIdx - b[1].lastIdx)
    .map(([, v]) => v.count >= 2 ? `${v.label} (x${v.count})` : v.label);

  const strengthsMap = new Map();
  for (const [t, st] of topicStats.entries()) if (st.correct > 0) strengthsMap.set(t, st.correct);
  for (const t of recoveredTopics) if (!strengthsMap.has(t)) strengthsMap.set(t, 1);
  const strengthsSorted = Array.from(strengthsMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => {
      const label = recoveredTopics.has(t) ? `${t} ✓ recovered` : t;
      return c >= 2 ? `${label} (x${c})` : label;
    });

  let totalCorrect = 0, totalSessions = 0;
  for (const stats of topicStats.values()) {
    totalCorrect += stats.correct;
    totalSessions += stats.total;
  }
  const rate = totalSessions ? totalCorrect / totalSessions : 0;
  let level = "Intermediate";
  if (totalSessions >= 3) {
    if (rate >= 0.7 || globalStreak3 || recoveredTopics.size >= 2) level = "Advanced";
    else if (rate <= 0.35) level = "Beginner";
  } else if (globalStreak2 || recoveredTopics.size) level = "Intermediate";

  return {
    weaknesses: weaknessesSorted.slice(0, 4),
    strengths: strengthsSorted.slice(0, 4),
    level, mastery: level,
    correctCount: totalCorrect,
    errorCount: totalSessions - totalCorrect,
    total: totalSessions,
    recoveredTopics: Array.from(recoveredTopics)
  };
}

async function persistStudentProfile(studentId) {
  const uid = auth.currentUser?.uid;
  if (!studentId || studentId !== uid) return;
  try {
    const sessions = await fetchRecentSessionsForProfile(studentId, 12);
    if (!sessions.length) return;
    const agg = computeAggregatedProfile(sessions);
    await setDoc(doc(db, "student_profiles", studentId), {
      weaknesses: agg.weaknesses, strengths: agg.strengths,
      level: agg.level, mastery: agg.mastery,
      sessionCount: agg.total, updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (e) { console.warn("persistStudentProfile failed:", e.message); }
}

/* ============================================================================
 * EPISODIC MEMORY — recall prior mistakes on the same topic
 * ========================================================================== */
export async function fetchMemory(studentId, currentTopic) {
  const uid = auth.currentUser?.uid;
  if (!studentId || studentId !== uid || !currentTopic) {
    return { pastSessions: [], memoryText: "No past history." };
  }
  try {
    const q = query(collection(db, "student_sessions"),
      where("studentId", "==", studentId),
      where("topic", "==", currentTopic),
      orderBy("timestamp", "desc"),
      limit(3));
    const snap = await getDocs(q);
    const pastSessions = []; snap.forEach((d) => pastSessions.push({ id: d.id, ...d.data() }));
    if (!pastSessions.length) return { pastSessions, memoryText: "No past history. First attempt on this topic." };
    const memoryText = pastSessions.map((s, i) => {
      const diag = s.diagnosis || {};
      const expl = diag.simple_explanation || diag.misconception || diag.diagnosis || "unknown mistake";
      const gap = diag.gap_node || diag.gap_identified || "unknown gap";
      const steps = Array.isArray(s.steps) ? s.steps.join(" → ") : "";
      return `Past session ${i + 1}: steps [${steps}] led to error: "${expl}" (gap: ${gap})`;
    }).join("\n");
    return { pastSessions, memoryText };
  } catch {
    try {
      const q2 = query(collection(db, "student_sessions"),
        where("studentId", "==", studentId), limit(10));
      const snap2 = await getDocs(q2);
      const filtered = [];
      snap2.forEach((d) => {
        const data = d.data();
        if (data.topic === currentTopic) filtered.push({ id: d.id, ...data });
      });
      filtered.sort((a, b) => sessionSecondsOf(b) - sessionSecondsOf(a));
      const pastSessions = filtered.slice(0, 3);
      if (!pastSessions.length) return { pastSessions: [], memoryText: "No past history." };
      const memoryText = pastSessions.map((s, i) => {
        const diag = s.diagnosis || {};
        return `Past session ${i + 1}: "${diag.simple_explanation || diag.diagnosis || "mistake"}" (gap: ${diag.gap_node || "unknown"})`;
      }).join("\n");
      return { pastSessions, memoryText };
    } catch { return { pastSessions: [], memoryText: "Memory unavailable." }; }
  }
}

/* ============================================================================
 * PROBE GENERATION
 * ========================================================================== */
const FALLBACK_QUESTIONS = {
  "Linear Equations":    { question: "2x + 5 = 15",                                          answer: "x = 5" },
  "Fractions":           { question: "1/2 + 3/4 = ?",                                        answer: "5/4" },
  "Quadratic Equations": { question: "x^2 - 5x + 6 = 0",                                     answer: "x = 2" },
  "Geometry":            { question: "Find the area of a rectangle with length 8 and width 5", answer: "40" },
  "Algebra":             { question: "3x - 7 = 14",                                          answer: "x = 7" },
  "Trigonometry":        { question: "Find sin(30°) + cos(60°)",                             answer: "1" }
};
function getFallbackForTopic(topic) {
  return FALLBACK_QUESTIONS[topic] || { question: "4x - 8 = 12", answer: "x = 5" };
}

export async function getOrGenerateQuestion(topic) {
  const cleanTopic = String(topic || "").trim() || "Linear Equations";
  try {
    const q = query(collection(db, "public_questions"), where("topic", "==", cleanTopic), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const cached = snap.docs[0].data();
      if (cached?.question) return { question: cached.question, answer: cached.answer || "" };
    }
  } catch (err) { console.warn("Question cache lookup failed:", err); }

  const prompt = `Generate one clear math problem for the topic "${cleanTopic}". If it is an equation, output ONLY the equation itself (e.g., '2x + 5 = 15'). Do not include any text like 'Solve for x'. Respond ONLY with JSON: {"question": "...", "answer": "..."}`;

  let generated = null;
  try { generated = await callViaProxy(prompt); }
  catch (e) { console.error("Probe generation failed:", e); }

  if (generated && typeof generated === "object" && generated.question) {
    return { question: String(generated.question), answer: String(generated.answer || "") };
  }
  if (typeof generated === "string" && generated.trim()) {
    try {
      const parsed = JSON.parse(cleanJsonText(generated));
      if (parsed?.question) return { question: String(parsed.question), answer: String(parsed.answer || "") };
    } catch {}
    return { question: String(generated).trim(), answer: "" };
  }

  const fb = getFallbackForTopic(cleanTopic);
  if (auth.currentUser) {
    try {
      await addDoc(collection(db, "public_questions"), {
        topic: cleanTopic, question: fb.question, answer: fb.answer,
        timestamp: serverTimestamp(), clientTime: Date.now()
      });
    } catch {}
  }
  return fb;
}

/* ============================================================================
 * DIAGNOSTIC PROMPT CONSTRUCTION
 * ----------------------------------------------------------------------------
 * The referee verdict (jsVerdict) is injected as an immutable ground-truth
 * line so the LLM is explicitly instructed not to contradict the JS referee.
 * ========================================================================== */
export function buildDiagnosticPrompt(currentTopic, questionText, steps, memoryText, hasImage, jsVerdict) {
  const stepsText = steps.length ? steps.join(" | ") : (hasImage ? "(see image)" : "(no steps yet)");
  const imageInstruction = hasImage
    ? `\nIMPORTANT: The user has provided an image of their handwritten math. First, transcribe the math steps you see in the image into the \`steps_analyzed\` array. Then, verify their logic step-by-step against your correct solution. If steps list is empty, rely solely on the image transcription.\n`
    : "";
  return `You are an expert mathematical diagnostic agent and step-level verifier.\n${imageInstruction}
Source Problem: ${questionText}
Domain: ${currentTopic}.
Submitted workflow steps: ${stepsText}.
Prior error signatures: ${memoryText}.

DETERMINISTIC VERDICT: A JavaScript referee has mathematically evaluated the submitted final answer. The verdict is: **${jsVerdict || "UNKNOWN"}**.

Task:
1. If verdict is CORRECT: do NOT mark their steps wrong. Confirm why their approach is valid.
2. If verdict is INCORRECT: find the EXACT step where they broke a math rule.
3. If UNKNOWN: diagnose normally.

Mentally solve the Source Problem yourself. Then verify the student logic step-by-step against YOUR correct solution. Check if the transformation from the previous step to the current step is mathematically valid. Look for incorrect inverse operations, sign errors, or illegal moves.

Cascading rule: error_type should be "primary" if the student made a new math mistake in this step, "cascading" if the math is correct based on a previous mistake, and "none" if the step is perfectly correct.

PEDAGOGY RULES:
- Do NOT just give the correct answer, and do NOT just say "this is wrong".
- For EVERY incorrect step, explain EXACTLY why the student's specific step is wrong based on the underlying math rule.
- Provide the name of the rule/concept in "rule_to_focus".
- Provide a step-by-step correct method in "correct_method".
- For correct steps: brief affirmation, "" for rule_to_focus, "" for correct_method.
- For "cascading" steps: explain the algebra follows from the earlier wrong value.
Use VERY SIMPLE English.

For "gap_node", output ONLY a specific math concept — use the "rule_to_focus" of the FIRST primary mistake when there is one.

Also generate the FULL correct step-by-step derivation from scratch — 2 to 5 steps, each with the math expression and a 1-sentence why.

Respond ONLY with valid JSON matching this exact structure:
{
  "status": "error",
  "diagnosis": "General summary",
  "simple_explanation": "Explanation of the FIRST mistake",
  "next_step_hint": "Hint to fix",
  "gap_node": "Math concept",
  "full_solution": [ { "step": "2x = 10", "explanation": "Subtract 5 from both sides" } ],
  "step_evaluations": [
    {
      "step_number": 1,
      "is_correct": false,
      "error_type": "primary" | "cascading" | "none",
      "reason": "Explain WHY it is wrong",
      "rule_to_focus": "Rule name",
      "correct_method": "Step-by-step how to do it correctly",
      "error_token": "The exact wrong part",
      "fix_token": "The correct part"
    }
  ]
}`;
}

/* ============================================================================
 * PROXY CLIENT
 * ========================================================================== */
function cleanJsonText(text) {
  if (!text) return "{}";
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

async function callViaProxy(prompt, imageBase64) {
  const res = await fetch("/api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: META_MODEL,
      messages: [
        {
          role: "system",
          content: "You are an expert mathematical diagnostic agent and step-level verifier. Dynamically verify each step against the provided source problem. Explain EXACTLY why each wrong step is wrong based on the math rule, name the rule in rule_to_focus, and give a step-by-step correct_method. Use VERY SIMPLE English. Always respond with valid JSON only. No markdown."
        },
        {
          role: "user",
          content: imageBase64
            ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageBase64 } }]
            : prompt
        }
      ],
      reasoning: { effort: "low" },
      temperature: 0.2,
      max_tokens: 800
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const msg = data?.output?.find((x) => x.type === "message");
    content = msg?.content?.[0]?.text || msg?.content?.[0]?.input_text;
  }
  if (!content) throw new Error("Empty AI response via proxy");
  return JSON.parse(cleanJsonText(content));
}

export async function diagnoseWithAI(currentTopic, questionText, steps, memoryText, imageBase64, jsVerdict = "UNKNOWN") {
  const prompt = buildDiagnosticPrompt(currentTopic, questionText, steps, memoryText, !!imageBase64, jsVerdict);
  return await callViaProxy(prompt, imageBase64);
}

/* ============================================================================
 * DIAGNOSIS NORMALIZATION
 * ========================================================================== */
function extractTokens(reason) {
  const r = String(reason || "");
  const m1 = r.match(/only\s+['"`]([^'"`]+)['"`]\s*(is\s+wrong|wrong)/i);
  const m2 = r.match(/should be\s+['"`]([^'"`]+)['"`]/i);
  return {
    error_token: m1 ? m1[1].trim().slice(0, 12) : "",
    fix_token: m2 ? m2[1].trim().slice(0, 12) : ""
  };
}

function normalizeDiagnosis(raw, steps, jsVerdict = "UNKNOWN") {
  const effectiveSteps = steps.length
    ? steps
    : (Array.isArray(raw?.steps_analyzed) && raw.steps_analyzed.length ? raw.steps_analyzed : steps);

  let sRaw = String(raw?.status || "stuck").toLowerCase();
  if (jsVerdict === "CORRECT") sRaw = "correct";
  const status = sRaw.includes("correct") ? "correct" : sRaw.includes("error") ? "error" : "stuck";

  let step_evaluations;
  if (jsVerdict === "CORRECT") {
    step_evaluations = effectiveSteps.map((_, i) => ({
      step_number: i + 1,
      is_correct: true,
      error_type: "none",
      reason: "Valid step.",
      rule_to_focus: "",
      correct_method: "",
      error_token: "",
      fix_token: ""
    }));
  } else {
    step_evaluations = Array.isArray(raw?.step_evaluations)
      ? raw.step_evaluations.map((ev, i) => ({
          step_number: Number(ev?.step_number) || (i + 1),
          is_correct: ev?.is_correct === true,
          error_type: ["primary", "cascading", "none"].includes(String(ev?.error_type || "").toLowerCase())
            ? String(ev.error_type).toLowerCase()
            : (ev?.is_correct === true ? "none" : "primary"),
          reason: String(ev?.reason || "Check this step."),
          rule_to_focus: String(ev?.rule_to_focus || ev?.rule || ev?.concept || ""),
          correct_method: String(ev?.correct_method || ev?.correctMethod || ev?.method || ""),
          error_token: String(ev?.error_token || extractTokens(ev?.reason).error_token),
          fix_token: String(ev?.fix_token || extractTokens(ev?.reason).fix_token)
        }))
      : effectiveSteps.map((_, i) => ({
          step_number: i + 1,
          is_correct: status === "correct",
          error_type: status === "correct" ? "none" : "primary",
          reason: raw?.diagnosis || raw?.simple_explanation || "Engine returned no step analysis.",
          rule_to_focus: raw?.gap_node || "",
          correct_method: raw?.next_step_hint || "",
          error_token: "",
          fix_token: ""
        }));
  }
  while (step_evaluations.length < effectiveSteps.length) {
    step_evaluations.push({
      step_number: step_evaluations.length + 1,
      is_correct: false,
      error_type: "primary",
      reason: raw?.diagnosis || "No evaluation returned.",
      rule_to_focus: raw?.gap_node || "",
      correct_method: raw?.next_step_hint || "",
      error_token: "",
      fix_token: ""
    });
  }
  step_evaluations = step_evaluations.slice(0, effectiveSteps.length);

  return {
    status,
    diagnosis: jsVerdict === "CORRECT" ? "Correct! Great job." : (raw?.diagnosis || "No diagnosis."),
    simple_explanation: jsVerdict === "CORRECT" ? "You solved it correctly." : (raw?.simple_explanation || raw?.diagnosis || "Try again step by step."),
    next_step_hint: jsVerdict === "CORRECT" ? "Keep up the good work!" : (raw?.next_step_hint || "Check your last step carefully."),
    gap_node: jsVerdict === "CORRECT" ? "None" : (raw?.gap_node || raw?.gap_identified || "General understanding"),
    full_solution: Array.isArray(raw?.full_solution)
      ? raw.full_solution
          .map((s) => ({ step: String(s?.step || ""), explanation: String(s?.explanation || s?.reason || "") }))
          .filter((s) => s.step)
      : [],
    step_evaluations,
    steps_analyzed: raw?.steps_analyzed || effectiveSteps
  };
}

/* ============================================================================
 * DIAGNOSTIC PIPELINE — recall → diagnose → persist
 * ========================================================================== */
export async function runDiagnosis({ studentId, topic, steps, questionText, imageBase64, jsVerdict = "UNKNOWN" }) {
  const { pastSessions, memoryText } = await fetchMemory(studentId, topic);
  let raw;
  try {
    raw = await diagnoseWithAI(topic, questionText, steps, memoryText, imageBase64, jsVerdict);
  } catch (err) {
    raw = {
      status: "stuck",
      diagnosis: `Engine unreachable: ${err.message}`,
      simple_explanation: "The engine is offline right now. Re-check your last step carefully.",
      next_step_hint: "Re-read your previous line and look for a small calculation slip.",
      gap_node: "Connection / verification"
    };
  }
  const diagnosis = normalizeDiagnosis(raw, steps, jsVerdict);
  const stepsToSave = diagnosis.steps_analyzed?.length ? diagnosis.steps_analyzed : steps;
  const savedId = await saveSession({ studentId, topic, steps: stepsToSave, diagnosis });
  try { await persistStudentProfile(studentId); } catch {}
  return { diagnosis, memoryText, pastSessions, savedId };
}

export async function saveSession({ studentId, topic, steps, diagnosis }) {
  const uid = auth.currentUser?.uid;
  if (!studentId || studentId !== uid) return null;
  try {
    const docRef = await addDoc(collection(db, "student_sessions"), {
      studentId, topic, steps, diagnosis,
      timestamp: serverTimestamp(), clientTime: Date.now()
    });
    return docRef.id;
  } catch (e) { console.error("Firebase save failed:", e); return null; }
}

/* ============================================================================
 * TOPIC EXTRACTION
 * ========================================================================== */
export async function extractAndSaveTopic(userQuery) {
  let raw = String(userQuery || "").trim();
  if (!raw) throw new Error("Empty query");
  let extracted = raw;
  try {
    const prompt = `Extract the math topic from this question: "${raw}". Respond ONLY with JSON: {"topic": "Topic Name"}. Example topics: "Linear Equations", "Fractions", "Quadratic Equations", "Geometry", "Algebra", "Trigonometry". If uncertain, infer the most likely topic.`;
    let result = null;
    try { result = await callViaProxy(prompt); } catch {}
    const candidate = result?.topic || result?.Topic || result?.extractedTopic || "";
    if (typeof candidate === "string" && candidate.trim()) extracted = candidate.trim();
    else if (typeof result === "string" && result.trim()) {
      try {
        const parsed = JSON.parse(cleanJsonText(result));
        if (parsed?.topic) extracted = String(parsed.topic).trim();
      } catch { if (result.length < 60) extracted = result.trim(); }
    }
  } catch {}

  extracted = extracted.replace(/^[^a-zA-Z0-9]+/, "").trim();
  if (!extracted) extracted = raw.slice(0, 60).trim();
  if (extracted.length > 60) extracted = extracted.slice(0, 60).trim();
  if (extracted.toLowerCase() === extracted) {
    extracted = extracted.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").slice(0, 60);
  }

  if (auth.currentUser) {
    try {
      let exists = false;
      try {
        const q = query(collection(db, "saved_topics"), where("topic", "==", extracted), limit(1));
        const snap = await getDocs(q);
        exists = !snap.empty;
      } catch {}
      if (!exists) {
        await addDoc(collection(db, "saved_topics"), {
          topic: extracted, timestamp: serverTimestamp(), clientTime: Date.now()
        });
      }
    } catch {}
  }
  try {
    const existing = JSON.parse(localStorage.getItem("mindtrace_topics") || "[]");
    if (Array.isArray(existing) && !existing.includes(extracted)) {
      existing.push(extracted);
      localStorage.setItem("mindtrace_topics", JSON.stringify(existing));
    }
  } catch {}
  return extracted;
}

export async function fetchSavedTopics() {
  const topics = new Set();
  for (const collName of ["saved_topics", "custom_topics", "topics"]) {
    try {
      let snap;
      try { snap = await getDocs(query(collection(db, collName), orderBy("timestamp", "desc"), limit(50))); }
      catch { snap = await getDocs(query(collection(db, collName), limit(50))); }
      snap.forEach((d) => {
        const t = d.data()?.topic;
        if (typeof t === "string" && t.trim()) topics.add(t.trim());
      });
      if (topics.size) break;
    } catch {}
  }
  if (!topics.size) {
    try {
      const parsed = JSON.parse(localStorage.getItem("mindtrace_topics") || "[]");
      if (Array.isArray(parsed)) parsed.forEach((t) => {
        if (typeof t === "string" && t.trim()) topics.add(t.trim());
      });
    } catch {}
  }
  return Array.from(topics);
}

/* ============================================================================
 * COGNITIVE PROFILE
 * ========================================================================== */
export async function getStudentProfile(studentId) {
  const uid = auth.currentUser?.uid;
  if (!studentId || studentId !== uid) {
    return { weaknesses: [], strengths: [], level: "Intermediate", recoveredTopics: [] };
  }
  let docData = null;
  try {
    const snap = await Promise.race([
      getDoc(doc(db, "student_profiles", studentId)),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3000))
    ]);
    if (snap && snap.exists()) docData = snap.data() || {};
  } catch {}

  try {
    const sessions = await fetchRecentSessionsForProfile(studentId, 12);
    if (sessions.length) {
      const agg = computeAggregatedProfile(sessions);
      if (docData) {
        return {
          ...docData,
          weaknesses: agg.weaknesses,
          strengths: agg.strengths.length ? agg.strengths : (docData.strengths || []),
          level: agg.level, mastery: agg.mastery,
          recoveredTopics: agg.recoveredTopics || [], _live: true
        };
      }
      return {
        weaknesses: agg.weaknesses, strengths: agg.strengths,
        level: agg.level, mastery: agg.mastery,
        recoveredTopics: agg.recoveredTopics || []
      };
    }
  } catch {}
  if (docData) return docData;
  return { weaknesses: [], strengths: [], level: "Intermediate", recoveredTopics: [] };
}

/* ============================================================================
 * ADAPTIVE PROBE GENERATOR
 * ========================================================================== */
export function normalizeGeneratedQuestion(raw, topic) {
  let obj = raw;
  if (typeof obj === "string") { try { obj = JSON.parse(cleanJsonText(obj)); } catch { obj = {}; } }
  if (!obj || typeof obj !== "object") obj = {};
  const question = String(obj.question || obj.Question || "").trim();
  if (!question) throw new Error("Empty question from AI — fallback required");
  const diffRaw = String(obj.difficulty || obj.Difficulty || "medium").trim().toLowerCase();
  const difficulty = ["easy", "medium", "hard"].includes(diffRaw) ? diffRaw : "medium";
  const target_skill = String(obj.target_skill || obj.targetSkill || obj.skill || "General practice").trim() || "General practice";
  let estimated = Number(obj.estimated_time_seconds ?? obj.estimated_time ?? obj.time ?? 60);
  if (!Number.isFinite(estimated) || estimated <= 0) estimated = 60;
  const hint = String(obj.hint || "").trim() || "Try isolating the variable step by step.";
  const answer = String(obj.answer || "").trim() || "";
  return {
    question, difficulty, target_skill,
    estimated_time_seconds: Math.round(estimated),
    hint, answer,
    topic: String(topic || "").trim() || "Linear Equations"
  };
}

export async function generateAdaptiveQuestion({ studentId, topic, difficulty = "auto", focusWeakness, avoidRecent = 8 }) {
  const cleanTopic = String(topic || "").trim() || "Linear Equations";
  let profile = null;
  try { profile = await getStudentProfile(studentId); } catch {}
  if (!profile) profile = {};
  const weaknesses = Array.isArray(profile.weaknesses) ? profile.weaknesses : [];
  const strengths = Array.isArray(profile.strengths) ? profile.strengths : [];
  const topWeaknesses = weaknesses.slice(0, 2);
  const strengthToReinforce = strengths[0] || "general problem solving";

  const recentSet = new Set();
  const fetchRecent = async (collName) => {
    try {
      let q;
      try { q = query(collection(db, collName), where("topic", "==", cleanTopic), orderBy("timestamp", "desc"), limit(avoidRecent)); }
      catch { q = query(collection(db, collName), where("topic", "==", cleanTopic), limit(avoidRecent)); }
      const snap = await getDocs(q);
      snap.forEach((d) => {
        const qs = String(d.data()?.question || "").trim();
        if (qs) recentSet.add(qs);
      });
    } catch {
      try {
        const snap2 = await getDocs(query(collection(db, collName), where("topic", "==", cleanTopic), limit(avoidRecent)));
        snap2.forEach((d) => {
          const qs = String(d.data()?.question || "").trim();
          if (qs) recentSet.add(qs);
        });
      } catch {}
    }
  };
  await fetchRecent("public_questions");
  await fetchRecent("generated_questions");
  const recentQuestions = Array.from(recentSet);

  let memoryText = "No past history.";
  try {
    const mem = await fetchMemory(studentId, cleanTopic);
    if (mem && mem.memoryText) memoryText = mem.memoryText;
  } catch {}

  let effectiveDifficulty = difficulty;
  if (difficulty === "auto") {
    const lvl = String(profile.level || "").toLowerCase();
    if (lvl.includes("beginner")) effectiveDifficulty = "easy";
    else if (lvl.includes("advanced")) effectiveDifficulty = "hard";
    else effectiveDifficulty = "medium";
  }
  if (!["easy", "medium", "hard"].includes(effectiveDifficulty)) effectiveDifficulty = "medium";

  const recentListText = recentQuestions.length
    ? recentQuestions.map((q) => `- "${q}"`).join("\n")
    : "None yet.";
  const weaknessText = topWeaknesses.length ? topWeaknesses.join(", ") : "none yet";

  const prompt = `You are an adaptive mathematical diagnostic probe generator.
Domain: "${cleanTopic}"
Effective difficulty: "${effectiveDifficulty}"
${focusWeakness ? `Focus gap (MUST target this skill): "${focusWeakness}"` : `Focus: address the student's top identified gaps if possible.`}
Student's top 2 gaps: ${weaknessText}
One competency to reinforce: ${strengthToReinforce}
Prior error signatures: ${memoryText}
Recent probes to avoid:
${recentListText}
Task: Generate ONE new adaptive practice probe for domain "${cleanTopic}" at difficulty "${effectiveDifficulty}"${focusWeakness ? ` targeting skill "${focusWeakness}"` : ` targeting one of: ${weaknessText || "general practice"}`}. The probe must NOT repeat or be structurally identical to any recent probe above. Respond ONLY with STRICT JSON: {"question":"2x + 7 = 21","difficulty":"easy|medium|hard","target_skill":"Isolating variable after subtraction","estimated_time_seconds":45,"hint":"Subtract the constant first, then divide.","answer":"x = 7"} Rules: "question" must be the math problem only, "difficulty" must be one of easy,medium,hard and match "${effectiveDifficulty}", "target_skill" must reflect the focus, "estimated_time_seconds" is a number, "hint" is a short scaffold, "answer" is the final answer. Do not include markdown.`;

  const fb = getFallbackForTopic(cleanTopic);
  const fallbackBase = {
    question: fb.question,
    difficulty: effectiveDifficulty,
    target_skill: focusWeakness
      ? String(focusWeakness).replace(/\s*\(x\d+\)\s*$/, "")
      : (topWeaknesses[0] || "Isolating variable"),
    estimated_time_seconds: 45,
    hint: "Isolate the variable step by step.",
    answer: fb.answer
  };

  let raw;
  try { raw = await callViaProxy(prompt); }
  catch (e) { console.warn("generateAdaptiveQuestion proxy failed:", e.message); raw = fallbackBase; }

  let normalized;
  try {
    normalized = normalizeGeneratedQuestion(raw, cleanTopic);
    if (focusWeakness) {
      const cleanFocus = String(focusWeakness).replace(/\s*\(x\d+\)\s*$/, "").trim();
      if (cleanFocus && normalized.target_skill.toLowerCase().slice(0, 8) !== cleanFocus.toLowerCase().slice(0, 8)) {
        normalized.target_skill = cleanFocus;
      }
    }
  } catch {
    normalized = normalizeGeneratedQuestion(fallbackBase, cleanTopic);
  }
  if (!normalized.question || !String(normalized.question).trim()) {
    normalized = normalizeGeneratedQuestion(fallbackBase, cleanTopic);
  }

  if (auth.currentUser) {
    try {
      await addDoc(collection(db, "generated_questions"), {
        studentId, topic: cleanTopic, difficulty: normalized.difficulty,
        question: normalized.question, target_skill: normalized.target_skill,
        hint: normalized.hint, answer: normalized.answer,
        timestamp: serverTimestamp(), clientTime: Date.now()
      });
    } catch {}
  }
  return normalized;
}