/**
 * ============================================================================
 * MindTrace — Frontend Controller
 * ============================================================================
 *
 * ARCHITECTURE (for judges reading this file):
 *
 *   index.html  →  script.js  →  engine.js  →  /api/proxy  →  Meta AI
 *      (UI)        (DOM+state)   (AI+Firebase)   (serverless)    (muse)
 *
 *   - script.js owns ALL DOM manipulation and UI state. It NEVER talks to an
 *     AI model directly.
 *   - engine.js owns Firebase persistence, prompt construction, and calling
 *     /api/proxy. It has no direct DOM access.
 *   - /api/proxy.js is a Vercel serverless function holding the API key in an
 *     environment variable. The frontend never sees the key.
 *
 * KEY SYSTEMS:
 *
 *   1. Deterministic Math Referee — checkMathEquivalence() in engine.js.
 *      A JavaScript function compares the student's final answer to the stored
 *      correct answer numerically. Its verdict is injected into the LLM prompt
 *      as ground truth so the model cannot hallucinate "you are correct" when
 *      you are numerically wrong.
 *
 *   2. Referee Gate (isFinalAnswer) — the referee is only invoked when the last
 *      committed step is a FINAL-FORM answer (e.g. "x = 5" or "0.5"). Intermediate
 *      transformations like "2x = 10" would produce false INCORRECT verdicts.
 *
 *   3. Math Rendering — KaTeX is used for LaTeX. Because innerHTML injection
 *      does NOT auto-trigger KaTeX's auto-render extension, we manually invoke
 *      renderMath() after every DOM update.
 *
 *   4. State Machine — `analyzing` blocks concurrent diagnostic passes so
 *      the user cannot fire two overlapping network calls.
 *
 *   5. Image Path — base64 image is passed to engine.js which sends it to
 *      the LLM via /api/proxy. Photo capture clears on success AND failure.
 *
 * NAMING NOTE: This project intentionally avoids "tutor", "lesson", "homework",
 * and "chatbot" terminology. We call it a *diagnostic engine* operating on
 * *workflow traces*, producing *error classifications*, *conceptual breakdowns*,
 * and *optimal transitions* — because that is what the system actually does.
 * ============================================================================
 */

import {
  runDiagnosis,
  fetchMemory,
  getOrGenerateQuestion,
  generateAdaptiveQuestion,
  getStudentProfile,
  extractAndSaveTopic,
  fetchSavedTopics,
  diagnoseWithAI,
  ensureAuth,
  checkMathEquivalence
} from "./engine.js";

/* ---------- Local State ---------- */
const topicDatabase = ["Linear Equations", "Fractions", "Quadratic Equations", "Geometry"];
let currentTopic = "Linear Equations";
let currentQuestionText = "2x + 5 = 15";
let currentQuestionAnswer = "";
let currentQuestionMeta = null;

let studentSteps = [];         // committed workflow steps
let analyzing = false;         // concurrency lock
let pendingImageBase64 = null; // uploaded derivation image
let selectToken = 0;           // guards against stale async topic loads
let lastDerivation = [];       // last fetched optimal solution path
let currentUid = null;

const isAuthReady = () => !!currentUid;
const studentId = () => currentUid || null;

/* ---------- DOM References ---------- */
const $ = (id) => document.getElementById(id);
const topicSearch = $("topicSearch");
const dropdown = $("searchDropdown");
const mathPad = $("mathPad");
const padEmpty = $("padEmpty");
const answerInput = $("studentAnswer");
const submitBtn = $("submitBtn");
const btnText = $("btnText");
const loader = $("loader");
const skillTree = $("skillTree");
const gapLabel = $("gapLabel");
const diagPanel = $("diagPanel");
const memoryBadge = $("memoryCount");
const stepsCount = $("stepsCount");
const derivationBox = $("derivationBox");
const derivationList = $("derivationList");
const derivationActions = $("derivationActions");
const derivationTitle = $("derivationTitle");
const fsOverlay = $("fsOverlay");
const fsBody = $("fsBody");
const fsQuestion = $("fsQuestion");
const profileIdBadge = $("profileIdBadge");
const profileMasteryBadge = $("profileMasteryBadge");
const profileStrengths = $("profileStrengths");
const profileWeaknesses = $("profileWeaknesses");
const profileFooter = $("profileFooter");
const photoInput = $("photoInput");
const uploadPhotoBtn = $("uploadPhotoBtn");
const imagePreviewContainer = $("imagePreviewContainer");
const imagePreview = $("imagePreview");
const removePhotoBtn = $("removePhotoBtn");

/* ============================================================================
 * REFEREE GATE
 * ----------------------------------------------------------------------------
 * checkMathEquivalence() only makes sense on FINAL-FORM answers like "x = 5".
 * Intermediate transformations ("2x = 10") would produce a false INCORRECT.
 * isFinalAnswer() decides whether to invoke the referee at all.
 * ========================================================================== */
function isFinalAnswer(str) {
  const t = String(str || "").trim();
  return /^[a-zA-Z]\s*=\s*[-+]?\d+(\.\d+)?(\/\d+)?$/.test(t)
      || /^[-+]?\d+(\.\d+)?(\/\d+)?$/.test(t);
}

function computeVerdict(lastStep) {
  if (!currentQuestionAnswer || !lastStep || !isFinalAnswer(lastStep)) return "UNKNOWN";
  return checkMathEquivalence(lastStep, currentQuestionAnswer);
}

/* ---------- Utilities ---------- */
const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const toast = (msg, type = "info") => {
  const c = $("toastContainer");
  if (!c) return;
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  const icon = type === "success" ? "fa-circle-check" : type === "error" ? "fa-circle-xmark" : "fa-circle-info";
  t.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escapeHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transform = "translateY(6px)";
    setTimeout(() => t.remove(), 300);
  }, 3500);
};

