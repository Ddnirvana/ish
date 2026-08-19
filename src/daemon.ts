import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ContextJournal } from "./context.js";
import { CapsuleActionStore, newCapsuleId } from "./capsules.js";
import { IntentStore } from "./store.js";
import type { IntentRecord, IntentRequest, IntentResponse, RunnerConfig, SubmitIntent } from "./types.js";

export interface IntentDaemonOptions {
	socketPath: string;
	stateDir: string;
	runner: RunnerConfig;
	maxConcurrency?: number;
}

function now(): string {
	return new Date().toISOString();
}

function isAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class IntentDaemon {
	private readonly store: IntentStore;
	private readonly context: ContextJournal;
	private readonly capsules: CapsuleActionStore;
	private readonly children = new Map<string, ChildProcess>();
	private server?: Server;
	private stopping = false;

	constructor(private readonly options: IntentDaemonOptions) {
		this.store = new IntentStore(options.stateDir);
		this.context = new ContextJournal(options.stateDir);
		this.capsules = new CapsuleActionStore(options.stateDir);
	}

	async start(): Promise<void> {
		await this.store.initialize();
		await this.context.initialize();
		await this.capsules.initialize();
		await this.reconcileInterruptedWorkers();
		await mkdir(path.dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
		try {
			await stat(this.options.socketPath);
			throw new Error(`socket already exists: ${this.options.socketPath}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		this.server = net.createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.options.socketPath, () => resolve());
		});
		await chmod(this.options.socketPath, 0o600);
		await this.pump();
	}

	async stop(terminateWorkers = true): Promise<void> {
		this.stopping = true;
		if (terminateWorkers) {
			const exiting: Promise<void>[] = [];
			for (const [id, child] of this.children) {
				this.killChild(child);
				exiting.push(this.waitForChildExit(child));
				const record = this.store.get(id);
				if (record && record.status === "running") {
					record.status = "interrupted";
					record.error = "intentd stopped while the worker was running";
					record.updatedAt = now();
					await this.store.set(record);
				}
			}
			await Promise.all(exiting);
		}
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
		});
		await rm(this.options.socketPath, { force: true });
	}

	private accept(socket: Socket): void {
		let buffer = "";
		let handled = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!handled && buffer.includes("\n")) {
				handled = true;
				void this.respond(socket, buffer.split("\n", 1)[0]);
			}
		});
	}

	private async respond(socket: Socket, line: string): Promise<void> {
			let response: IntentResponse;
			try {
				if (!line) throw new Error("empty request");
				response = { ok: true, data: await this.handle(JSON.parse(line) as IntentRequest) };
			} catch (error) {
				response = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			socket.end(`${JSON.stringify(response)}\n`);
	}

	private async handle(request: IntentRequest): Promise<unknown> {
		switch (request.action) {
			case "ping":
				return { pid: process.pid };
			case "capsule-new-id":
				return { id: newCapsuleId() };
			case "capsule-register":
				return this.capsules.register(request.capsule);
			case "capsule-update":
				return this.capsules.update(request.capsule);
			case "capsule-heartbeat":
				return this.capsules.heartbeat(request.id);
			case "capsule-unregister":
				return this.capsules.unregister(request.id);
			case "capsule-list":
				return this.capsules.listCapsules(request.includeOffline);
			case "action-create":
				return this.capsules.createAction(request.input);
			case "action-dispatch":
				return this.capsules.dispatchAction(request.id);
			case "action-approve":
				return this.capsules.approveAction(request.input);
			case "action-cancel":
				return this.capsules.cancelAction(request.id, request.witness);
			case "action-list":
				return this.capsules.listActions();
			case "action-get":
				return this.capsules.getAction(request.id);
			case "action-admit":
				return this.capsules.admit(request.input);
			case "action-report":
				return this.capsules.report(request.input);
			case "record-context":
				return this.context.append(request.event);
			case "query-context":
				return this.context.query(request.query);
			case "submit":
				return this.submit(request.intent);
			case "list":
				return this.store.list();
			case "get":
				return this.requireRecord(request.id);
			case "logs":
				return this.logs(request.id, request.tail ?? 80);
			case "cancel":
				return this.cancel(request.id);
			case "retry":
				return this.retry(request.id);
		}
	}

	private async submit(input: SubmitIntent): Promise<IntentRecord> {
		if (!input.objective.trim()) throw new Error("objective is required");
		if (!path.isAbsolute(input.cwd)) throw new Error("cwd must be absolute");
		await stat(input.cwd);

		const id = `in_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const timestamp = now();
		const record: IntentRecord = {
			id,
			objective: input.objective.trim(),
			acceptance: input.acceptance?.filter(Boolean) ?? [],
			cwd: input.cwd,
			requester: input.requester,
			status: "queued",
			createdAt: timestamp,
			updatedAt: timestamp,
			attempt: 0,
			logPath: path.join(this.options.stateDir, "logs", `${id}.log`),
		};
		await this.store.set(record);
		await this.pump();
		return this.requireRecord(id);
	}

	private async retry(id: string): Promise<IntentRecord> {
		const record = this.requireRecord(id);
		if (["queued", "running"].includes(record.status)) {
			throw new Error(`intent ${id} is already ${record.status}`);
		}
		if (isAlive(record.pid)) {
			throw new Error(`intent ${id} still has a live worker pid ${record.pid}; cancel it before retrying`);
		}
		record.status = "queued";
		record.updatedAt = now();
		record.error = undefined;
		record.exitCode = undefined;
		record.pid = undefined;
		await this.store.set(record);
		await this.pump();
		return this.requireRecord(id);
	}

	private async cancel(id: string): Promise<IntentRecord> {
		const record = this.requireRecord(id);
		if (["succeeded", "failed", "cancelled"].includes(record.status)) return record;
		record.status = "cancelled";
		record.updatedAt = now();
		record.error = "cancelled by client";
		await this.store.set(record);
		const child = this.children.get(id);
		if (child) {
			this.killChild(child);
			await this.waitForChildExit(child);
		}
		else if (isAlive(record.pid)) this.killPid(record.pid!);
		return record;
	}

	private async waitForChildExit(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 5000);
			timer.unref();
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			child.once("error", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private async logs(id: string, tail: number): Promise<{ id: string; text: string }> {
		const record = this.requireRecord(id);
		const boundedTail = Math.max(1, Math.min(1000, tail));
		try {
			const lines = (await readFile(record.logPath, "utf8")).split("\n");
			return { id, text: lines.slice(-boundedTail - 1).join("\n") };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id, text: "" };
			throw error;
		}
	}

	private async pump(): Promise<void> {
		if (this.stopping) return;
		const limit = this.options.maxConcurrency ?? 1;
		while (this.children.size < limit) {
			const next = this.store.list().reverse().find((record) => record.status === "queued");
			if (!next) return;
			await this.launch(next);
		}
	}

	private async launch(record: IntentRecord): Promise<void> {
		await mkdir(path.dirname(record.logPath), { recursive: true, mode: 0o700 });
		let runnerArgs: string[];
		let runnerEnvironment: NodeJS.ProcessEnv;
		try {
			runnerArgs = typeof this.options.runner.args === "function"
				? await this.options.runner.args()
				: this.options.runner.args;
			runnerEnvironment = this.options.runner.environment
				? await this.options.runner.environment()
				: process.env;
		} catch (error) {
			record.status = "failed";
			record.updatedAt = now();
			record.error = `runner configuration failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.store.set(record);
			await appendFile(record.logPath, `\n=== failed ${record.updatedAt} ===\n${record.error}\n`, { mode: 0o600 });
			return;
		}
		record.status = "running";
		record.attempt += 1;
		record.updatedAt = now();
		await appendFile(
			record.logPath,
			`\n=== attempt ${record.attempt} ${record.updatedAt} ===\nobjective: ${record.objective}\n`,
			{ mode: 0o600 },
		);

		const prompt = record.acceptance.length
			? `${record.objective}\n\nAcceptance criteria:\n${record.acceptance.map((item) => `- ${item}`).join("\n")}`
			: record.objective;
		const child = spawn(this.options.runner.command, [...runnerArgs, "--mode", "json", "-p", prompt], {
			cwd: record.cwd,
			env: runnerEnvironment,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		record.pid = child.pid;
		await this.store.set(record);
		this.children.set(record.id, child);

		child.stdout?.on("data", (chunk) => void appendFile(record.logPath, chunk));
		child.stderr?.on("data", (chunk) => void appendFile(record.logPath, chunk));
		child.once("error", (error) => void this.finish(record.id, null, error.message));
		child.once("close", (code, signal) =>
			void this.finish(record.id, code, signal ? `worker terminated by ${signal}` : undefined),
		);
	}

	private async finish(id: string, exitCode: number | null, error?: string): Promise<void> {
		this.children.delete(id);
		const record = this.store.get(id);
		if (!record || record.status !== "running") {
			await this.pump();
			return;
		}
		record.exitCode = exitCode;
		record.updatedAt = now();
		record.status = exitCode === 0 && !error ? "succeeded" : "failed";
		record.error = error ?? (exitCode === 0 ? undefined : `worker exited with code ${exitCode}`);
		await this.store.set(record);
		await appendFile(record.logPath, `\n=== ${record.status} ${record.updatedAt} ===\n`);
		await this.pump();
	}

	private requireRecord(id: string): IntentRecord {
		const record = this.store.get(id);
		if (!record) throw new Error(`unknown intent: ${id}`);
		return record;
	}

	private async reconcileInterruptedWorkers(): Promise<void> {
		for (const record of this.store.list()) {
			if (record.status !== "running") continue;
			record.status = "interrupted";
			record.updatedAt = now();
			record.error = isAlive(record.pid)
				? `intentd restarted; worker pid ${record.pid} may still be alive`
				: "intentd restarted after the worker exited without a recorded result";
			await this.store.set(record);
		}
	}

	private killChild(child: ChildProcess): void {
		if (child.pid) this.killPid(child.pid);
	}

	private killPid(pid: number): void {
		try {
			process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}
