import { describe, it } from "node:test";
import assert from "node:assert/strict";
import createExtension from "../index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Mode = "tui" | "rpc" | "json" | "print";

function toolEntry(details: unknown) {
	return { type: "message", message: { role: "toolResult", toolName: "todo", details } };
}

function createHarness(mode: Mode, branch: unknown[] = []) {
	const handlers = new Map<string, Handler[]>();
	const setWidgetCalls: unknown[][] = [];
	const setSessionNameCalls: string[] = [];
	const sendMessageCalls: unknown[][] = [];
	let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;

	createExtension({
		on(event: string, handler: Handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerTool(definition: { execute: (...args: unknown[]) => Promise<unknown> }) {
			tool = definition;
		},
		setSessionName(name: string) {
			setSessionNameCalls.push(name);
		},
		sendMessage(...args: unknown[]) {
			sendMessageCalls.push(args);
		},
	} as never);

	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			setWidget(...args: unknown[]) {
				setWidgetCalls.push(args);
			},
		},
		sessionManager: {
			getBranch() {
				return branch;
			},
		},
	};

	async function emit(event: string) {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	}

	assert.ok(tool, "todo tool registered");
	return { ctx, emit, sendMessageCalls, setSessionNameCalls, setWidgetCalls, tool };
}

function renderWidget(harness: ReturnType<typeof createHarness>, width = 80): string[] {
	const registration = harness.setWidgetCalls.find((call) => typeof call[1] === "function");
	assert.ok(registration, "todo widget registered");
	const factory = registration[1] as (tui: unknown, theme: unknown) => { render: (width: number) => string[] };
	const component = factory(
		{ requestRender() {} },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text },
	);
	return component.render(width);
}