const setLoading = (on) => {
  if (loader) { loader.classList.toggle("show", on); loader.style.display = on ? "flex" : "none"; }
  if (btnText) btnText.style.display = on ? "none" : "block";
  if (submitBtn) submitBtn.disabled = on;
};

const updateStepsCount = () => {
  if (stepsCount) stepsCount.textContent = studentSteps.length
    ? `(${studentSteps.length} step${studentSteps.length === 1 ? "" : "s"})`
    : "";
};
const safeSetFooter = (msg) => { if (profileFooter) profileFooter.textContent = msg; };

/* ============================================================================
 * MATH FORMATTING & RENDERING
 * ========================================================================== */

/**
 * Converts plain-text math into KaTeX-compatible LaTeX.
 * Preserves existing LaTeX if present. Handles fractions, exponents, sqrt.
 */
function mathToLatex(text) {
  if (!text) return "";
  let t = text.trim();
  if (t.includes("\\frac") || t.includes("\\sqrt")) return t;

  t = t.replace(/\(([^)]+)\)\s*\/\s*\(([^)]+)\)/g, "\\frac{$1}{$2}");
  t = t.replace(/\(([^)]+)\)\s*\/\s*([a-zA-Z0-9.]+)/g, "\\frac{$1}{$2}");
  t = t.replace(/([a-zA-Z0-9.]+)\s*\/\s*\(([^)]+)\)/g, "\\frac{$1}{$2}");
  t = t.replace(/([a-zA-Z0-9.]+)\s*\/\s*([a-zA-Z0-9.]+)/g, "\\frac{$1}{$2}");
  t = t.replace(/\^([a-zA-Z0-9]+)(?!\})/g, "^{$1}");
  t = t.replace(/sqrt\s*\(([^)]+)\)/gi, "\\sqrt{$1}");
  return t;
}

/**
 * Manually triggers KaTeX on a DOM subtree. Required because dynamic HTML
 * injected via innerHTML does not trigger KaTeX's auto-render.
 */
const renderMath = (el) => {
  if (!el) return;
  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "\\[", right: "\\]", display: true },
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false }
        ],
        throwOnError: false
      });
    } catch (e) {
      console.warn("KaTeX render error:", e);
    }
  } else {
    // Retry if the KaTeX CDN hasn't finished loading yet.
    window.addEventListener("load", () => renderMath(el), { once: true });
  }
};

const looksLikeMath = (raw) =>
  /[=\+\-\*\/\^]|\\(frac|sqrt|x|y)|\d\s*[a-zA-Z]|[a-zA-Z]\s*\d/.test(raw) && !/[.!?]\s+[A-Z]/.test(raw);

const sanitizeQuestionText = (raw) => {
  let q = String(raw || "").trim();
  q = q.replace(/^(Solve for [a-z]:|Solve for|Find|Calculate)\s*/i, "").trim();
  q = q.replace(/^:\s*/, "").trim();
  q = q.replace(/\s+(find|solve for|calculate)\s+[a-z]+$/i, "").trim();
  return q;
};

