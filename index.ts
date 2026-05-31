/**
 * Todo Extension - Stateful branch-aware todos with an always-visible widget.
 *
 * This extension registers a `todo` tool for the LLM to manage todos.
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	added?: Todo[];
	error?: string;
}

type Theme = {
	fg(color: string, text: string): string;
	strikethrough(text: string): string;
};

type UICtx = {
	setWidget(
		key: string,
		content: undefined | ((tui: { terminal: { columns: number }; requestRender(): void }, theme: Theme) => { render(): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	items: Type.Optional(Type.Array(Type.String(), { description: "Todo texts to add. Required for add; an array of one is valid.", minItems: 1 })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

const MAX_VISIBLE_TODOS = 10;

function cloneTodos(todos: Todo[]): Todo[] {
	return todos.map((todo) => ({ ...todo }));
}

class TodoWidget {
	private uiCtx: UICtx | undefined;
	private tui: { requestRender(): void } | undefined;
	private widgetRegistered = false;

	constructor(private getTodos: () => Todo[]) {}

	setUICtx(ctx: UICtx): void {
		this.uiCtx = ctx;
	}

	update(): void {
		if (!this.uiCtx) return;
		const todos = this.getTodos();

		if (todos.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget("todo", undefined);
				this.widgetRegistered = false;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				"todo",
				(tui, theme) => {
					this.tui = tui;
					return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget("todo", undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private renderWidget(tui: { terminal: { columns: number } }, theme: Theme): string[] {
		const todos = this.getTodos();
		if (todos.length === 0) return [];

		const width = tui.terminal.columns;
		const done = todos.filter((todo) => todo.done).length;
		const lines = [truncateToWidth(theme.fg("accent", `● ${todos.length} todo(s), ${done} done`), width)];

		for (const todo of todos.slice(0, MAX_VISIBLE_TODOS)) {
			const check = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
			const id = theme.fg("dim", `#${todo.id}`);
			const text = todo.done ? theme.fg("dim", theme.strikethrough(todo.text)) : todo.text;
			lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
		}

		if (todos.length > MAX_VISIBLE_TODOS) {
			lines.push(truncateToWidth(theme.fg("dim", `    … and ${todos.length - MAX_VISIBLE_TODOS} more`), width));
		}

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	const widget = new TodoWidget(() => todos);

	const snapshot = (action: TodoDetails["action"], extra: Partial<TodoDetails> = {}): TodoDetails => ({
		action,
		todos: cloneTodos(todos),
		nextId,
		...extra,
	});

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = cloneTodos(details.todos);
				nextId = details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		reconstructState(ctx);
		widget.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		reconstructState(ctx);
		widget.update();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		widget.update();
	});

	pi.on("session_shutdown", async () => {
		widget.dispose();
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (items array), toggle (id), clear",
		promptSnippet: "List, add, toggle, or clear todos in the current branch-aware todo list",
		promptGuidelines: [
			"Use todo to track multi-step work when a lightweight checklist would help.",
			"For todo add, always pass items as an array, even for one item.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			widget.setUICtx(ctx.ui as UICtx);

			switch (params.action) {
				case "list": {
					widget.update();
					return {
						content: [
							{
								type: "text" as const,
								text: todos.length
									? todos.map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`).join("\n")
									: "No todos",
							},
						],
						details: snapshot("list"),
					};
				}

				case "add": {
					if (!Array.isArray(params.items) || params.items.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: items array required for add" }],
							details: snapshot("add", { error: "items array required" }),
						};
					}

					const added = params.items.map((text) => {
						const todo: Todo = { id: nextId++, text, done: false };
						todos.push(todo);
						return todo;
					});

					widget.update();
					const noun = added.length === 1 ? "todo" : "todos";
					return {
						content: [
							{
								type: "text" as const,
								text: `Added ${added.length} ${noun}:\n${added.map((todo) => `#${todo.id}: ${todo.text}`).join("\n")}`,
							},
						],
						details: snapshot("add", { added: cloneTodos(added) }),
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for toggle" }],
							details: snapshot("toggle", { error: "id required" }),
						};
					}
					const todo = todos.find((item) => item.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text" as const, text: `Todo #${params.id} not found` }],
							details: snapshot("toggle", { error: `#${params.id} not found` }),
						};
					}
					todo.done = !todo.done;
					widget.update();
					return {
						content: [{ type: "text" as const, text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: snapshot("toggle"),
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					widget.update();
					return {
						content: [{ type: "text" as const, text: `Cleared ${count} todos` }],
						details: snapshot("clear"),
					};
				}
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (Array.isArray(args.items)) text += ` ${theme.fg("dim", `${args.items.length} item(s)`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			switch (details.action) {
				case "list": {
					if (details.todos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					let listText = theme.fg("muted", `${details.todos.length} todo(s):`);
					const display = expanded ? details.todos : details.todos.slice(0, 5);
					for (const todo of display) {
						const check = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = todo.done ? theme.fg("dim", todo.text) : theme.fg("muted", todo.text);
						listText += `\n${check} ${theme.fg("accent", `#${todo.id}`)} ${itemText}`;
					}
					if (!expanded && details.todos.length > 5) listText += `\n${theme.fg("dim", `... ${details.todos.length - 5} more`)}`;
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = details.added ?? [];
					if (added.length === 0) return new Text(theme.fg("success", "✓ Added todos"), 0, 0);
					let text = theme.fg("success", `✓ Added ${added.length} todo(s)`);
					const display = expanded ? added : added.slice(0, 5);
					for (const todo of display) text += `\n${theme.fg("accent", `#${todo.id}`)} ${theme.fg("muted", todo.text)}`;
					if (!expanded && added.length > 5) text += `\n${theme.fg("dim", `... ${added.length - 5} more`)}`;
					return new Text(text, 0, 0);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});
}
