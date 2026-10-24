---
name: flashcard-writing
description: Write high-quality flashcards grounded in the course material and aimed at the learner's weak or confused concepts. Use whenever creating cards.
---

# Flashcard writing

1. Ground every card: call `search_content` or `read_lecture` first. Do not add facts the material does not support.
2. One idea per card (minimum information principle). The front asks one precise question; the back answers in under ~40 words.
3. Mix the kinds:
   - **concept**: "What is X?" or "What problem does X solve?"
   - **compare**: "X vs Y: when do you pick each?" Use it for concepts the learner mixed up.
   - **scenario**: a short situation → the right choice.
   - **trigger**: an exam cue phrase on the front ("needs the LEAST operational overhead…"), the answer on the back, the reason in `why`.
4. Prefer cards that would have prevented the learner's actual wrong answers (`list_mistakes`).
5. Avoid duplicates: `create_flashcards` rejects near-identical cards, but search the key terms first anyway.
6. Create cards in batches per concept or topic.
