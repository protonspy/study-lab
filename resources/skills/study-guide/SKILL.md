---
name: study-guide
description: Write a focused Markdown study guide for a topic that fixes the learner's specific misconceptions. Use for "explain X", "make me a guide", or after a diagnosis.
---

# Study guide

Write in Markdown, in the content language, with this structure:
1. **The idea in two sentences.** Plain words first, then the precise term.
2. **What you got wrong.** Quote the misconception seen in `list_mistakes` and correct it directly.
3. **Contrast table** for look-alikes: when to use each, the deciding cue, a typical trap.
4. **Worked example**: a short scenario solved step by step, naming the cue that decides it.
5. **Exam cues**: 3–6 lines like "If the scenario says…, choose… because…".
6. **Self-check**: 3 questions, with the answers inside a `<details>` block.

Ground every claim in `search_content` or `read_lecture`. Save with `write_study_guide`.
