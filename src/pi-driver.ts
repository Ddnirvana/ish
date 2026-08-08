export const TESTED_PI_VERSION = "0.84.1";

export interface PiLaunchOptions {
	sessionDir: string;
	extensions: string[];
	systemPrompt: string;
	provider?: string;
	model?: string;
	continueSession?: boolean;
	prefixArgs?: string[];
}

export function buildPiArgs(options: PiLaunchOptions): string[] {
	const args = [...(options.prefixArgs ?? [])];
	if (options.provider) args.push("--provider", options.provider);
	if (options.model) args.push("--model", options.model);
	args.push("--session-dir", options.sessionDir);
	if (options.continueSession) args.push("--continue");
	for (const extension of options.extensions) args.push("--extension", extension);
	args.push(
		"--append-system-prompt",
		options.systemPrompt,
		"--no-builtin-tools",
	);
	return args;
}
