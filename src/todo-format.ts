import type { Theme } from "./pi-types.ts";
import type { Todo } from "./todo-core.ts";

export const DONE_ICON = "✓";
export const FAILED_ICON = "✗";
export const PENDING_ICON = "○";
export const IN_PROGRESS_FRAMES = ["▹", "▸", "▶", "▸"] as const;

const GREEN_FG = "\x1b[32m";
const RESET_FG = "\x1b[39m";

/** Escape untrusted terminal controls before styling; keep persisted text unchanged. */
export function terminalText(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

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
	const text = terminalText(todo.text);
	if (todo.state === "done") return theme.fg("dim", theme.strikethrough(text));
	if (todo.state === "failed") return theme.fg("error", text);
	if (active) return theme.fg("accent", `${text}…`);
	return text;
}

export function todoResultText(todo: Todo, theme: Theme): string {
	const text = terminalText(todo.text);
	if (todo.state === "done") return theme.fg("dim", text);
	if (todo.state === "failed") return theme.fg("error", text);
	return theme.fg("muted", text);
}
