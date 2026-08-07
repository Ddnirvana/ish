import { Type } from "typebox";
import type { PiExtensionAPI } from "../../src/pi-types.js";
import { observationMetadata, runObservation, unsupported } from "./runner.js";

interface ProcessObserveParams extends Record<string, unknown> {
	operation: "list" | "find" | "pid";
	query?: string;
	pid?: number;
	limit?: number;
}

export interface ProcessInfo {
	pid: number;
	parentPid: number;
	user: string;
	state: string;
	elapsed: string;
	executable: string;
	command: string;
}

const ProcessObserveParams = Type.Object({
	operation: Type.Union([Type.Literal("list"), Type.Literal("find"), Type.Literal("pid")]),
	query: Type.Optional(Type.String({ description: "Case-insensitive executable, command, or user filter for find" })),
	pid: Type.Optional(Type.Integer({ minimum: 1, description: "Exact process ID for pid" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum results; default 25" })),
});

function parseProcesses(output: string): ProcessInfo[] {
	return output.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
		if (!match) return [];
		return [{
			pid: Number(match[1]),
			parentPid: Number(match[2]),
			user: match[3],
			state: match[4],
			elapsed: match[5],
			executable: match[6],
			command: match[7] || match[6],
		}];
	});
}

export async function observeProcesses(params: ProcessObserveParams, signal?: AbortSignal) {
	if (process.platform !== "linux" && process.platform !== "darwin") {
		const observation = unsupported("process observation");
		return { operation: params.operation, supported: false, complete: false, incompleteReasons: observation.incompleteReasons, processes: [], observation };
	}
	if (params.operation === "find" && !params.query?.trim()) throw new Error("process_observe find requires query");
	if (params.operation === "pid" && !params.pid) throw new Error("process_observe pid requires pid");
	const format = process.platform === "linux"
		? "pid=,ppid=,user=,stat=,etimes=,comm=,args="
		: "pid=,ppid=,user=,stat=,etime=,comm=,args=";
	const fields = params.operation === "pid"
		? ["-p", String(params.pid), "-o", format]
		: [process.platform === "linux" ? "-eo" : "-axo", format];
	const observation = await runObservation("ps", fields, { signal });
	let processes = observation.supported ? parseProcesses(observation.stdout) : [];
	if (params.operation === "find") {
		const needle = params.query!.trim().toLowerCase();
		processes = processes.filter((item) => `${item.user} ${item.executable} ${item.command}`.toLowerCase().includes(needle));
	}
	if (params.operation === "pid") processes = processes.filter((item) => item.pid === params.pid);
	const limit = params.limit ?? 25;
	const matchedProcesses = processes.length;
	const resultLimited = matchedProcesses > limit;
	processes = processes.slice(0, limit);
	const incompleteReasons = [...observation.incompleteReasons];
	if (resultLimited) incompleteReasons.push("result-limit");
	return {
		operation: params.operation,
		supported: observation.supported,
		complete: observation.complete && !resultLimited,
		incompleteReasons,
		matchedProcesses,
		resultLimit: limit,
		processes,
		observation: observationMetadata(observation),
	};
}

export async function processByPid(pid: number, signal?: AbortSignal): Promise<ProcessInfo | undefined> {
	const result = await observeProcesses({ operation: "pid", pid }, signal);
	return result.processes[0];
}

export function registerProcessObserve(pi: PiExtensionAPI): void {
	pi.registerTool<ProcessObserveParams>({
		name: "process_observe",
		label: "Process Observe",
		description:
			"Read a bounded process snapshot by list, text match, or PID. Returns PID, parent, owner, state, elapsed time, executable, command, platform support, and completeness without running arbitrary shell code.",
		parameters: ProcessObserveParams,
		async execute(_toolCallId, params, signal) {
			const result = await observeProcesses(params, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
