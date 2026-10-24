---
name: question-writing
description: Write exam-style multiple-choice questions with plausible distractors built from the learner's misconceptions and a rationale for every option. Use whenever creating practice questions.
---

# Question writing

1. Ground the question in the material (`search_content`, `read_lecture`). The correct answer must be supported by a specific passage.
2. Stem: a realistic scenario containing the constraint that decides the answer (cost, latency, least effort, compliance…). Ask one clear question. Avoid negatives unless the exam uses them; when it does, write NOT in capitals.
3. Options:
   - 3–5 options of similar length and grammar.
   - Mutually exclusive; no "all/none of the above".
   - No clues in the wording.
   - Exactly as many correct answers as the stem says.
4. Distractors come from **real** confusions: options the learner picked wrongly before (`list_mistakes`) and concepts marked confusable. Each must be wrong for a reason the learner can learn.
5. Rationales: one per option, saying why it is right or why it fails *in this scenario*.
6. Before saving, check:
   - Is the key unambiguous?
   - Could an expert argue for another option?
   - Can the question be answered without reading the scenario?
7. Save with `create_questions`, attaching the concept or topic it tests.