/* ---------- Render problem text safely into the display ---------- */
function paintProblem(raw) {
  const display = $("problemDisplay");
  const cleanQ = mathToLatex(sanitizeQuestionText(raw));
  currentQuestionText = cleanQ;
  if (!display) return;
  const alreadyWrapped = /^(\\\[|\$\$|\$)/.test(cleanQ);
  const html = alreadyWrapped
    ? cleanQ
    : (looksLikeMath(cleanQ) ? `\\[ ${cleanQ} \\]` : escapeHtml(cleanQ));
  display.innerHTML = html;
  renderMath(display);
}

/* ---------- Adaptive metadata pills (difficulty / skill / ETA) ---------- */
function applyQuestionMeta(meta) {
  const metaWrap = $("problemMeta");
  const revealBtn = $("revealScaffoldBtn");
  const revealBox = $("scaffoldReveal");
  const diffEl = $("metaDifficulty");
  const skillEl = $("metaSkill");
  const timeEl = $("metaTime");

  if (!meta || !meta.question) {
    if (metaWrap) { metaWrap.hidden = true; metaWrap.style.display = "none"; }
    if (revealBtn) revealBtn.hidden = true;
    if (revealBox) revealBox.hidden = true;
    if (meta === null) currentQuestionMeta = null;
    return;
  }
  currentQuestionMeta = meta;
  if (diffEl) diffEl.textContent = `🎯 ${meta.difficulty || "medium"}`;
  if (skillEl) skillEl.textContent = `📚 ${meta.target_skill || "General"}`;
  if (timeEl) timeEl.textContent = `⏱ ~${meta.estimated_time_seconds || 60}s`;
  if (metaWrap) { metaWrap.hidden = false; metaWrap.style.display = "flex"; }
  if (revealBtn) revealBtn.hidden = false;
  if (revealBox) revealBox.hidden = true;
}

/* ============================================================================
 * WEAKNESS SELECT (Adaptive Parameters)
 * ========================================================================== */
async function populateWeaknessSelect() {
  const sel = $("weaknessSelect");
  if (!sel || !isAuthReady()) return;
  try {
    let profile = null;
    try { profile = await getStudentProfile(studentId()); } catch { profile = { weaknesses: [] }; }
    sel.innerHTML = `<option value="">Any gap</option>`;
    const weaknesses = Array.isArray(profile?.weaknesses) ? profile.weaknesses : [];
    if (!weaknesses.length) {
      const opt = document.createElement("option");
      opt.disabled = true;
      opt.textContent = "No gaps yet";
      sel.appendChild(opt);
    } else {
      weaknesses.forEach((w) => {
        const val = typeof w === "string" ? w : (w.skill || w.name || w.topic || String(w));
        const label = typeof w === "string" ? w : (w.skill || w.name || w.label || val);
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = label;
        sel.appendChild(opt);
      });
    }
  } catch {}
}

/* ============================================================================
 * GENERATE ADAPTIVE PROBE
 * ========================================================================== */
async function handleGenerateQuestion() {
  if (analyzing || !isAuthReady()) return;
  const btn = $("generateQuestionBtn");
  const orig = btn ? btn.innerHTML : "";
  try {
    analyzing = true;
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Synthesizing…`; }
    safeSetFooter("Synthesizing adaptive probe…");

    const difficulty = $("difficultySelect")?.value || "auto";
    const focusWeakness = $("weaknessSelect")?.value || undefined;
    const generated = await generateAdaptiveQuestion({ studentId: studentId(), topic: currentTopic, difficulty, focusWeakness });
    currentQuestionAnswer = generated.answer || "";

    // Reset UI state
    studentSteps = [];
    if (mathPad) { mathPad.classList.remove("has-results"); mathPad.innerHTML = ""; if (padEmpty) mathPad.appendChild(padEmpty); padEmpty.style.display = "block"; }
    if (diagPanel) diagPanel.hidden = true;
    if (derivationBox) derivationBox.hidden = true;
    if (derivationActions) derivationActions.hidden = false;
    lastDerivation = [];
    if (stepsCount) stepsCount.textContent = "";
    if (fsOverlay) fsOverlay.hidden = true;
    document.body.classList.remove("fs-open");

    paintProblem(generated.question || "");
    applyQuestionMeta(generated);
    renderSkillTree(["Understand problem", "Plan steps", "Solve & check"], -1);
    if (gapLabel) gapLabel.textContent = "";
    safeSetFooter(`Probe synthesized · ${generated.difficulty} · ${generated.target_skill || "practice"} · ${new Date().toLocaleTimeString()}`);
    toast("Adaptive probe deployed", "success");
  } catch (err) {
    safeSetFooter(`Synthesis failed: ${err.message}`);
    toast(err.message, "error");
  } finally {
    analyzing = false;
    if (btn) { btn.disabled = false; btn.innerHTML = orig || `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Probe`; }
  }
}

/* ---------- Custom probe: user-typed problem ---------- */
function setCustomQuestion(q) {
  currentQuestionAnswer = "";
  const raw = sanitizeQuestionText(q);
  if (!raw) return;
  paintProblem(raw);
  studentSteps = [];
  if (mathPad) { mathPad.classList.remove("has-results"); mathPad.innerHTML = ""; mathPad.appendChild(padEmpty); padEmpty.style.display = "block"; }
  if (diagPanel) diagPanel.hidden = true;
  if (derivationBox) derivationBox.hidden = true;
  if (derivationActions) derivationActions.hidden = false;
  lastDerivation = [];
  if (stepsCount) stepsCount.textContent = "";
  safeSetFooter("Custom probe armed · commit steps and run diagnostic");
  toast("Custom probe deployed", "success");
}

/* ============================================================================
 * TOPIC SEARCH DROPDOWN
 * ========================================================================== */
function handleSearch() {
  const raw = topicSearch.value;
  const q = raw.toLowerCase();
  const matches = topicDatabase.filter((t) => t.toLowerCase().includes(q));
  dropdown.innerHTML = "";

  matches.forEach((t) => {
    const el = document.createElement("div");
    el.className = "dropdown-item";
    el.dataset.topic = t;
    el.innerHTML = `<i class="fa-solid fa-book"></i> ${escapeHtml(t)}`;
    el.addEventListener("click", () => selectTopic(t));
    dropdown.appendChild(el);
  });

  if (raw.trim() !== "" && !matches.some((t) => t.toLowerCase() === q.trim())) {
    const el = document.createElement("div");
    el.className = "dropdown-item custom-add";
    el.dataset.topic = raw.trim();
    el.innerHTML = `<i class="fa-solid fa-plus"></i> Add Custom: "${escapeHtml(raw.trim())}"`;
    el.addEventListener("click", () => selectTopic(raw.trim()));
    dropdown.appendChild(el);
  }

  if (!dropdown.children.length) {
    const el = document.createElement("div");
    el.className = "dropdown-item";
    el.innerHTML = `<i class="fa-solid fa-circle-info"></i> No matches — press Enter to add`;
    dropdown.appendChild(el);
  }
  dropdown.classList.add("show");
}

/* ---------- Select topic & load memory + first question ---------- */
async function selectTopic(topic) {
  if (!isAuthReady() || analyzing) return;
  topic = String(topic || "").trim();
  if (!topic) return;
  const myToken = ++selectToken;

  if (!topicDatabase.includes(topic)) {
    topicDatabase.push(topic);
    try { localStorage.setItem("mindtrace_topics", JSON.stringify(topicDatabase)); } catch {}
  }

  currentTopic = topic;
  if ($("currentTopicLabel")) $("currentTopicLabel").textContent = topic;
  if (topicSearch) topicSearch.value = topic;
  dropdown.classList.remove("show");

  studentSteps = [];
  if (mathPad) { mathPad.classList.remove("has-results"); mathPad.innerHTML = ""; mathPad.appendChild(padEmpty); padEmpty.style.display = "block"; }
  if (diagPanel) diagPanel.hidden = true;
  if (derivationBox) derivationBox.hidden = true;
  if (derivationActions) derivationActions.hidden = false;
  lastDerivation = [];
  if (stepsCount) stepsCount.textContent = "";
  closeFullscreen();

  safeSetFooter(`Loading ${topic}…`);
  renderSkillTree(["Understand problem", "Plan steps", "Solve & check"], -1);
  if (gapLabel) gapLabel.textContent = "";
  applyQuestionMeta(null);

  const display = $("problemDisplay");
  if (display) display.innerHTML = `<span style="color:var(--muted);font-size:13px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading episodic memory for <b>${escapeHtml(topic)}</b>…</span>`;

  const { pastSessions } = await fetchMemory(studentId(), currentTopic);
  if (myToken !== selectToken) return;
  if (memoryBadge) memoryBadge.textContent = `${pastSessions.length} past session${pastSessions.length === 1 ? "" : "s"}`;

  const qRes = await getOrGenerateQuestion(topic);
  if (myToken !== selectToken) return;

  currentQuestionAnswer = String(qRes?.answer || "");
  paintProblem(qRes?.question || "");
  populateWeaknessSelect();
  updateProfileCard();
}

/* ============================================================================
 * WORKFLOW TRACE — commit, renumber, clear
 * ========================================================================== */
function lockStep(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return;
  mathPad.querySelectorAll(".math-line").forEach((el) => el.classList.remove("step-correct", "step-wrong", "step-cascading"));
  mathPad.querySelectorAll(".step-reason").forEach((el) => el.remove());
  mathPad.classList.remove("has-results");
  studentSteps.push(text);
  updateStepsCount();
  padEmpty.style.display = "none";

  const line = document.createElement("div");
  line.className = "math-line";
  const tag = document.createElement("span");
  tag.className = "step-tag";
  tag.innerHTML = `<i class="fa-solid fa-chevron-right" style="font-size:8px;"></i> STEP ${studentSteps.length}`;

  const mathText = mathToLatex(text);
  const wrapped = /\\\[|\\\(|\$\$|\$/.test(mathText) ? mathText : `\\[ ${mathText} \\]`;

  const span = document.createElement("span");
  span.textContent = wrapped;
  const del = document.createElement("button");
  del.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
  del.title = "Remove step";

  del.addEventListener("click", () => {
    const idx = [...mathPad.querySelectorAll(".math-line")].indexOf(line);
    if (idx > -1) studentSteps.splice(idx, 1);
    if (line.nextElementSibling?.classList.contains("step-reason")) line.nextElementSibling.remove();
    line.remove();
    renumberSteps();
    updateStepsCount();
    if (!studentSteps.length) padEmpty.style.display = "block";
  });

  line.append(tag, span, del);
  mathPad.appendChild(line);
  renderMath(span);
  mathPad.scrollTop = mathPad.scrollHeight;
}

function renumberSteps() {
  [...mathPad.querySelectorAll(".math-line .step-tag")].forEach((t, i) =>
    t.innerHTML = `<i class="fa-solid fa-chevron-right" style="font-size:8px;"></i> STEP ${i + 1}`);
}

function clearSteps() {
  studentSteps = [];
  if (mathPad) { mathPad.classList.remove("has-results"); mathPad.innerHTML = ""; mathPad.appendChild(padEmpty); padEmpty.style.display = "block"; }
  if (diagPanel) diagPanel.hidden = true;
  if (derivationBox) derivationBox.hidden = true;
  if (derivationActions) derivationActions.hidden = false;
  updateStepsCount();
}

/* ============================================================================
 * FULLSCREEN OVERLAY
 * ========================================================================== */
function openFullscreen() {
  const card = $("problemCard");
  if (card && card.requestFullscreen) card.requestFullscreen().catch(() => showFsOverlay());
  else showFsOverlay();
}

function showFsOverlay() {
  if (!fsOverlay || !fsBody) return;
  fsBody.innerHTML = "";
  const nodes = [...mathPad.childNodes].filter((n) => n.nodeType === 1 && n.id !== "padEmpty");
  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "pad-empty";
    empty.textContent = "No steps committed yet.";
    fsBody.appendChild(empty);
  } else {
    nodes.forEach((n) => fsBody.appendChild(n.cloneNode(true)));
    renderMath(fsBody);
  }
  if (fsQuestion) {
    fsQuestion.textContent = "";
    const qSpan = document.createElement("span");
    qSpan.textContent = `\\[ ${currentQuestionText} \\]`;
    fsQuestion.append(qSpan);
    renderMath(fsQuestion);
  }
  fsOverlay.hidden = false;
  document.body.classList.add("fs-open");
}

function closeFullscreen() {
  if (fsOverlay) fsOverlay.hidden = true;
  document.body.classList.remove("fs-open");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/* ============================================================================
 * SKILL DEPENDENCY GRAPH
 * ========================================================================== */
function renderSkillTree(nodes, errorIndex = -1, status = "stuck") {
  if (!skillTree) return;
  skillTree.innerHTML = "";
  const clean = (Array.isArray(nodes) && nodes.length ? nodes : ["Understand problem", "Plan steps", "Solve & check"]).slice(0, 5);

  clean.forEach((label, i) => {
    const node = document.createElement("div");
    node.className = "node";
    node.textContent = label;
    if (errorIndex === -1 && status === "correct") node.classList.add("success");
    else if (errorIndex === -1) node.classList.add("active");
    else if (i < errorIndex) node.classList.add("success");
    else if (i === errorIndex) node.classList.add("error", "gap");
    skillTree.appendChild(node);

    if (i < clean.length - 1) {
      const line = document.createElement("div");
      line.className = "connection-line";
      if (errorIndex !== -1 && i >= errorIndex - 1 && errorIndex > 0) {
        if (i >= errorIndex) line.classList.add("error");
        else line.classList.add("success");
      } else if (status === "correct" && errorIndex === -1) line.classList.add("success");
      if (errorIndex !== -1 && i === errorIndex - 1) line.classList.add("error");
      skillTree.appendChild(line);
    }
  });
}

function skillTreeFromDiagnosis(diagnosis) {
  const gap = diagnosis.gap_node || "Final step";
  const base = ["Isolate variable", gap, "Final calculation"];
  const isError = diagnosis.status !== "correct";
  renderSkillTree(base, isError ? 1 : -1, diagnosis.status);
  if (gapLabel) gapLabel.textContent = isError ? `⚠ gap: ${gap}` : "✓ no gap — correct!";
}

/* ============================================================================
 * DIAGNOSTIC PANEL
 * ========================================================================== */
function showDiagnostic(diagnosis) {
  if (!diagPanel) return;
  diagPanel.hidden = false;
  if ($("diagErrorClass")) $("diagErrorClass").textContent = diagnosis.diagnosis;
  if ($("diagAnalysis")) $("diagAnalysis").textContent = diagnosis.simple_explanation;
  if ($("diagTransition")) $("diagTransition").textContent = diagnosis.next_step_hint;
  const st = $("diagStatusLabel");
  if (st) {
    st.textContent = diagnosis.status.toUpperCase();
    st.className = `diag-status ${diagnosis.status}`;
  }
  diagPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ============================================================================
 * DERIVATION RENDERING (optimal solution path)
 * ========================================================================== */
function renderDerivation(full_solution, mode = "full") {
  if (!derivationBox || !derivationList) return;
  const list = Array.isArray(full_solution) ? full_solution : [];
  if (!list.length) { derivationBox.hidden = true; return; }

  let toShow = list;
  let startIndex = 0;

  if (mode === "next") {
    startIndex = Math.min(studentSteps.length, list.length - 1);
    toShow = [list[startIndex]];
    if (derivationTitle) derivationTitle.textContent = `Next Transition — Step ${startIndex + 1} of ${list.length}`;
  } else {
    if (derivationTitle) derivationTitle.textContent = `Optimal Solution Path — ${list.length} steps`;
  }

  derivationList.innerHTML = "";
  toShow.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "derivation-step";
    const num = document.createElement("div");
    num.className = "derivation-step-num";
    const trueIdx = mode === "next" ? startIndex : i;
    num.textContent = trueIdx + 1;
    const body = document.createElement("div");
    body.className = "derivation-step-body";
    const math = document.createElement("div");
    math.className = "derivation-step-math";
    math.textContent = `\\[ ${mathToLatex(String(item.step || ""))} \\]`;
    const expl = document.createElement("div");
    expl.className = "derivation-step-explain";
    expl.textContent = item.explanation || "";
    body.append(math, expl);
    row.append(num, body);
    derivationList.appendChild(row);
    renderMath(math);
  });
  derivationBox.hidden = false;
  derivationBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- Fetch optimal derivation (lazy) ---------- */
async function ensureDerivation() {
  if (lastDerivation.length) return lastDerivation;
  if (analyzing || !isAuthReady()) return [];
  const nextBtn = $("nextTransitionBtn");
  const fullBtn = $("fullDerivationBtn");
  const origNext = nextBtn ? nextBtn.innerHTML : "";
  const origFull = fullBtn ? fullBtn.innerHTML : "";
  try {
    analyzing = true;
    if (nextBtn) { nextBtn.disabled = true; nextBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching…'; }
    if (fullBtn) fullBtn.disabled = true;
    safeSetFooter("Fetching next transition…");

    let memoryText = "No past history. First attempt.";
    try { const mem = await fetchMemory(studentId(), currentTopic); if (mem?.memoryText) memoryText = mem.memoryText; } catch {}

    const lastStep = studentSteps[studentSteps.length - 1] || "";
    const jsVerdict = computeVerdict(lastStep);
    const raw = await diagnoseWithAI(currentTopic, currentQuestionText, [...studentSteps], memoryText, pendingImageBase64 || undefined, jsVerdict);

    let sol = Array.isArray(raw?.full_solution) ? raw.full_solution : [];
    if (!sol.length && raw?.fullSolution) sol = raw.fullSolution;
    if (!sol.length && raw?.next_step_hint) sol = [{ step: raw.next_step_hint, explanation: raw.simple_explanation || "Try this first" }];
    if (!sol.length) throw new Error("No derivation returned");

    lastDerivation = sol
      .map((s) => ({ step: String(s.step || ""), explanation: String(s.explanation || s.reason || "") }))
      .filter((s) => s.step);
    safeSetFooter(`Transition ready · ${lastDerivation.length} steps · ${new Date().toLocaleTimeString()}`);
    return lastDerivation;
  } catch (e) {
    safeSetFooter(`Transition unavailable: ${e.message}`);
    toast(e.message, "error");
    return [];
  } finally {
    analyzing = false;
    if (nextBtn) { nextBtn.disabled = false; nextBtn.innerHTML = origNext || '<i class="fa-solid fa-forward"></i> Reveal Next Transition'; }
    if (fullBtn) { fullBtn.disabled = false; fullBtn.innerHTML = origFull || '<i class="fa-solid fa-book-open"></i> View Complete Derivation'; }
  }
}

/* ============================================================================
 * STEP HIGHLIGHTING (post-diagnosis)
 * ========================================================================== */
function highlightSteps(step_evaluations) {
  const lines = [...mathPad.querySelectorAll(".math-line")];
  lines.forEach((el) => el.classList.remove("step-correct", "step-wrong", "step-cascading"));
  mathPad.querySelectorAll(".step-reason").forEach((el) => el.remove());
  mathPad.classList.remove("has-results");

  if (!Array.isArray(step_evaluations) || !step_evaluations.length) return;
  mathPad.classList.add("has-results");
  setTimeout(() => mathPad.scrollIntoView({ behavior: "smooth", block: "start" }), 60);

  const sorted = [...step_evaluations].sort((a, b) => (a.step_number || 0) - (b.step_number || 0));
  lines.forEach((lineEl, i) => {
    const ev = sorted.find((e) => e.step_number === i + 1) || sorted[i];
    if (!ev) return;
    const ok = ev.is_correct === true;
    const errType = String(ev.error_type || "").toLowerCase();

    if (ok) lineEl.classList.add("step-correct");
    else if (errType === "cascading") lineEl.classList.add("step-cascading");
    else lineEl.classList.add("step-wrong");

    lineEl.title = ev.reason || "";

    const reason = document.createElement("div");
    reason.className = "step-reason" + (ok ? " ok" : "");
    const errTok = mathToLatex(String(ev.error_token || "").trim());
    const fixTok = mathToLatex(String(ev.fix_token || "").trim());

    if (!ok && errTok) {
      reason.innerHTML = "";
      const bad = document.createElement("span");
      bad.className = "err-token";
      bad.textContent = errTok;
      reason.append(document.createTextNode("✕ Only "), bad);
      if (fixTok) {
        const good = document.createElement("span");
        good.className = "fix-token";
        good.textContent = fixTok;
        const arrow = document.createElement("span");
        arrow.textContent = " → should be ";
        reason.append(arrow, good);
      }
      const why = document.createElement("div");
      why.style.marginTop = "4px";
      why.textContent = ev.reason || "Check this small part.";
      reason.appendChild(why);
    } else {
      reason.textContent = (ok ? "✓ " : "✕ ") + (ev.reason || (ok ? "Correct step." : "Check this step."));
    }

    if (!ok) {
      const ruleText = String(ev.rule_to_focus || "").trim();
      if (ruleText) {
        const rule = document.createElement("div");
        rule.style.marginTop = "6px";
        const b = document.createElement("strong");
        b.textContent = "Rule: ";
        rule.append(b, document.createTextNode(ruleText));
        reason.appendChild(rule);
      }
      const methodText = String(ev.correct_method || "").trim();
      if (methodText) {
        const m = document.createElement("div");
        m.style.marginTop = "4px";
        const b = document.createElement("strong");
        b.textContent = "How to fix: ";
        m.append(b, document.createTextNode(methodText));
        reason.appendChild(m);
      }
    }
    lineEl.after(reason);
  });
}

/* ============================================================================
 * IMAGE PATH — transcribe handwritten derivation via LLM
 * ========================================================================== */
async function analyzePhoto(imageBase64) {
  if (analyzing || !isAuthReady()) return;
  analyzing = true;
  setLoading(true);
  safeSetFooter("Transcribing handwritten derivation…");
  try {
    const lastStep = studentSteps[studentSteps.length - 1] || "";
    const jsVerdict = computeVerdict(lastStep);
    const { diagnosis, pastSessions } = await runDiagnosis({
      studentId: studentId(),
      topic: currentTopic,
      steps: [],
      questionText: currentQuestionText,
      imageBase64: imageBase64 || pendingImageBase64,
      jsVerdict
    });

    if (Array.isArray(diagnosis.steps_analyzed) && diagnosis.steps_analyzed.length) {
      studentSteps = [...diagnosis.steps_analyzed];
      if (mathPad) {
        mathPad.innerHTML = "";
        mathPad.appendChild(padEmpty);
        padEmpty.style.display = "none";
        diagnosis.steps_analyzed.forEach((t, i) => {
          const line = document.createElement("div");
          line.className = "math-line";
          const tag = document.createElement("span");
          tag.className = "step-tag";
          tag.innerHTML = `<i class="fa-solid fa-chevron-right" style="font-size:8px;"></i> STEP ${i + 1}`;
          const span = document.createElement("span");
          span.textContent = `\\[ ${mathToLatex(String(t))} \\]`;
          const del = document.createElement("button");
          del.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
          del.addEventListener("click", () => {
            const idx = [...mathPad.querySelectorAll(".math-line")].indexOf(line);
            if (idx > -1) studentSteps.splice(idx, 1);
            if (line.nextElementSibling?.classList.contains("step-reason")) line.nextElementSibling.remove();
            line.remove();
            renumberSteps();
            updateStepsCount();
            if (!studentSteps.length) padEmpty.style.display = "block";
          });
          line.append(tag, span, del);
          mathPad.appendChild(line);
          renderMath(span);
        });
        updateStepsCount();
      }
    }

    if (memoryBadge) memoryBadge.textContent = `${pastSessions.length} past session${pastSessions.length === 1 ? "" : "s"}`;
    highlightSteps(diagnosis.step_evaluations || []);
    lastDerivation = Array.isArray(diagnosis.full_solution) ? diagnosis.full_solution : [];
    if (derivationActions) derivationActions.hidden = !lastDerivation.length;
    if (derivationBox) derivationBox.hidden = true;
    if (fsOverlay && !fsOverlay.hidden) showFsOverlay();

    skillTreeFromDiagnosis(diagnosis);
    showDiagnostic(diagnosis);
    populateWeaknessSelect();
    updateProfileCard();
    safeSetFooter(`Diagnosed · ${diagnosis.status} · ${new Date().toLocaleTimeString()}`);
    toast(`Diagnosis: ${diagnosis.status}`, "success");
  } catch (e) {
    safeSetFooter(`Diagnosis failed: ${e.message}`);
    toast(e.message, "error");
  } finally {
    analyzing = false;
    pendingImageBase64 = null;
    if (photoInput) photoInput.value = "";
    if (imagePreview) imagePreview.src = "";
    if (imagePreviewContainer) imagePreviewContainer.style.display = "none";
    if (btnText) btnText.textContent = "Run Diagnostic";
    setLoading(false);
  }
}

/* ============================================================================
 * MAIN DIAGNOSTIC PASS
 * ========================================================================== */
async function analyzeSteps() {
  if (analyzing || !isAuthReady()) return;

  // Empty state: fetch first transition instead of erroring
  if (!studentSteps.length && !pendingImageBase64) {
    safeSetFooter("Empty trace · fetching initial scaffold…");
    setLoading(true);
    try {
      const sol = await ensureDerivation();
      if (sol.length) renderDerivation(sol, "next");
    } finally {
      setLoading(false);
    }
    return;
  }

  if (pendingImageBase64) return analyzePhoto(pendingImageBase64);

  analyzing = true;
  setLoading(true);
  safeSetFooter("Executing diagnostic pass…");
  try {
    const lastStep = studentSteps[studentSteps.length - 1] || "";
    const jsVerdict = computeVerdict(lastStep);
    const { diagnosis, pastSessions } = await runDiagnosis({
      studentId: studentId(),
      topic: currentTopic,
      steps: [...studentSteps],
      questionText: currentQuestionText,
      imageBase64: pendingImageBase64 || undefined,
      jsVerdict
    });

    if (memoryBadge) memoryBadge.textContent = `${pastSessions.length} past session${pastSessions.length === 1 ? "" : "s"}`;
    highlightSteps(diagnosis.step_evaluations || []);
    lastDerivation = Array.isArray(diagnosis.full_solution) ? diagnosis.full_solution : [];
    if (derivationActions) derivationActions.hidden = !lastDerivation.length;
    if (derivationBox) derivationBox.hidden = true;
    if (fsOverlay && !fsOverlay.hidden) showFsOverlay();

    skillTreeFromDiagnosis(diagnosis);
    showDiagnostic(diagnosis);
    populateWeaknessSelect();
    updateProfileCard();
    safeSetFooter(`Diagnosed · ${diagnosis.status} · ${new Date().toLocaleTimeString()}`);
    toast(`Diagnosis: ${diagnosis.status}`, diagnosis.status === "correct" ? "success" : "info");
  } catch (e) {
    safeSetFooter(`Diagnosis failed: ${e.message}`);
    toast(e.message, "error");
  } finally {
    analyzing = false;
    setLoading(false);
  }
}

/* ============================================================================
 * IMAGE UPLOAD WIRING
 * ========================================================================== */
uploadPhotoBtn?.addEventListener("click", () => photoInput?.click());
photoInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 700000) {
    toast("Image too large (max 700KB). Try smaller photo.", "error");
    photoInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingImageBase64 = ev.target.result;
    if (imagePreview) imagePreview.src = pendingImageBase64;
    if (imagePreviewContainer) imagePreviewContainer.style.display = "block";
    if (btnText) btnText.textContent = "Run Diagnostic";
    safeSetFooter("Image captured · run diagnostic to transcribe");
    toast("Image captured", "success");
  };
  reader.readAsDataURL(file);
});

removePhotoBtn?.addEventListener("click", () => {
  pendingImageBase64 = null;
  if (photoInput) photoInput.value = "";
  if (imagePreview) imagePreview.src = "";
  if (imagePreviewContainer) imagePreviewContainer.style.display = "none";
  if (btnText) btnText.textContent = "Run Diagnostic";
  safeSetFooter("Image cleared");
});

/* ============================================================================
 * SCAFFOLD REVEAL (was: hint)
 * ========================================================================== */
$("revealScaffoldBtn")?.addEventListener("click", () => {
  const reveal = $("scaffoldReveal");
  if (!reveal || !currentQuestionMeta) return;
  reveal.hidden = false;
  reveal.style.display = "block";
  const hintText = currentQuestionMeta.hint || "Try isolating the variable step by step.";
  const answerText = currentQuestionMeta.answer || "";
  reveal.innerHTML = `<div>${escapeHtml(hintText)}</div>`;

  if (answerText) {
    const ansBtn = document.createElement("button");
    ansBtn.className = "btn btn-ghost small";
    ansBtn.style.marginTop = "10px";
    ansBtn.innerHTML = `<i class="fa-solid fa-eye"></i> Reveal reference answer`;
    ansBtn.addEventListener("click", () => {
      const ansDiv = document.createElement("div");
      ansDiv.style.marginTop = "10px";
      ansDiv.style.padding = "8px 10px";
      ansDiv.style.background = "rgba(16,185,129,.08)";
      ansDiv.style.border = "1px solid rgba(16,185,129,.3)";
      ansDiv.style.borderRadius = "8px";
      ansDiv.textContent = `Answer: ${answerText}`;
      if (!reveal.querySelector(".answer-reveal")) {
        ansDiv.className = "answer-reveal";
        reveal.appendChild(ansDiv);
      }
      ansBtn.disabled = true;
      ansBtn.style.opacity = "0.6";
    });
    reveal.appendChild(ansBtn);
  }
});

/* ============================================================================
 * CORE EVENT WIRING
 * ========================================================================== */
topicSearch?.addEventListener("keyup", handleSearch);
topicSearch?.addEventListener("focus", handleSearch);
topicSearch?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && topicSearch.value.trim()) selectTopic(topicSearch.value.trim());
});
answerInput?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    lockStep(answerInput.value);
    answerInput.value = "";
    answerInput.focus();
  }
});

