import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ObservationLimits {
	timeoutMs: number;
	maxOutputBytes: number;
}

export interface CommandObservation {
	platform: NodeJS.Platform;
	command: string;
	exitCode: number | null;
	durationMs: number;
	timeoutMs: number;
	maxOutputBytes: number;
	outputBytes: number;
	truncated: boolean;
	timedOut: boolean;
	supported: boolean;
	complete: boolean;
	incompleteReasons: string[];
	stdout: string;
	stderr: string;
}

export interface RunObservationOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	env?: NodeJS.ProcessEnv;
	retain?: "head" | "tail";
}

export type ObservationMetadata = Omit<CommandObservation, "stdout" | "stderr"> & { error?: string };

export function observationMetadata(observation: CommandObservation): ObservationMetadata {
	const { stdout: _stdout, stderr, ...metadata } = observation;
	return { ...metadata, ...(stderr.trim() ? { error: stderr.trim() } : {}) };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
		throw new Error(`${name} must be an integer from 1 to ${maximum}`);
	}
	return resolved;
}

function abortError(): Error {
	const error = new Error("system observation cancelled");
	error.name = "AbortError";
	return error;
}

export async function runObservation(
	command: string,
	args: string[],
	options: RunObservationOptions = {},
): Promise<CommandObservation> {
	if (options.signal?.aborted) throw abortError();
	const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
	const maxOutputBytes = boundedInteger(
		options.maxOutputBytes,
		DEFAULT_MAX_OUTPUT_BYTES,
		MAX_OUTPUT_BYTES,
		"maxOutputBytes",
	);
	const started = Date.now();
	let stdout = Buffer.alloc(0);
	let stderr = Buffer.alloc(0);
	let outputBytes = 0;
	let truncated = false;
	let timedOut = false;

	return await new Promise<CommandObservation>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const append = (destination: "stdout" | "stderr", chunk: Buffer) => {
			outputBytes += chunk.length;
			if (options.retain === "tail") {
				if (destination === "stdout") {
					stdout = Buffer.concat([stdout, chunk]);
					if (stdout.length > maxOutputBytes) stdout = stdout.subarray(stdout.length - maxOutputBytes);
				} else {
					stderr = Buffer.concat([stderr, chunk]);
					if (stderr.length > maxOutputBytes) stderr = stderr.subarray(stderr.length - maxOutputBytes);
				}
				truncated ||= outputBytes > maxOutputBytes;
				return;
			}
			const retained = stdout.length + stderr.length;
			const allowance = Math.max(0, maxOutputBytes - retained);
			if (chunk.length > allowance) truncated = true;
			const slice = chunk.subarray(0, allowance);
			if (destination === "stdout") stdout = Buffer.concat([stdout, slice]);
			else stderr = Buffer.concat([stderr, slice]);
		};
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

		const finish = (exitCode: number | null, supported = true, spawnError?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (spawnError && (spawnError as NodeJS.ErrnoException).code !== "ENOENT") {
				reject(spawnError);
				return;
			}
			if (options.retain === "tail" && stdout.length + stderr.length > maxOutputBytes) {
				if (stdout.length >= maxOutputBytes) {
					stdout = stdout.subarray(stdout.length - maxOutputBytes);
					stderr = Buffer.alloc(0);
				} else {
					stderr = stderr.subarray(Math.max(0, stderr.length - (maxOutputBytes - stdout.length)));
				}
			}
			const incompleteReasons: string[] = [];
			if (!supported) incompleteReasons.push("unsupported-command");
			if (timedOut) incompleteReasons.push("timeout");
			if (truncated) incompleteReasons.push("output-limit");
			if (supported && exitCode !== 0 && !timedOut) incompleteReasons.push(`exit-status-${exitCode ?? "unknown"}`);
			resolve({
				platform: process.platform,
				command,
				exitCode,
				durationMs: Date.now() - started,
				timeoutMs,
				maxOutputBytes,
				outputBytes,
				truncated,
				timedOut,
				supported,
				complete: incompleteReasons.length === 0,
				incompleteReasons,
				stdout: stdout.toString("utf8"),
				stderr: supported ? stderr.toString("utf8") : (spawnError?.message ?? "command unavailable"),
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
			killTimer.unref();
		}, timeoutMs);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGTERM");
			const force = setTimeout(() => child.kill("SIGKILL"), 250);
			force.unref();
			reject(abortError());
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => finish(null, (error as NodeJS.ErrnoException).code !== "ENOENT", error));
		child.once("close", (code) => finish(code));
	});
}

export function unsupported(domain: string): CommandObservation {
	return {
		platform: process.platform,
		command: domain,
		exitCode: null,
		durationMs: 0,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
		outputBytes: 0,
		truncated: false,
		timedOut: false,
		supported: false,
		complete: false,
		incompleteReasons: [`unsupported-platform-${process.platform}`],
		stdout: "",
		stderr: `${domain} is not supported on ${process.platform}`,
	};
}
