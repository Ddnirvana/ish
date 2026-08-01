const RESET = "\u001b[0m";
const CYAN = "\u001b[38;5;39m";
const GREEN = "\u001b[38;5;42m";
const RED = "\u001b[38;5;203m";
const DIM = "\u001b[2m";

export const ISH_SYSTEM_PROMPT = [
	"You are the intelligence embedded inside ish (intent shell).",
	"ish is a new system-level shell built on the mature zsh and Pi projects: zsh is its authoritative native execution substrate, while Pi provides its agent intelligence.",
	"When asked what shell or environment this is, identify it explicitly as ish (intent shell), not merely zsh or Pi.",
	"Preserve normal shell semantics, distinguish observations from proposed effects, and never imply that model output bypasses ish approval or operating-system permissions.",
	"This agent is system-scoped across the user's shell sessions rather than tied to one coding-project workspace.",
].join(" ");

export interface UiOptions {
	color?: boolean;
	ascii?: boolean;
	columns?: number;
}

function defaultColor(): boolean {
	return Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
}

function paint(text: string, code: string, enabled: boolean): string {
	return enabled ? `${code}${text}${RESET}` : text;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, columns: number): string {
	const clean = oneLine(text);
	const limit = Math.max(12, columns - 4);
	if (clean.length <= limit) return clean;
	return `${clean.slice(0, Math.max(1, limit - 3))}...`;
}

function options(overrides: UiOptions = {}): Required<UiOptions> {
	return {
		color: overrides.color ?? defaultColor(),
		ascii: overrides.ascii ?? process.env.ISH_ASCII === "1",
		columns: overrides.columns ?? process.stdout.columns ?? 80,
	};
}

export function renderAgentStart(prompt: string, overrides: UiOptions = {}): string {
	const ui = options(overrides);
	const mark = ui.ascii ? ">" : "◆";
	const brand = paint("ish", CYAN, ui.color);
	const mode = paint("agent", DIM, ui.color);
	const thinking = paint("Pi is thinking...", DIM, ui.color);
	return `${paint(mark, CYAN, ui.color)} ${brand} ${mode}\n  ${clip(prompt, ui.columns)}\n  ${thinking}\n`;
}

export function renderAgentEnd(durationMs: number, overrides: UiOptions = {}): string {
	const ui = options(overrides);
	const mark = ui.ascii ? "ok" : "✓";
	return `${paint(mark, GREEN, ui.color)} ${paint("ish", CYAN, ui.color)} ${paint(`done in ${(durationMs / 1000).toFixed(1)}s`, DIM, ui.color)}\n`;
}

export function renderFailure(message: string, overrides: UiOptions = {}): string {
	const ui = options(overrides);
	const mark = ui.ascii ? "error" : "×";
	return `${paint(mark, RED, ui.color)} ${paint("ish", CYAN, ui.color)} ${oneLine(message)}`;
}