function renderedTodoIds(lines: string[]): number[] {
	return lines.flatMap((line) => {
		const match = line.match(/#(\d+)/);
		return match ? [Number(match[1])] : [];
	});
}

describe("mode-specific widget behavior", () => {
	it("keeps the todo tool usable without widget work in non-TUI modes", async () => {
		for (const mode of ["rpc", "json", "print"] as const) {
			const harness = createHarness(mode);
			await harness.emit("session_start");
			await harness.emit("before_agent_start");
			await harness.emit("agent_start");
			await harness.emit("turn_start");
			const result = await harness.tool.execute("tool-1", { action: "add", items: ["one"] }, undefined, undefined, harness.ctx);
			await harness.emit("agent_end");

			assert.deepEqual(harness.setWidgetCalls, []);
			assert.match(JSON.stringify(result), /Added 1 todo/);
		}
	});

	it("registers the widget in TUI mode", async () => {
		const harness = createHarness("tui");
		await harness.emit("session_start");
		await harness.tool.execute("tool-1", { action: "add", items: ["one"] }, undefined, undefined, harness.ctx);

		assert.equal(harness.setWidgetCalls.length, 1);
		assert.equal(harness.setWidgetCalls[0]?.[0], "todo");
		assert.equal(typeof harness.setWidgetCalls[0]?.[1], "function");
	});

	it("sets the session name from title and keeps the title widget after clear", async () => {
		const harness = createHarness("tui");
		await harness.emit("session_start");
		await harness.tool.execute("tool-1", { action: "add", items: ["one"], replace: true, title: "Plan A" }, undefined, undefined, harness.ctx);
		await harness.tool.execute("tool-2", { action: "clear" }, undefined, undefined, harness.ctx);

		assert.deepEqual(harness.setSessionNameCalls, ["Plan A"]);
		assert.equal(harness.setWidgetCalls.some((call) => call[0] === "todo" && call[1] === undefined), false);

		const factory = harness.setWidgetCalls[0]?.[1] as (tui: unknown, theme: unknown) => { render: (width: number) => string[] };
		const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text });
		assert.deepEqual(component.render(80), ["● Plan A"]);
	});

	it("restores title and session name from branch state", async () => {
		const harness = createHarness("tui", [toolEntry({ action: "clear", todos: [], nextId: 1, title: "Restored Plan" })]);
		await harness.emit("session_start");

		assert.deepEqual(harness.setSessionNameCalls, ["Restored Plan"]);
		assert.equal(harness.setWidgetCalls.length, 1);
		const factory = harness.setWidgetCalls[0]?.[1] as (tui: unknown, theme: unknown) => { render: (width: number) => string[] };
		const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text });
		assert.deepEqual(component.render(80), ["● Restored Plan"]);
	});

	it("restarts auto-hide on tree navigation without carrying another branch's timer", async () => {
		const branch = [toolEntry({ action: "complete", todos: [{ id: 1, text: "old", state: "done" }], nextId: 2 })];
		const harness = createHarness("tui", branch);
		await harness.emit("session_start");
		for (let turn = 0; turn < 4; turn++) await harness.emit("turn_start");
		assert.deepEqual(renderWidget(harness), []);

		branch.splice(0, branch.length, toolEntry({ action: "complete", todos: [{ id: 1, text: "other branch", state: "failed" }], nextId: 2 }));
		await harness.emit("session_tree");
		assert.deepEqual(renderedTodoIds(renderWidget(harness)), [1]);
		for (let turn = 0; turn < 3; turn++) await harness.emit("turn_start");
		assert.deepEqual(renderedTodoIds(renderWidget(harness)), [1]);
		await harness.emit("turn_start");
		assert.deepEqual(renderWidget(harness), []);
		const result = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		assert.match(JSON.stringify(result), /other branch/);
	});

	it("renders multiline titles and items as width-bounded widget rows without changing state", async () => {
		const harness = createHarness("tui");
		const title = "Plan\r\nnext";
		const text = "first\nsecond\t界";
		const result = await harness.tool.execute("add", { action: "add", title, items: [text] }, undefined, undefined, harness.ctx);
		assert.equal((result as { details: { todos: { text: string }[] } }).details.todos[0]?.text, text);
		assert.deepEqual(harness.setSessionNameCalls, [title]);
		for (const width of [1, 8, 20, 80]) {
			const lines = renderWidget(harness, width);
			assert.equal(lines.length, 2);
			for (const line of lines) {
				assert.doesNotMatch(line, /[\r\n\t]/);
				assert.ok(visibleWidth(line) <= width);
			}
		}
	});

	it("reveals later todos after five leading mixed terminal states", async () => {
		const harness = createHarness("tui");
		await harness.emit("session_start");
		await harness.tool.execute("add", { action: "add", items: Array.from({ length: 12 }, (_, i) => `item ${i + 1}`) }, undefined, undefined, harness.ctx);

		for (let id = 1; id <= 5; id++) {
			await harness.tool.execute(`complete-${id}`, { action: "complete", id, state: id % 2 ? "done" : "failed" }, undefined, undefined, harness.ctx);
		}
		let lines = renderWidget(harness);
		assert.deepEqual(renderedTodoIds(lines), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		assert.equal(lines.some((line) => line.includes("earlier done/failed")), false);
		assert.equal(lines.at(-1), "    … and 2 more");

		await harness.tool.execute("complete-6", { action: "complete", id: 6, state: "failed" }, undefined, undefined, harness.ctx);
		lines = renderWidget(harness);
		assert.deepEqual(renderedTodoIds(lines), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		assert.equal(lines[1], "    … 1 earlier done/failed");
		assert.equal(lines.at(-1), "    … and 1 more");

		await harness.tool.execute("complete-7", { action: "complete", id: 7, state: "done" }, undefined, undefined, harness.ctx);
		lines = renderWidget(harness);
		assert.deepEqual(renderedTodoIds(lines), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		assert.equal(lines[1], "    … 2 earlier done/failed");
		assert.equal(lines.some((line) => line.includes("more")), false);

		for (let id = 8; id <= 12; id++) {
			await harness.tool.execute(`complete-${id}`, { action: "complete", id, state: id % 2 ? "done" : "failed" }, undefined, undefined, harness.ctx);
			lines = renderWidget(harness);
			assert.deepEqual(renderedTodoIds(lines), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
			assert.equal(lines[1], "    … 2 earlier done/failed");
		}
	});

	it("stops at a skipped pending todo before filling and passing the tail", async () => {
		const harness = createHarness("tui");
		await harness.emit("session_start");
		await harness.tool.execute("add", { action: "add", items: Array.from({ length: 13 }, (_, i) => `item ${i + 1}`) }, undefined, undefined, harness.ctx);
		for (let id = 1; id <= 7; id++) {
			await harness.tool.execute(`complete-${id}`, { action: "complete", id, state: id % 2 ? "failed" : "done" }, undefined, undefined, harness.ctx);
		}

		await harness.tool.execute("complete-9", { action: "complete", id: 9, state: "done" }, undefined, undefined, harness.ctx);
		let lines = renderWidget(harness);
		assert.deepEqual(renderedTodoIds(lines), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		assert.equal(lines[1], "    … 2 earlier done/failed");
		assert.equal(lines.at(-1), "    … and 1 more");

		await harness.tool.execute("complete-8", { action: "complete", id: 8, state: "failed" }, undefined, undefined, harness.ctx);
		await harness.tool.execute("complete-10", { action: "complete", id: 10, state: "done" }, undefined, undefined, harness.ctx);
		lines = renderWidget(harness);
		assert.deepEqual(renderedTodoIds(lines), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
		assert.equal(lines[1], "    … 3 earlier done/failed");
		assert.equal(lines.some((line) => line.includes("more")), false);
	});

	it("reminds once when pending todos appear before later terminal todos", async () => {
		const harness = createHarness("json", [toolEntry({
			action: "complete",
			nextId: 4,
			todos: [
				{ id: 1, text: "done", state: "done" },
				{ id: 2, text: "stale", state: "pending" },
				{ id: 3, text: "done later", state: "done" },
			],
		})]);
		await harness.emit("session_start");
		await harness.emit("agent_end");
		await harness.emit("agent_end");

		assert.equal(harness.sendMessageCalls.length, 1);
		assert.match(JSON.stringify(harness.sendMessageCalls[0]), /todo-pending-order/);
		assert.match(JSON.stringify(harness.sendMessageCalls[0]), /#2/);

		await harness.emit("before_agent_start");
		await harness.emit("agent_end");
		assert.equal(harness.sendMessageCalls.length, 2);
	});

	it("does not remind when pending todos are at the end", async () => {
		const harness = createHarness("json", [toolEntry({
			action: "complete",
			nextId: 3,
			todos: [
				{ id: 1, text: "done", state: "done" },
				{ id: 2, text: "remaining", state: "pending" },
			],
		})]);
		await harness.emit("session_start");
		await harness.emit("agent_end");

		assert.deepEqual(harness.sendMessageCalls, []);
	});
});