/* ---------- Custom probe ---------- */
async function handleUseCustomQuestion() {
  if (!isAuthReady()) return;
  const userQuery = $("customQuestionInput")?.value.trim();
  if (!userQuery) return;
  const btn = $("useCustomQuestionBtn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting…'; }
  safeSetFooter("Extracting domain…");
  try {
    const extractedTopic = await extractAndSaveTopic(userQuery);
    if (!topicDatabase.includes(extractedTopic)) topicDatabase.push(extractedTopic);
    await selectTopic(extractedTopic);
    setCustomQuestion(userQuery);
  } catch (err) {
    setCustomQuestion(userQuery);
    safeSetFooter(`Domain extraction failed: ${err.message}`);
    toast(err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

$("useCustomQuestionBtn")?.addEventListener("click", handleUseCustomQuestion);
$("customQuestionInput")?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") { e.preventDefault(); handleUseCustomQuestion(); }
});

submitBtn?.addEventListener("click", analyzeSteps);
$("nextTransitionBtn")?.addEventListener("click", async () => {
  const sol = await ensureDerivation();
  if (sol.length) renderDerivation(sol, "next");
  else if (lastDerivation.length) renderDerivation(lastDerivation, "next");
});
$("fullDerivationBtn")?.addEventListener("click", async () => {
  const sol = await ensureDerivation();
  if (sol.length) renderDerivation(sol, "full");
  else if (lastDerivation.length) renderDerivation(lastDerivation, "full");
});
$("hideDerivationBtn")?.addEventListener("click", () => { if (derivationBox) derivationBox.hidden = true; });
$("fullscreenBtn")?.addEventListener("click", openFullscreen);
$("fsClose")?.addEventListener("click", closeFullscreen);
$("clearBtn")?.addEventListener("click", clearSteps);

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFullscreen(); });
document.addEventListener("fullscreenchange", () => {
  const b = $("fullscreenBtn");
  if (b) b.innerHTML = document.fullscreenElement
    ? '<i class="fa-solid fa-compress"></i> Exit Full Screen'
    : '<i class="fa-solid fa-expand"></i> Full Screen';
});
window.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrapper")) dropdown?.classList.remove("show");
});

