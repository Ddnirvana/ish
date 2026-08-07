export interface PiExtensionContext {
	cwd: string;
	ui: {
		notify(message: string, level: "info" | "error"): void;
	};
}

export interface PiToolInfo {
	name: string;
	description: string;
	sourceInfo?: {
		source: string;
		path: string;
		scope: string;
	};
}

export interface PiExtensionAPI {
	on(event: "session_start", handler: () => void | Promise<void>): void;
	registerTool<TParams extends Record<string, unknown>>(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(
			toolCallId: string,
			params: TParams,
			signal: AbortSignal,
			onUpdate: unknown,
			ctx: PiExtensionContext,
		): Promise<unknown>;
	}): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: PiExtensionContext): Promise<void>;
		},
	): void;
	getActiveTools(): string[];
	getAllTools(): PiToolInfo[];
	setActiveTools(toolNames: string[]): void;
}
