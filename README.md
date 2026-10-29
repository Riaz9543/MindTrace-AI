# MindTrace — Agentic Cognitive Diagnostic Engine

> **Trace the thinking, not just the answer.**

MindTrace is a production-grade diagnostic engine for mathematics education, built for the **Meta Global AI Hackathon 2026**. It moves beyond simple answer-checking by analyzing a student's *workflow trace*—every committed step, transformation, and final answer—to produce a structured **Cognitive Diagnostic Report** with error classifications, conceptual breakdowns, and the next optimal transition.

The system combines a deterministic math referee (to prevent LLM hallucination) with Meta's `muse` models, a Firebase-backed cognitive profile, and a secure serverless proxy that keeps API keys out of the client.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Workflow Trace Analysis** | Students commit step-by-step transformations; the engine diagnoses the *process*, not just the result. |
| **Deterministic Math Referee** | A JavaScript equivalence checker (`checkMathEquivalence`) compares the student's final answer numerically before the LLM is invoked, injecting ground truth to prevent false "correct" verdicts. |
| **Adaptive Probe Generation** | Generates targeted practice questions based on the student's identified gaps and mastery level. |
| **Cognitive Profile & Skill Graph** | Persistent, Firebase-backed profile tracking validated competencies and skill gaps, synced after every diagnostic pass. |
| **Handwritten Derivation Upload** | Accepts image uploads (max 600KB) via a secure proxy for multimodal analysis. |
| **Secure Serverless Proxy** | All model calls route through `/api/proxy` (Vercel/Netlify function); the API key never reaches the browser. |
| **Anonymous, Session-Isolated Auth** | Firebase anonymous authentication—no email required, session-isolated by default. |
| **Mobile-Responsive UI** | Dark-mode design with 44px minimum touch targets, safe-area insets, and responsive breakpoints. |

---