$("generateQuestionBtn")?.addEventListener("click", handleGenerateQuestion);
$("studentIdInput")?.addEventListener("focus", (e) => e.target.blur());

/* ============================================================================
 * COGNITIVE PROFILE
 * ========================================================================== */
async function updateProfileCard() {
  if (!isAuthReady()) return;
  const sid = studentId();
  if (profileIdBadge) profileIdBadge.textContent = sid.slice(0, 10) + "…";
  if (!profileMasteryBadge || !profileStrengths || !profileWeaknesses) return;
  profileMasteryBadge.textContent = "Loading…";
  profileStrengths.innerHTML = `<li class="empty">Loading…</li>`;
  profileWeaknesses.innerHTML = `<li class="empty">Loading…</li>`;

  try {
    const profile = await getStudentProfile(sid);
    const mastery = profile.mastery || profile.level || "Developing";
    const strengths = Array.isArray(profile.strengths) ? profile.strengths : [];
    const weaknesses = Array.isArray(profile.weaknesses) ? profile.weaknesses : [];
    profileMasteryBadge.textContent = mastery;
    profileStrengths.innerHTML = strengths.length
      ? strengths.slice(0, 5).map((s) => `<li>${escapeHtml(typeof s === "string" ? s : (s.skill || s.name || s.label || String(s)))}</li>`).join("")
      : `<li class="empty">No validated competencies yet</li>`;
    profileWeaknesses.innerHTML = weaknesses.length
      ? weaknesses.slice(0, 5).map((w) => `<li>${escapeHtml(typeof w === "string" ? w : (w.skill || w.name || w.label || String(w)))}</li>`).join("")
      : `<li class="empty">No active gaps — excellent</li>`;
    if (!analyzing) safeSetFooter(`Profile synced · ${sid.slice(0, 6)}… · ${new Date().toLocaleTimeString()}`);
  } catch {
    profileMasteryBadge.textContent = "—";
    profileStrengths.innerHTML = `<li class="empty">Could not load</li>`;
    profileWeaknesses.innerHTML = `<li class="empty">Could not load</li>`;
  }
}

