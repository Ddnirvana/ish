import path from "node:path";
import { Type } from "typebox";
import type { PiExtensionAPI, PiExtensionContext } from "../../src/pi-types.js";
import { observationMetadata, runObservation, type CommandObservation } from "./runner.js";

interface GitInspectParams extends Record<string, unknown> {
	operation: "overview" | "status" | "diff" | "log";
	path?: string;
	staged?: boolean;
	includePatch?: boolean;
	logLimit?: number;
}

const GitInspectParams = Type.Object({
	operation: Type.Union([Type.Literal("overview"), Type.Literal("status"), Type.Literal("diff"), Type.Literal("log")]),
	path: Type.Optional(Type.String({ description: "Repository path relative to the current ish directory, or absolute" })),
	staged: Type.Optional(Type.Boolean({ description: "For diff, inspect staged changes instead of unstaged changes" })),
	includePatch: Type.Optional(Type.Boolean({ description: "Include a bounded unified patch for diff or overview; default true" })),
	logLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Recent commits for log or overview; default 10" })),
});

function git(root: string, args: string[], signal?: AbortSignal, maxOutputBytes?: number) {
	return runObservation("git", ["-C", root, ...args], { signal, maxOutputBytes });
}

function statusSummary(output: string) {
	const lines = output.split("\n").filter(Boolean);
	const branch = Object.fromEntries(lines.filter((line) => line.startsWith("# ")).flatMap((line) => {
		const match = line.match(/^# ([^ ]+) (.*)$/);
		return match ? [[match[1], match[2]]] : [];
	}));
	const entries = lines.filter((line) => !line.startsWith("# "));
	return {
		branch,
		changedEntries: entries.length,
		untrackedEntries: entries.filter((line) => line.startsWith("? ")).length,
		conflictedEntries: entries.filter((line) => line.startsWith("u ")).length,
		entries,
	};
}

export async function inspectGit(params: GitInspectParams, ctx: PiExtensionContext, signal?: AbortSignal) {
	const requestedRoot = path.resolve(ctx.cwd, params.path ?? ".");
	const rootCheck = await git(requestedRoot, ["rev-parse", "--show-toplevel"], signal, 16 * 1024);
	if (!rootCheck.complete) {
		return {
			operation: params.operation,
			requestedRoot,
			supported: rootCheck.supported,
			complete: false,
			incompleteReasons: rootCheck.incompleteReasons,
			error: rootCheck.stderr.trim() || "not a Git repository",
			observations: [observationMetadata(rootCheck)],
		};
	}
	const repositoryRoot = rootCheck.stdout.trim();
	const observations: CommandObservation[] = [rootCheck];
	const result: Record<string, unknown> = { operation: params.operation, requestedRoot, repositoryRoot };

	if (params.operation === "overview" || params.operation === "status") {
		const status = await git(repositoryRoot, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"], signal);
		observations.push(status);
		result.status = statusSummary(status.stdout);
	}
	if (params.operation === "overview" || params.operation === "diff") {
		const targets = params.operation === "overview" ? [false, true] : [params.staged ?? false];
		const diffs: Record<string, unknown> = {};
		for (const staged of targets) {
			const prefix = staged ? ["--cached"] : [];
			const stat = await git(repositoryRoot, ["diff", "--no-ext-diff", "--no-textconv", ...prefix, "--stat", "--"], signal);
			observations.push(stat);
			let patch: CommandObservation | undefined;
			if (params.includePatch ?? true) {
				patch = await git(repositoryRoot, ["diff", "--no-ext-diff", "--no-textconv", ...prefix, "--unified=3", "--"], signal, 256 * 1024);
				observations.push(patch);
			}
			diffs[staged ? "staged" : "unstaged"] = { stat: stat.stdout, patch: patch?.stdout ?? "" };
		}
		result.diffs = diffs;
	}
	if (params.operation === "overview" || params.operation === "log") {
		const logLimit = params.logLimit ?? 10;
		const log = await git(repositoryRoot, ["log", `-${logLimit}`, "--date=iso-strict", "--format=%H%x09%an%x09%ad%x09%s"], signal);
		observations.push(log);
		result.log = log.stdout.split("\n").filter(Boolean).map((line) => {
			const [commit, author, date, ...subject] = line.split("\t");
			return { commit, author, date, subject: subject.join("\t") };
		});
	}
	return {
		...result,
		supported: observations.every((item) => item.supported),
		complete: observations.every((item) => item.complete),
		incompleteReasons: [...new Set(observations.flatMap((item) => item.incompleteReasons))],
		observations: observations.map(observationMetadata),
	};
}

export function registerGitInspect(pi: PiExtensionAPI): void {
	pi.registerTool<GitInspectParams>({
		name: "git_inspect",
		label: "Git Inspect",
		description:
			"Read Git status, staged or unstaged diff, and recent history without modifying the repository. Use overview to explain a dirty tree from exact bounded evidence, including completeness indicators.",
		parameters: GitInspectParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await inspectGit(params, ctx, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
