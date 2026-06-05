import { describe, it } from "node:test";
import assert from "node:assert/strict";
import createExtension from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Mode = "tui" | "rpc" | "json" | "print";

function createHarness(mode: Mode) {
	const handlers = new Map<string, Handler[]>();
	const setWidgetCalls: unknown[][] = [];
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
				return [];
			},
		},
	};

	async function emit(event: string) {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	}

	assert.ok(tool, "todo tool registered");
	return { ctx, emit, setWidgetCalls, tool };
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
});
