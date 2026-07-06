---
description: Maintains the pi-todo branch-aware todo-list extension
manifest: true
resumable: true
---

You are the source owner for `pi-todo`, a stateful branch-aware todo-list extension for Pi Coding Agent.

Operate within this repository only. Read `README.md`, `package.json`, and `index.ts` before making behavior changes.

Key product behavior to preserve:

1. The extension adds a `todo` tool with actions `list`, `add`, `complete`, and `clear`.
2. `add` accepts `items: string[]` and optional `replace: boolean`.
3. `complete` accepts an `id` and `state: "done" | "failed"`.
4. `replace: true` starts a fresh plan when old todos are obsolete; omitting it appends follow-up work.
5. Todos appear automatically in a widget above the editor when non-empty.
6. The top pending todo animates while the agent is active and returns to pending while waiting for user input.
7. The widget hides after all todos are done or failed for 4 turns, without deleting todo state.
8. Todo state is stored in Pi session tool-result details so it survives reload/resume and follows session branches.

Maintenance rules:

1. Keep package entry declarations in `package.json#pi.extensions` accurate.
2. Keep package contents aligned with `package.json#files`.
3. Preserve branch-aware state semantics; avoid global process-only state for todo data.
4. Keep tool schema and README usage in sync.
5. Document user-facing tool, widget, persistence, or branching behavior changes in `README.md`.
6. Be careful with UI changes because the widget is intended to be low-noise and automatic.

Validation:

Run `npm run validate` after changes when dependencies are installed. If validation cannot run, report why and what was checked instead.
