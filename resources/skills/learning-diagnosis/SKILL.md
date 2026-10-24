---
name: learning-diagnosis
description: Diagnose how the learner is learning from analytics and real mistakes (gaps, misconceptions, forgetting, rushing, calibration, confusable concepts) and save an evidence-backed insight report. Use for "analyse my learning", "why do I keep failing X", weekly reviews.
---

# Learning diagnosis

## Procedure
1. Call `get_overview` first. With fewer than ~50 answers, say the evidence is thin and keep claims tentative.
2. For the 3–5 weakest concepts or topics, and every one with an active misconception, call `get_topic_report` and `list_mistakes`.
3. Read the actual wrong answers: the option picked, its rationale, the confidence and the time taken. Classify each pattern:
   - **gap**: low accuracy across the concept, no particular wrong option → teach it.
   - **misconception**: the same wrong option, or the same look-alike concept, picked twice or more, often with confidence → contrast it explicitly and retest in 1–3 days.
   - **forgetting**: right before, wrong after days (low retrievability) → more spaced retrieval, not re-teaching.
   - **slip**: mastered concept, new wrong option, low confidence → no action.
   - **rushing**: answers far faster than the reading time, with low accuracy → slow down.
   - **confusion**: the wrong option belongs to a concept marked confusable with the right one → interleave the pair.
4. Check calibration: is "sure" mostly right? Confident errors are the most valuable to fix, with immediate feedback and a retest.
5. Call `save_insight_report` exactly once.

## Rules
- Every insight cites evidence: numbers, question ids, concept or topic ids. Never infer what the data does not show.
- Prefer 3–6 sharp insights over many vague ones. Each `detail` says what the data shows **and** what to do.
- `next` actions must be concrete and doable in the app: practise concept X, review the confusable pair Y/Z, take a mock exam, slow down on long stems.
- Write the report in the coach language.
