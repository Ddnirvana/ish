import { Type } from "typebox";
import type { PiExtensionAPI } from "../../src/pi-types.js";
import { processByPid, type ProcessInfo } from "./process.js";
import { observationMetadata, runObservation, unsupported, type CommandObservation } from "./runner.js";

interface NetworkObserveParams extends Record<string, unknown> {
	operation: "listening_port";
	port: number;
	protocol?: "tcp";
}

interface Listener {
	protocol: "tcp";
	endpoint: string;
	state: string;
	pid?: number;
	program?: string;
	owner?: ProcessInfo;
}

const NetworkObserveParams = Type.Object({
	operation: Type.Literal("listening_port"),
	port: Type.Integer({ minimum: 1, maximum: 65535, description: "Local TCP port" }),
	protocol: Type.Optional(Type.Literal("tcp")),
});

function parseSs(output: string, port: number): Listener[] {
	return output.split("\n").flatMap((line) => {
		if (!line.trim()) return [];
		const tokens = line.trim().split(/\s+/);
		const endpoint = tokens.find((token) => token.endsWith(`:${port}`)) ?? `:${port}`;
		const pids = [...line.matchAll(/\bpid=(\d+)/g)].map((match) => Number(match[1]));
		const program = line.match(/users:\(\(\"([^\"]+)\"/)?.[1];
		return (pids.length ? pids : [undefined]).map((pid) => ({
			protocol: "tcp" as const,
			endpoint,
			state: tokens[0] || "LISTEN",
			pid,
			program,
		}));
	});
}

function parseLsof(output: string, port: number): Listener[] {
	const listeners: Listener[] = [];
	let current: Listener | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			current = { protocol: "tcp", endpoint: `:${port}`, state: "LISTEN", pid: Number(line.slice(1)) };
			listeners.push(current);
		} else if (current && line.startsWith("c")) current.program = line.slice(1);
		else if (current && line.startsWith("n")) current.endpoint = line.slice(1);
	}
	return listeners;
}

async function collect(port: number, signal?: AbortSignal): Promise<{ listeners: Listener[]; observation: CommandObservation }> {
	if (process.platform === "linux") {
		const ss = await runObservation("ss", ["-H", "-ltnp", "sport", "=", `:${port}`], { signal });
		if (ss.supported) return { listeners: parseSs(ss.stdout, port), observation: ss };
	}
	if (process.platform === "linux" || process.platform === "darwin") {
		const lsof = await runObservation("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"], { signal });
		if (lsof.supported) {
			const normalized = lsof.exitCode === 1 && !lsof.stdout.trim()
				? { ...lsof, complete: true, incompleteReasons: [] }
				: lsof;
			return { listeners: parseLsof(lsof.stdout, port), observation: normalized };
		}
	}
	return { listeners: [], observation: unsupported("TCP listener observation") };
}

export async function observeNetwork(params: NetworkObserveParams, signal?: AbortSignal) {
	const { listeners, observation } = await collect(params.port, signal);
	for (const listener of listeners) {
		if (!listener.pid) continue;
		listener.owner = await processByPid(listener.pid, signal);
	}
	const ownerMissing = listeners.some((listener) => listener.pid !== undefined && !listener.owner);
	const incompleteReasons = [...observation.incompleteReasons];
	if (ownerMissing) incompleteReasons.push("process-owner-unavailable");
	return {
		operation: params.operation,
		port: params.port,
		protocol: "tcp",
		supported: observation.supported,
		complete: observation.complete && !ownerMissing,
		incompleteReasons,
		listeners,
		observation: observationMetadata(observation),
	};
}

export function registerNetworkObserve(pi: PiExtensionAPI): void {
	pi.registerTool<NetworkObserveParams>({
		name: "network_observe",
		label: "Network Observe",
		description:
			"Find the local process listening on an exact TCP port and report its PID, program, owner, parent, and command. Read-only; reports when platform tools or ownership data are unavailable.",
		parameters: NetworkObserveParams,
		async execute(_toolCallId, params, signal) {
			const result = await observeNetwork(params, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
