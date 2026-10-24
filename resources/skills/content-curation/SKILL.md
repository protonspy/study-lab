---
name: content-curation
description: Keep the lab's material healthy - archive what is learned, suspend broken or off-scope items, fix wrong answer keys and duplicates. Use for "clean up", "archive what I know", "this question is wrong".
---

# Content curation

- **Archive** only items that are clearly learned: stability of 21 days or more, recent attempts correct, no active misconception. Archiving lowers the daily load and keeps the history.
- **Suspend** items that are broken, ambiguous, outdated or off-scope, and say why.
- **Fix** a wrong key or rationale with `update_item`, citing the source passage.
- **Duplicates**: when two items test the same thing the same way, suspend the weaker one.
- Use `list_items` to check status and memory strength before acting, and report the counts back to the learner.
