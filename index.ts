/**
 * Todo Extension - Stateful branch-aware todos with an always-visible widget.
 *
 * This extension registers a `todo` tool for the LLM to manage todos.
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	addTodos,
	clearTodos,
	completeTodo,
	createTodoModel,
	isTerminal,
	isTodoAction,
	reconstructTodoModelFromBranch,
	snapshot,
	type Todo,
	type TodoDetails,
	type TodoModel,
} from "./src/todo-core.ts";
import { green, IN_PROGRESS_FRAMES, DONE_ICON, FAILED_ICON, todoIcon, todoResultText, todoSummary, todoText } from "./src/todo-format.ts";

const ListParams = Type.Object({ action: StringEnum(["list"] as const) });
const ClearParams = Type.Object({ action: StringEnum(["clear"] as const) });
const AddParams = Type.Object({
	action: StringEnum(["add"] as const),
	items: Type.Array(Type.String(), { description: "Todo texts to add. An array of one is valid.", minItems: 1 }),
	replace: Type.Optional(Type.Boolean({ description: "Replace the current list instead of appending" })),
});
const CompleteParams = Type.Object({
	action: StringEnum(["complete"] as const),
	id: Type.Integer({ description: "Todo ID" }),
	state: StringEnum(["done", "failed"] as const, { description: "Completion state" }),
});
const TodoParams = Type.Union([ListParams, AddParams, CompleteParams, ClearParams]);
type TodoParams = Static<typeof TodoParams>;

const MAX_VISIBLE_TODOS = 10;
const AUTO_HIDE_AFTER_TURNS = 4;

function isCurrentTodo(todo: unknown): todo is Todo {
	const item = todo as Partial<Todo> | undefined;
	return !!item && Number.isInteger(item.id) && typeof item.text === "string" && (item.state === "pending" || item.state === "done" || item.state === "failed");
}

function renderableDetails(details: unknown): TodoDetails | undefined {
	const value = details as Partial<TodoDetails> | undefined;
	if (!value || !isTodoAction(value.action) || !Array.isArray(value.todos) || typeof value.nextId !== "number") return undefined;
	if (!value.todos.every(isCurrentTodo)) return undefined;
	if (value.added && !value.added.every(isCurrentTodo)) return undefined;
	if (value.completed && !isCurrentTodo(value.completed)) return undefined;
	return value as TodoDetails;
}

class TodoWidget {
	private uiCtx: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private widgetRegistered = false;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private agentActive = false;

	constructor(
		private getTodos: () => Todo[],
		private isHidden: () => boolean,
	) {}

	setUICtx(ctx: ExtensionUIContext): void {
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
				(tui, theme): Component => {
					this.tui = tui;
					return { render: (width: number) => this.renderWidget(width, theme), invalidate: () => {} };
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
		this.uiCtx?.setWidget("todo", undefined);
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

	private renderWidget(width: number, theme: Theme): string[] {
		const todos = this.getTodos();
		if (todos.length === 0 || this.isHidden()) return [];

		const lines = [truncateToWidth(theme.fg("accent", todoSummary(todos)), width)];
		const impliedActiveId = this.agentActive ? todos.find((todo) => !isTerminal(todo))?.id : undefined;

		for (const todo of todos.slice(0, MAX_VISIBLE_TODOS)) {
			const isImpliedActive = todo.id === impliedActiveId;
			const activeFrame = isImpliedActive ? IN_PROGRESS_FRAMES[this.frame % IN_PROGRESS_FRAMES.length] : undefined;
			const id = theme.fg("dim", `#${todo.id}`);
			lines.push(truncateToWidth(`  ${todoIcon(todo, theme, activeFrame)} ${id} ${todoText(todo, theme, isImpliedActive)}`, width));
		}

		if (todos.length > MAX_VISIBLE_TODOS) {
			lines.push(truncateToWidth(theme.fg("dim", `    … and ${todos.length - MAX_VISIBLE_TODOS} more`), width));
		}

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let model: TodoModel = createTodoModel();
	let currentTurn = 0;
	let allTerminalSinceTurn: number | undefined;
	let widgetHidden = false;
	const widget = new TodoWidget(() => model.todos, () => widgetHidden);

	const allTodosTerminal = () => model.todos.length > 0 && model.todos.every(isTerminal);

	const refreshAutoHideState = () => {
		if (!allTodosTerminal()) {
			allTerminalSinceTurn = undefined;
			widgetHidden = false;
			return;
		}
		allTerminalSinceTurn ??= currentTurn;
		if (currentTurn - allTerminalSinceTurn >= AUTO_HIDE_AFTER_TURNS) widgetHidden = true;
	};

	const todoSnapshot = (action: TodoDetails["action"], extra: Partial<TodoDetails> = {}): TodoDetails => snapshot(model, action, extra);

	const reconstructState = (ctx: ExtensionContext) => {
		model = reconstructTodoModelFromBranch(ctx.sessionManager.getBranch());
		refreshAutoHideState();
	};

	pi.on("session_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui);
		currentTurn = 0;
		allTerminalSinceTurn = undefined;
		widgetHidden = false;
		reconstructState(ctx);
		widget.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		widget.setUICtx(ctx.ui);
		reconstructState(ctx);
		widget.update();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui);
		widget.update();
	});

	pi.on("agent_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui);
		widget.setAgentActive(true);
	});

	pi.on("turn_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui);
		currentTurn++;
		refreshAutoHideState();
		widget.update();
	});

	pi.on("agent_end", async () => {
		widget.setAgentActive(false);
		refreshAutoHideState();
		widget.update();
	});

	pi.on("session_shutdown", async () => {
		widget.dispose();
	});

	pi.registerTool<typeof TodoParams, TodoDetails>({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (items array, replace boolean), complete (integer id, state done/failed), clear",
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
			widget.setUICtx(ctx.ui);

			switch (params.action) {
				case "list": {
					widgetHidden = false;
					widget.update();
					return {
						content: [
							{
								type: "text" as const,
								text: model.todos.length
									? model.todos.map((todo) => `[${todo.state}] #${todo.id}: ${todo.text}`).join("\n")
									: "No todos",
							},
						],
						details: todoSnapshot("list"),
					};
				}

				case "add": {
					const added = addTodos(model, params.items, params.replace);
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
						details: todoSnapshot("add", { added }),
					};
				}

				case "complete": {
					const completed = completeTodo(model, params.id, params.state);
					if (!completed) {
						return {
							content: [{ type: "text" as const, text: `Todo #${params.id} not found` }],
							details: todoSnapshot("complete", { error: `#${params.id} not found` }),
						};
					}
					refreshAutoHideState();
					widget.update();
					return {
						content: [{ type: "text" as const, text: `Todo #${completed.id} marked ${completed.state}` }],
						details: todoSnapshot("complete", { completed }),
					};
				}

				case "clear": {
					const count = clearTodos(model);
					allTerminalSinceTurn = undefined;
					widgetHidden = false;
					widget.update();
					return {
						content: [{ type: "text" as const, text: `Cleared ${count} todos` }],
						details: todoSnapshot("clear"),
					};
				}
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if ("items" in args && Array.isArray(args.items)) text += ` ${theme.fg("dim", `${args.items.length} item(s)`)}`;
			if ("replace" in args && args.replace) text += ` ${theme.fg("warning", "replace")}`;
			if ("id" in args && args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if ("state" in args && args.state) text += ` ${theme.fg(args.state === "failed" ? "error" : "success", args.state)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = renderableDetails(result.details);
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
						listText += `\n${todoIcon(todo, theme)} ${theme.fg("accent", `#${todo.id}`)} ${todoResultText(todo, theme)}`;
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
			}
		},
	});
}
