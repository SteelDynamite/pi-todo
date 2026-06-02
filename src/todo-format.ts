import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Todo } from "./todo-core.ts";

export const DONE_ICON = "✓";
export const FAILED_ICON = "✗";
export const PENDING_ICON = "○";
export const IN_PROGRESS_FRAMES = ["▹", "▸", "▶", "▸"] as const;

const GREEN_FG = "\x1b[32m";
const RESET_FG = "\x1b[39m";

/** Force terminal-green for completed checkmarks, independent of theme success color. */
export function green(text: string): string {
	return `${GREEN_FG}${text}${RESET_FG}`;
}

export function todoCounts(todos: Todo[]): { done: number; failed: number; pending: number } {
	const done = todos.filter((todo) => todo.state === "done").length;
	const failed = todos.filter((todo) => todo.state === "failed").length;
	return { done, failed, pending: todos.length - done - failed };
}

export function todoSummary(todos: Todo[]): string {
	const { done, failed, pending } = todoCounts(todos);
	return `● ${todos.length} todo(s), ${done} done, ${failed} failed, ${pending} pending`;
}

export function todoIcon(todo: Todo, theme: Theme, activeFrame?: string): string {
	if (todo.state === "done") return green(DONE_ICON);
	if (todo.state === "failed") return theme.fg("error", FAILED_ICON);
	if (activeFrame) return theme.fg("accent", activeFrame);
	return theme.fg("dim", PENDING_ICON);
}

export function todoText(todo: Todo, theme: Theme, active = false): string {
	if (todo.state === "done") return theme.fg("dim", theme.strikethrough(todo.text));
	if (todo.state === "failed") return theme.fg("error", todo.text);
	if (active) return theme.fg("accent", `${todo.text}…`);
	return todo.text;
}

export function todoResultText(todo: Todo, theme: Theme): string {
	if (todo.state === "done") return theme.fg("dim", todo.text);
	if (todo.state === "failed") return theme.fg("error", todo.text);
	return theme.fg("muted", todo.text);
}
