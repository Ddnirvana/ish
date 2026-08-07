import { Type } from "typebox";
import type { PiExtensionAPI } from "../../src/pi-types.js";
import { observationMetadata, runObservation, unsupported } from "./runner.js";

type ServiceScope = "user" | "system";

interface LogQueryParams extends Record<string, unknown> {
	source: "kernel" | "journal";
	unit?: string;
	scope?: ServiceScope;
	priority?: "emerg" | "alert" | "crit" | "err" | "warning" | "notice" | "info" | "debug";
	lines?: number;
}

interface ServiceObserveParams extends Record<string, unknown> {
	unit: string;
	scope?: ServiceScope;
	journalLines?: number;
}

const priorities = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"] as const;

const LogQueryParams = Type.Object({
	source: Type.Union([Type.Literal("kernel"), Type.Literal("journal")]),
	unit: Type.Optional(Type.String({ description: "Exact systemd unit for journal queries" })),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("system")], { description: "systemd manager; default user" })),
	priority: Type.Optional(Type.Union(priorities.map((priority) => Type.Literal(priority)), { description: "Maximum journal severity" })),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum newest records; default 100" })),
});

const ServiceObserveParams = Type.Object({
	unit: Type.String({ minLength: 1, description: "Exact systemd unit name" }),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("system")], { description: "systemd manager; default user" })),
	journalLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 500, description: "Recent unit journal records; default 80" })),
});

function unitName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(value)) throw new Error(`invalid systemd unit name: ${value}`);
	return value;
}

function parseProperties(output: string): Record<string, string> {
	return Object.fromEntries(output.split("\n").flatMap((line) => {
		const separator = line.indexOf("=");
		return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
	}));
}

export async function queryLogs(params: LogQueryParams, signal?: AbortSignal, env = process.env) {
	if (process.platform !== "linux") {
		const observation = unsupported(`${params.source} log query`);
		return { source: params.source, supported: false, complete: false, incompleteReasons: observation.incompleteReasons, records: "", observation };
	}
	const lines = params.lines ?? 100;
	let command: string;
	let args: string[];
	if (params.source === "kernel") {
		command = "dmesg";
		args = ["--color=never"];
		if (params.priority) args.push(`--level=${params.priority === "warning" ? "warn" : params.priority}`);
	} else {
		const unit = unitName(params.unit);
		command = "journalctl";
		args = [];
		if ((params.scope ?? "user") === "user") args.push("--user");
		args.push("--no-pager", "--output=short-iso", `--lines=${lines}`);
		if (unit) args.push(`--unit=${unit}`);
		if (params.priority) args.push(`--priority=${params.priority}`);
	}
	const observation = await runObservation(command, args, {
		signal,
		env,
		retain: "tail",
		maxOutputBytes: params.source === "kernel" ? 1024 * 1024 : undefined,
	});
	const records = params.source === "kernel"
		? observation.stdout.split("\n").slice(-lines).join("\n")
		: observation.stdout;
	return {
		source: params.source,
		scope: params.source === "journal" ? (params.scope ?? "user") : undefined,
		unit: params.unit,
		priority: params.priority,
		lineLimit: lines,
		supported: observation.supported,
		complete: observation.complete,
		incompleteReasons: observation.incompleteReasons,
		records,
		observation: observationMetadata(observation),
	};
}

export async function observeService(params: ServiceObserveParams, signal?: AbortSignal, env = process.env) {
	const unit = unitName(params.unit)!;
	if (process.platform !== "linux") {
		const observation = unsupported("systemd service observation");
		return { unit, scope: params.scope ?? "user", supported: false, complete: false, incompleteReasons: observation.incompleteReasons, properties: {}, journal: "", observations: [observation] };
	}
	const scope = params.scope ?? "user";
	const manager = scope === "user" ? ["--user"] : [];
	const properties = [
		"Id", "Description", "LoadState", "ActiveState", "SubState", "Result", "UnitFileState",
		"MainPID", "ExecMainCode", "ExecMainStatus", "StateChangeTimestamp", "FragmentPath",
	].join(",");
	const statusObservation = await runObservation(
		"systemctl",
		[...manager, "show", unit, "--no-pager", `--property=${properties}`],
		{ signal, env },
	);
	const journalLines = params.journalLines ?? 80;
	const journalObservation = journalLines === 0
		? undefined
		: await runObservation(
			"journalctl",
			[...manager, "--no-pager", "--output=short-iso", `--lines=${journalLines}`, `--unit=${unit}`],
			{ signal, env },
		);
	const observations = journalObservation ? [statusObservation, journalObservation] : [statusObservation];
	return {
		unit,
		scope,
		journalLineLimit: journalLines,
		supported: observations.every((item) => item.supported),
		complete: observations.every((item) => item.complete),
		incompleteReasons: [...new Set(observations.flatMap((item) => item.incompleteReasons))],
		properties: parseProperties(statusObservation.stdout),
		journal: journalObservation?.stdout ?? "",
		observations: observations.map(observationMetadata),
	};
}

export function registerLogAndServiceObserve(pi: PiExtensionAPI): void {
	pi.registerTool<LogQueryParams>({
		name: "log_query",
		label: "Log Query",
		description:
			"Read bounded Linux kernel or systemd journal records with typed source, unit, scope, severity, and line limits. Does not invoke sudo; use shell_observe for privileged dmesg output the user already ran.",
		parameters: LogQueryParams,
		async execute(_toolCallId, params, signal) {
			const result = await queryLogs(params, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool<ServiceObserveParams>({
		name: "service_observe",
		label: "Service Observe",
		description:
			"Diagnose an exact Linux systemd user or system service from structured state and bounded recent journal records. Read-only and never elevates privileges.",
		parameters: ServiceObserveParams,
		async execute(_toolCallId, params, signal) {
			const result = await observeService(params, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
