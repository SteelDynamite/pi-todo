export type TodoState = "pending" | "done" | "failed";
export type TodoAction = "list" | "add" | "complete" | "clear";

export interface Todo {
	id: number;
	text: string;
	state: TodoState;
}

export interface TodoModel {
	todos: Todo[];
	nextId: number;
	title?: string;
}

export interface TodoDetails {
	action: TodoAction;
	todos: Todo[];
	nextId: number;
	title?: string;
	added?: Todo[];
	completed?: Todo;
	error?: string;
}

export interface ToolResultBranchEntry {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
}

type StoredTodo = Partial<Todo> & { done?: boolean };
type StoredTodoDetails = Partial<Omit<TodoDetails, "action" | "todos" | "nextId" | "title">> & {
	action?: TodoAction | "toggle";
	todos?: unknown;
	nextId?: unknown;
	title?: unknown;
};

export function createTodoModel(): TodoModel {
	return { todos: [], nextId: 1 };
}

export function cloneTodos(todos: Todo[]): Todo[] {
	return todos.map((todo) => ({ ...todo }));
}

export function cloneTodoModel(model: TodoModel): TodoModel {
	return model.title === undefined
		? { todos: cloneTodos(model.todos), nextId: model.nextId }
		: { todos: cloneTodos(model.todos), nextId: model.nextId, title: model.title };
}

export function isTerminal(todo: Todo): boolean {
	return todo.state === "done" || todo.state === "failed";
}

export function pendingBeforeTerminalTodos(todos: Todo[]): Todo[] {
	const pending: Todo[] = [];
	let hasLaterTerminal = false;
	for (let i = todos.length - 1; i >= 0; i--) {
		const todo = todos[i]!;
		if (isTerminal(todo)) {
			hasLaterTerminal = true;
		} else if (hasLaterTerminal) {
			pending.unshift({ ...todo });
		}
	}
	return pending;
}

export function isTodoAction(action: unknown): action is TodoAction {
	return action === "list" || action === "add" || action === "complete" || action === "clear";
}

function normalizeStoredTodo(todo: StoredTodo): Todo | undefined {
	if (typeof todo.id !== "number" || !Number.isInteger(todo.id) || typeof todo.text !== "string") return undefined;
	const state: TodoState = todo.state === "done" || todo.state === "failed" || todo.state === "pending"
		? todo.state
		: todo.done
			? "done"
			: "pending";
	return { id: todo.id, text: todo.text, state };
}

function normalizeStoredDetails(details: unknown): TodoModel | undefined {
	const stored = details as StoredTodoDetails | undefined;
	if (!stored || !Array.isArray(stored.todos)) return undefined;
	const todos = stored.todos.map((todo) => normalizeStoredTodo(todo as StoredTodo)).filter((todo): todo is Todo => !!todo);
	const nextId = typeof stored.nextId === "number" && Number.isInteger(stored.nextId)
		? stored.nextId
		: Math.max(1, ...todos.map((todo) => todo.id + 1));
	const title = typeof stored.title === "string" ? stored.title : undefined;
	return title === undefined ? { todos, nextId } : { todos, nextId, title };
}

export function reconstructTodoModelFromBranch(entries: Iterable<ToolResultBranchEntry>): TodoModel {
	let model = createTodoModel();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;

		const storedModel = normalizeStoredDetails(msg.details);
		if (storedModel) model = storedModel;
	}

	return cloneTodoModel(model);
}

export function addTodos(model: TodoModel, items: string[], replace = false, title?: string): Todo[] {
	if (replace) {
		model.todos = [];
		model.nextId = 1;
	}
	if (title !== undefined) model.title = title;

	const added = items.map((text) => {
		const todo: Todo = { id: model.nextId++, text, state: "pending" };
		model.todos.push(todo);
		return todo;
	});

	return cloneTodos(added);
}

export function completeTodo(model: TodoModel, id: number, state: Exclude<TodoState, "pending">): Todo | undefined {
	const todo = model.todos.find((item) => item.id === id);
	if (!todo) return undefined;
	todo.state = state;
	return { ...todo };
}

export function clearTodos(model: TodoModel): number {
	const count = model.todos.length;
	model.todos = [];
	model.nextId = 1;
	return count;
}

export function snapshot(model: TodoModel, action: TodoAction, extra: Partial<TodoDetails> = {}): TodoDetails {
	const details: TodoDetails = {
		...extra,
		action,
		todos: cloneTodos(model.todos),
		nextId: model.nextId,
		added: extra.added ? cloneTodos(extra.added) : undefined,
		completed: extra.completed ? { ...extra.completed } : undefined,
	};
	if (model.title !== undefined) details.title = model.title;
	return details;
}
