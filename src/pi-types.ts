export interface PiExtensionContext {
	cwd: string;
	ui: {
		notify(message: string, level: "info" | "error"): void;
	};
}

export interface PiExtensionAPI {
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
}
