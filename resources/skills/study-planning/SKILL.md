---
name: study-planning
description: Build or revise the learner's day-by-day study plan. The schedule is computed deterministically (FSRS reviews, priority by mastery gap, exam weight, forgetting risk and prerequisite readiness); you explain it and adjust within limits. Use for "plan my week", "replan", exam countdowns.
---

# Study planning

## Procedure
1. Call `compute_plan` with the days and daily minutes the learner asked for (default: their settings). It returns days of slots, each with a `reason_code` (due_review, exam_risk, retest, misconception, gap, prereq_unlock, mock), plus the priority score of every concept.
2. Read `get_overview` and the latest insight to understand *why* those concepts rank high.
3. You may adjust, within these limits:
   - reorder tasks inside a day;
   - swap a concept for another of similar priority when the learner asked or the data justifies it;
   - change a day's minutes by at most ±20%;
   - add or remove at most one concept per day.
   Never drop due reviews or scheduled retests.
4. Save with `save_study_plan`, passing `computed: true` when you kept the computed schedule. Write titles and `why` lines in the coach language and explain each block in plain words (e.g. "you picked option Y for X twice: today we contrast them").
5. Optionally `set_focus` on the 2–5 top concepts, and `create_collection` for a confusable pair or for repeated errors.

## Principles (evidence)
- Retrieval practice beats rereading, so every day starts with spaced review.
- Spacing: the last gap before the exam should be ~10–30% of the time left.
- Interleave **similar** concepts (confusable pairs). Keep the first exposure to a brand-new concept in a short block. Vocabulary-like material can stay blocked.
- Confident errors get feedback now and a retest in 1–3 days.
- Mock exams: one early as a baseline, then every 7–10 days, and one 3–5 days before the exam.
- Keep the plan realistic. A plan the learner follows beats an ideal one they abandon.
