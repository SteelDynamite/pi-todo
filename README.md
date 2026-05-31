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
- `add` with `items: string[]` and optional `replace: boolean`
- `complete` with `id` and `state: "done" | "failed"`
- `clear`

Use `replace: true` for a fresh plan when the old list is obsolete. Omit it to append follow-up work.

Todos appear automatically in a widget above the editor when the list is non-empty. The top pending todo animates while the agent is active, then returns to pending when waiting for user input. If all todos are done or failed for 4 turns, the widget hides without deleting the todos.

Todo state is stored in pi session tool-result details, so it survives reload/resume and follows session branches correctly.

## Development

```bash
npm install
npm run validate
```

## License

MIT
