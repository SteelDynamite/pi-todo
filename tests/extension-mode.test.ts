import { describe, it } from "node:test";
import assert from "node:assert/strict";
import createExtension from "../index.ts";

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
