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
- `add` with `items: string[]` (use an array even for one todo)
- `toggle` with `id`
- `clear`

Todos appear automatically in a widget above the editor when the list is non-empty.

Todo state is stored in pi session tool-result details, so it survives reload/resume and follows session branches correctly.

## Development

```bash
npm install
npm run validate
```

## License

MIT
