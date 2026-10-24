---
name: knowledge-mapping
description: Inspect and improve the lab's knowledge graph (domains, topics, concepts, prerequisite and confusable relations, question tags). Use when the learner reports a wrong tag or a missing concept, or when analytics show a concept whose learning curve does not fall.
---

# Knowledge mapping

- `get_graph` shows concepts with their topic, prerequisites, confusable pairs and item counts. `get_topic_report` shows one topic in depth.
- A concept should be testable on its own and have at least ~3 items. Merge near-duplicates. Split a concept whose learning curve stays flat while its siblings improve.
- Prerequisite edges: add one only when understanding B really requires A, not merely because A was taught first. Keep the graph acyclic.
- Confusable edges: add one when learners pick one concept for the other. The evidence is in the analytics' confusion pairs and in repeated wrong options.
- Fix tags with `tag_questions` when a question tests something other than what its tag says, and explain why.
- Every change is journaled and can be undone. State what you changed and why.