/* ============================================================================
 * BOOT
 * ========================================================================== */
function disableUI() {
  ["submitBtn", "generateQuestionBtn", "topicSearch", "customQuestionInput", "useCustomQuestionBtn"]
    .forEach((id) => { const el = $(id); if (el) el.disabled = true; });
}
function enableUI() {
  ["submitBtn", "generateQuestionBtn", "topicSearch", "customQuestionInput", "useCustomQuestionBtn"]
    .forEach((id) => { const el = $(id); if (el) el.disabled = false; });
}

async function initApp() {
  disableUI();
  try {
    currentUid = await ensureAuth();
    const input = $("studentIdInput");
    if (input) { input.value = currentUid; input.readOnly = true; }
    if (profileIdBadge) profileIdBadge.textContent = currentUid.slice(0, 10) + "…";
    await Promise.all([populateWeaknessSelect(), updateProfileCard()]);
    try {
      const saved = await fetchSavedTopics();
      saved.forEach((t) => {
        if (typeof t === "string" && t.trim() && !topicDatabase.includes(t)) topicDatabase.push(t);
      });
    } catch {}
  } catch (err) {
    safeSetFooter(err.code === "auth/operation-not-allowed"
      ? "⚠ Enable Anonymous Auth in Firebase Console"
      : `Auth failed: ${err.message}`);
    return;
  }

  enableUI();
  const sa = $("derivationActions");
  if (sa) sa.hidden = false;

  applyQuestionMeta(null);
  renderMath($("problemDisplay"));
}

(async () => {
  const sa = $("derivationActions");
  if (sa) sa.hidden = false;
  await initApp();
})();