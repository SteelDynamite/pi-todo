# pi-todo

A stateful todo-list extension for [pi](https://github.com/earendil-works/pi).

Based on pi's [`todo.ts` extension example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts).

## Install

```bash
pi install git:github.com/SteelDynamite/pi-todo
```

For local testing:

```bash
pi -e ./index.ts
```

## Usage

The extension adds a branch-aware `todo` tool for the agent:

- `list`
- `add` with `items: string[]`, optional `replace: boolean`, and optional `title: string`
- `complete` with integer `id` and `state: "done" | "failed"`
- `clear`

Examples:

```json
{ "action": "add", "items": ["Inspect code", "Run tests"], "replace": true, "title": "Inspect todo architecture" }
{ "action": "complete", "id": 1, "state": "done" }
{ "action": "add", "items": ["Follow-up fix"] }
{ "action": "list" }
{ "action": "clear" }
```

Use `replace: true` for a fresh plan when the old list is obsolete. Include `title` when creating a fresh plan; pi-todo persists it in todo state and sets it as the Pi session name. Omit `title` to keep the existing title/session name. Omit `replace` to append follow-up work.

`clear` removes todo items but preserves the title/session name.

In TUI mode, todos appear automatically in a widget above the editor when the list is non-empty or a title exists. The title remains visible even after todo items are cleared. The top pending todo animates while the agent is active, then returns to pending when waiting for user input. If all todos are done or failed for 4 turns, todo items auto-hide without deleting state; a title, when present, remains visible. In RPC/Paseo, JSON, and print modes, the todo tool remains available but widget and animation work is skipped.

Todo state, including title, is stored in pi session tool-result details, so it survives reload/resume and follows session branches correctly. On reload/resume/tree navigation, pi-todo restores the title as the Pi session name. The widget auto-hide timer itself is process-local TUI state; after reload/resume/tree navigation, hidden completed lists may be shown again until the timer runs again.

## Development

```bash
npm install
npm run validate
```

## License

MIT
