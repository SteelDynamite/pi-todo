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

type TodoState = "pending" | "done" | "failed";
type TodoAction = "list" | "add" | "complete" | "clear";

interface Todo {
	id: number;
	text: string;
	state: TodoState;
}

interface TodoDetails {
	action: TodoAction | "toggle";
	todos: Todo[];
	nextId: number;
	added?: Todo[];
	completed?: Todo;
	error?: string;
}

type LegacyTodo = Partial<Todo> & { id?: number; text?: string; done?: boolean };

type Theme = {
	fg(color: string, text: string): string;
	strikethrough(text: string): string;
};

type WidgetTui = { terminal: { columns: number }; requestRender(): void };

type UICtx = {
	setWidget(
		key: string,
		content: undefined | ((tui: WidgetTui, theme: Theme) => { render(): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "complete", "clear"] as const),
	items: Type.Optional(Type.Array(Type.String(), { description: "Todo texts to add. Required for add; an array of one is valid.", minItems: 1 })),
	replace: Type.Optional(Type.Boolean({ description: "For add: replace the current list instead of appending to it" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for complete)" })),
	state: Type.Optional(StringEnum(["done", "failed"] as const, { description: "Completion state for complete" })),
});

const MAX_VISIBLE_TODOS = 10;
const IN_PROGRESS_FRAMES = ["▹", "▸", "▶", "▸"];
const DONE_ICON = "✓";
const FAILED_ICON = "✗";
const GREEN_FG = "\x1b[32m";
const RESET_FG = "\x1b[39m";
const AUTO_HIDE_AFTER_TURNS = 4;
const DEBUG = !!process.env.PI_TODO_DEBUG;

function debug(...args: unknown[]): void {
	if (DEBUG) console.error("[pi-todo]", ...args);
}

/** Force terminal-green for completed checkmarks, independent of theme success color. */
function green(text: string): string {
	return `${GREEN_FG}${text}${RESET_FG}`;
}

function normalizeTodo(todo: LegacyTodo): Todo | undefined {
	if (typeof todo.id !== "number" || typeof todo.text !== "string") return undefined;
	const state: TodoState = todo.state === "done" || todo.state === "failed" || todo.state === "pending"
		? todo.state
		: todo.done
			? "done"
			: "pending";
	return { id: todo.id, text: todo.text, state };
}

function cloneTodos(todos: Todo[]): Todo[] {
	return todos.map((todo) => ({ ...todo }));
}

function isTerminal(todo: Todo): boolean {
	return todo.state === "done" || todo.state === "failed";
}

class TodoWidget {
	private uiCtx: UICtx | undefined;
	private tui: WidgetTui | undefined;
	private widgetRegistered = false;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private agentActive = false;

	constructor(
		private getTodos: () => Todo[],
		private isHidden: () => boolean,
	) {}

	setUICtx(ctx: UICtx): void {
		this.uiCtx = ctx;
	}

	setAgentActive(active: boolean): void {
		this.agentActive = active;
		this.syncTimer();
		this.update();
	}

	update(): void {
		if (!this.uiCtx) return;
		const todos = this.getTodos();
		const shouldHide = todos.length === 0 || this.isHidden();

		if (shouldHide) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget("todo", undefined);
				this.widgetRegistered = false;
			}
			this.syncTimer();
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

		this.syncTimer();
	}

	dispose(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
		if (this.uiCtx) this.uiCtx.setWidget("todo", undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private syncTimer(): void {
		const hasImpliedActiveTodo = this.getTodos().some((todo) => !isTerminal(todo));
		const shouldAnimate = this.agentActive && hasImpliedActiveTodo && !this.isHidden();
		if (shouldAnimate && !this.interval) {
			this.interval = setInterval(() => {
				this.frame++;
				this.tui?.requestRender();
			}, 150);
		} else if (!shouldAnimate && this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	private renderWidget(tui: WidgetTui, theme: Theme): string[] {
		const todos = this.getTodos();
		if (todos.length === 0 || this.isHidden()) return [];

		const width = tui.terminal.columns;
		const done = todos.filter((todo) => todo.state === "done").length;
		const failed = todos.filter((todo) => todo.state === "failed").length;
		const pending = todos.length - done - failed;
		const lines = [truncateToWidth(theme.fg("accent", `● ${todos.length} todo(s), ${done} done, ${failed} failed, ${pending} pending`), width)];
		const impliedActiveId = this.agentActive ? todos.find((todo) => !isTerminal(todo))?.id : undefined;

		for (const todo of todos.slice(0, MAX_VISIBLE_TODOS)) {
			const isImpliedActive = todo.id === impliedActiveId;
			let icon: string;
			if (todo.state === "done") icon = green(DONE_ICON);
			else if (todo.state === "failed") icon = theme.fg("error", FAILED_ICON);
			else if (isImpliedActive) icon = theme.fg("accent", IN_PROGRESS_FRAMES[this.frame % IN_PROGRESS_FRAMES.length]);
			else icon = theme.fg("dim", "○");

			const id = theme.fg("dim", `#${todo.id}`);
			let text = todo.text;
			if (todo.state === "done") text = theme.fg("dim", theme.strikethrough(todo.text));
			else if (todo.state === "failed") text = theme.fg("error", todo.text);
			else if (isImpliedActive) text = theme.fg("accent", `${todo.text}…`);
			lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
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
	let currentTurn = 0;
	let allTerminalSinceTurn: number | undefined;
	let widgetHidden = false;
	const widget = new TodoWidget(() => todos, () => widgetHidden);

	const allTodosTerminal = () => todos.length > 0 && todos.every(isTerminal);

	const refreshAutoHideState = (source: string) => {
		const wasHidden = widgetHidden;
		if (!allTodosTerminal()) {
			if (allTerminalSinceTurn !== undefined || widgetHidden) {
				debug(source, "auto-hide reset", { currentTurn, allTerminalSinceTurn, widgetHidden, todos: todos.length });
			}
			allTerminalSinceTurn = undefined;
			widgetHidden = false;
			return;
		}
		allTerminalSinceTurn ??= currentTurn;
		const elapsed = currentTurn - allTerminalSinceTurn;
		if (elapsed >= AUTO_HIDE_AFTER_TURNS) widgetHidden = true;
		debug(source, "auto-hide check", { currentTurn, allTerminalSinceTurn, elapsed, threshold: AUTO_HIDE_AFTER_TURNS, hidden: widgetHidden });
		if (!wasHidden && widgetHidden) debug(source, "auto-hide triggered");
	};

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

			const details = msg.details as Partial<TodoDetails> | undefined;
			if (Array.isArray(details?.todos)) {
				todos = details.todos.map(normalizeTodo).filter((todo): todo is Todo => !!todo);
				if (typeof details.nextId === "number") nextId = details.nextId;
				else nextId = Math.max(1, ...todos.map((todo) => todo.id + 1));
			}
		}
		refreshAutoHideState("reconstructState");
	};

	pi.on("session_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		currentTurn = 0;
		allTerminalSinceTurn = undefined;
		widgetHidden = false;
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

	pi.on("agent_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		widget.setAgentActive(true);
	});

	pi.on("turn_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		currentTurn++;
		refreshAutoHideState("turn_start");
		debug("turn_start", { currentTurn, allTerminalSinceTurn, widgetHidden });
		widget.update();
	});

	pi.on("agent_end", async () => {
		widget.setAgentActive(false);
		refreshAutoHideState("agent_end");
		debug("agent_end", { currentTurn, allTerminalSinceTurn, widgetHidden });
		widget.update();
	});

	pi.on("session_shutdown", async () => {
		widget.dispose();
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (items array, replace boolean), complete (id, state done/failed), clear",
		promptSnippet: "List, add, complete, fail, or clear todos in the current branch-aware todo list",
		promptGuidelines: [
			"Use todo to track multi-step work when a lightweight checklist would help.",
			"For todo add, always pass items as an array, even for one item.",
			"For todo add, set replace=true when creating a fresh plan for a new user request or when the existing list is obsolete.",
			"For todo add, omit replace or set replace=false when adding follow-up work to an existing relevant list.",
			"Do not create an in-progress todo state; pi-todo automatically treats the top pending todo as in progress while the agent is active.",
			"Use todo complete with state=done for successful tasks and state=failed for tasks that cannot be completed.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			widget.setUICtx(ctx.ui as UICtx);

			switch (params.action) {
				case "list": {
					widgetHidden = false;
					widget.update();
					return {
						content: [
							{
								type: "text" as const,
								text: todos.length
									? todos.map((todo) => `[${todo.state}] #${todo.id}: ${todo.text}`).join("\n")
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

					if (params.replace) {
						todos = [];
						nextId = 1;
					}

					const added = params.items.map((text) => {
						const todo: Todo = { id: nextId++, text, state: "pending" };
						todos.push(todo);
						return todo;
					});

					allTerminalSinceTurn = undefined;
					widgetHidden = false;
					widget.update();
					const noun = added.length === 1 ? "todo" : "todos";
					const verb = params.replace ? "Replaced list and added" : "Added";
					return {
						content: [
							{
								type: "text" as const,
								text: `${verb} ${added.length} ${noun}:\n${added.map((todo) => `#${todo.id}: ${todo.text}`).join("\n")}`,
							},
						],
						details: snapshot("add", { added: cloneTodos(added) }),
					};
				}

				case "complete": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for complete" }],
							details: snapshot("complete", { error: "id required" }),
						};
					}
					if (params.state !== "done" && params.state !== "failed") {
						return {
							content: [{ type: "text" as const, text: "Error: state must be done or failed" }],
							details: snapshot("complete", { error: "state must be done or failed" }),
						};
					}
					const todo = todos.find((item) => item.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text" as const, text: `Todo #${params.id} not found` }],
							details: snapshot("complete", { error: `#${params.id} not found` }),
						};
					}
					todo.state = params.state;
					refreshAutoHideState("complete");
					widget.update();
					return {
						content: [{ type: "text" as const, text: `Todo #${todo.id} marked ${todo.state}` }],
						details: snapshot("complete", { completed: { ...todo } }),
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					allTerminalSinceTurn = undefined;
					widgetHidden = false;
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
			if (args.replace) text += ` ${theme.fg("warning", "replace")}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.state) text += ` ${theme.fg(args.state === "failed" ? "error" : "success", args.state)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details?.action) {
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
						const icon = todo.state === "done" ? green(DONE_ICON) : todo.state === "failed" ? theme.fg("error", FAILED_ICON) : theme.fg("dim", "○");
						const itemText = todo.state === "done" ? theme.fg("dim", todo.text) : todo.state === "failed" ? theme.fg("error", todo.text) : theme.fg("muted", todo.text);
						listText += `\n${icon} ${theme.fg("accent", `#${todo.id}`)} ${itemText}`;
					}
					if (!expanded && details.todos.length > 5) listText += `\n${theme.fg("dim", `... ${details.todos.length - 5} more`)}`;
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = details.added ?? [];
					if (added.length === 0) return new Text(green(DONE_ICON) + theme.fg("success", " Added todos"), 0, 0);
					let text = green(DONE_ICON) + theme.fg("success", ` Added ${added.length} todo(s)`);
					const display = expanded ? added : added.slice(0, 5);
					for (const todo of display) text += `\n${theme.fg("accent", `#${todo.id}`)} ${theme.fg("muted", todo.text)}`;
					if (!expanded && added.length > 5) text += `\n${theme.fg("dim", `... ${added.length - 5} more`)}`;
					return new Text(text, 0, 0);
				}

				case "complete": {
					const todo = details.completed;
					if (!todo) return new Text(green(DONE_ICON) + theme.fg("success", " Completed todo"), 0, 0);
					const color = todo.state === "failed" ? "error" : "success";
					const icon = todo.state === "failed" ? theme.fg("error", FAILED_ICON) : green(DONE_ICON);
					return new Text(icon + theme.fg(color, ` #${todo.id} ${todo.state}`) + " " + theme.fg("muted", todo.text), 0, 0);
				}

				case "clear":
					return new Text(green(DONE_ICON) + " " + theme.fg("muted", "Cleared all todos"), 0, 0);

				case "toggle":
					return new Text(green(DONE_ICON) + theme.fg("success", " Updated todo"), 0, 0);

				default: {
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "", 0, 0);
				}
			}
		},
	});
}
