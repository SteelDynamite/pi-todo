import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	addTodos,
	clearTodos,
	completeTodo,
	createTodoModel,
	reconstructTodoModelFromBranch,
	snapshot,
	type TodoDetails,
	type ToolResultBranchEntry,
} from "../src/todo-core.ts";

function toolEntry(details: unknown): ToolResultBranchEntry {
	return { type: "message", message: { role: "toolResult", toolName: "todo", details } };
}

describe("todo actions", () => {
	it("adds, appends, replaces, completes, and clears todos", () => {
		const model = createTodoModel();

		assert.deepEqual(addTodos(model, ["one", "two"]), [
			{ id: 1, text: "one", state: "pending" },
			{ id: 2, text: "two", state: "pending" },
		]);
		assert.equal(model.nextId, 3);

		assert.deepEqual(completeTodo(model, 2, "done"), { id: 2, text: "two", state: "done" });
		assert.equal(completeTodo(model, 99, "failed"), undefined);

		assert.deepEqual(addTodos(model, ["fresh"], true), [{ id: 1, text: "fresh", state: "pending" }]);
		assert.deepEqual(model.todos, [{ id: 1, text: "fresh", state: "pending" }]);
		assert.equal(model.nextId, 2);

		assert.equal(clearTodos(model), 1);
		assert.deepEqual(model, { todos: [], nextId: 1 });
	});

	it("snapshots clone mutable state", () => {
		const model = createTodoModel();
		const added = addTodos(model, ["one"]);
		const details = snapshot(model, "add", { added });
		model.todos[0]!.text = "mutated";
		added[0]!.text = "also mutated";

		assert.deepEqual(details.todos, [{ id: 1, text: "one", state: "pending" }]);
		assert.deepEqual(details.added, [{ id: 1, text: "one", state: "pending" }]);
	});
});

describe("branch reconstruction", () => {
	it("uses the latest todo tool result on the active branch", () => {
		const first: TodoDetails = {
			action: "add",
			todos: [{ id: 1, text: "main", state: "pending" }],
			nextId: 2,
		};
		const branch: TodoDetails = {
			action: "add",
			todos: [{ id: 1, text: "branch", state: "done" }],
			nextId: 2,
		};

		const model = reconstructTodoModelFromBranch([
			toolEntry(first),
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: { ignored: true } } },
			toolEntry(branch),
		]);

		assert.deepEqual(model, { todos: [{ id: 1, text: "branch", state: "done" }], nextId: 2 });
	});

	it("migrates legacy toggle/done details only during reconstruction", () => {
		const legacy = {
			action: "toggle",
			todos: [
				{ id: 1, text: "old done", done: true },
				{ id: 2, text: "old pending", done: false },
			],
		};

		assert.deepEqual(reconstructTodoModelFromBranch([toolEntry(legacy)]), {
			todos: [
				{ id: 1, text: "old done", state: "done" },
				{ id: 2, text: "old pending", state: "pending" },
			],
			nextId: 3,
		});
	});

	it("returns clones so callers cannot mutate persisted reconstruction", () => {
		const details: TodoDetails = {
			action: "add",
			todos: [{ id: 1, text: "one", state: "pending" }],
			nextId: 2,
		};
		const model = reconstructTodoModelFromBranch([toolEntry(details)]);
		model.todos[0]!.text = "mutated";

		assert.equal(details.todos[0]!.text, "one");
	});
});
