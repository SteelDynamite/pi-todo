import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";

export interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

export interface ExtensionUIContext {
	setWidget(name: string, factory: ((tui: TUI, theme: Theme) => Component) | undefined, options?: { placement?: string }): void;
}

export interface ExtensionContext {
	mode?: unknown;
	hasUI: boolean;
	ui: ExtensionUIContext;
	sessionManager: {
		getBranch(): Iterable<{
			type?: string;
			message?: {
				role?: string;
				toolName?: string;
				details?: unknown;
			};
		}>;
	};
}

type ToolTextContent = { type: "text"; text: string };
type ToolResult<TDetails> = { content: ToolTextContent[]; details: TDetails };

export interface ExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>): void;
	setSessionName(name: string): void;
	registerTool<TParamsSchema extends TSchema, TDetails>(definition: {
		name: string;
		label: string;
		description: string;
		promptSnippet: string;
		promptGuidelines: string[];
		parameters: TParamsSchema;
		execute(
			toolCallId: string,
			params: Static<TParamsSchema>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ToolResult<TDetails>>;
		renderCall(args: Static<TParamsSchema>, theme: Theme, context: unknown): Component;
		renderResult(result: ToolResult<TDetails>, context: { expanded: boolean }, theme: Theme, renderContext: unknown): Component;
	}): void;
}
