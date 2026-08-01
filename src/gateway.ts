export type GatewayRoute = "native" | "agent" | "control";

export interface GatewayDecision {
	route: GatewayRoute;
	reason: string;
}

export interface GatewayOptions {
	commandExists?: (command: string) => boolean;
}

const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"case",
	"esac",
	"do",
	"done",
	"function",
	"time",
	"coproc",
]);

const SHELL_BUILTINS = new Set([
	"alias",
	"bg",
	"bindkey",
	"break",
	"builtin",
	"cd",
	"command",
	"continue",
	"dirs",
	"disown",
	"echo",
	"eval",
	"exec",
	"exit",
	"export",
	"false",
	"fc",
	"fg",
	"getopts",
	"hash",
	"history",
	"jobs",
	"kill",
	"local",
	"popd",
	"printf",
	"pushd",
	"pwd",
	"read",
	"readonly",
	"return",
	"set",
	"shift",
	"source",
	"test",
	"times",
	"trap",
	"true",
	"type",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"wait",
	"whence",
]);

const CONTROL_PREFIXES = ["/intent", "/panes", "/capsules", "/actions", "/observe", "/apply", "/broadcast", "/context"];
const ENGLISH_REQUEST =
	/^(how|what|why|where|when|please|explain|analy[sz]e|summari[sz]e|investigate|diagnose|can you|could you|would you|help me|tell me|show me)\b/i;
const CJK_REQUEST = /(怎么|如何|为什么|为何|帮我|请|分析|解释|排查|总结|检查|看看|能不能|是否|怎样)/;

function firstToken(line: string): string {
	return line.match(/^([^\s]+)/)?.[1] ?? "";
}

function hasStrongShellSyntax(line: string): boolean {
	if (/[|&;<>()`$\\]/.test(line)) return true;
	if (/(^|\s)(>>?|<<?)(\s|$)/.test(line)) return true;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return true;
	if (/^(\.\.?\/|\/)/.test(line)) return true;
	if (/[*{}\[\]]/.test(line)) return true;
	return false;
}

export function routeInput(input: string, options: GatewayOptions = {}): GatewayDecision {
	const line = input.trim();
	if (!line) return { route: "native", reason: "empty shell input" };
	if (line === "?" || line.startsWith("? ") || line === "/ask" || line.startsWith("/ask ")) {
		return { route: "agent", reason: "explicit agent escape" };
	}
	if (CONTROL_PREFIXES.some((prefix) => line === prefix || line.startsWith(`${prefix} `))) {
		return { route: "control", reason: "explicit ish control command" };
	}
	if (hasStrongShellSyntax(line)) {
		return { route: "native", reason: "shell syntax must retain native semantics" };
	}

	const token = firstToken(line);
	if (SHELL_KEYWORDS.has(token) || SHELL_BUILTINS.has(token)) {
		return { route: "native", reason: "shell keyword or builtin" };
	}
	if (options.commandExists?.(token)) {
		return { route: "native", reason: "command resolves in the shell environment" };
	}
	if (ENGLISH_REQUEST.test(line)) {
		return { route: "agent", reason: "high-confidence English request" };
	}
	if (CJK_REQUEST.test(line)) {
		return { route: "agent", reason: "high-confidence CJK request" };
	}
	if (/\p{Script=Han}/u.test(line) && /\s/.test(line)) {
		return { route: "agent", reason: "unresolved multi-token CJK input" };
	}
	if (/[?？]$/.test(line) && line.split(/\s+/).length >= 3) {
		return { route: "agent", reason: "unresolved question-shaped input" };
	}
	return { route: "native", reason: "ambiguous input defaults to the reliable shell path" };
}
