import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessRisk, type RiskAssessment } from "./risk.js";

export type CapsuleMode = "prompt" | "running" | "offline";
export type LineEditorState = "ready" | "busy" | "inactive";
export type EffectClass = "observation" | "effectful" | "unsafe";
export type ActionTargetState =
	| "planned"
	| "dispatched"
	| "admitted"
	| "running"
	| "succeeded"
	| "failed"
	| "stale"
	| "busy"
	| "denied"
	| "cancelled"
	| "unreached"
	| "uncertain";
export type ActionStatus = "planned" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | "uncertain";
export type ActionApproval = "not-required" | "pending" | "approved" | "cancelled";

export interface CapsuleScope {
	host: string;
	bootId: string;
	shell: string;
	tmuxServer?: string;
	session?: string;
	window?: string;
	pane?: string;
}

export interface CapsuleRecord extends CapsuleScope {
	id: string;
	pid: number;
	processStart: string;
	endpoint: string;
	generation: number;
	cwd: string;
	cwdToken: string;
	mode: CapsuleMode;
	lineEditor: LineEditorState;
	authority: string;
	registeredAt: string;
	lastSeenAt: string;
}

export interface RegisterCapsule extends CapsuleScope {
	id: string;
	pid: number;
	processStart: string;
	endpoint: string;
	generation: number;
	cwd: string;
	mode?: CapsuleMode;
	lineEditor?: LineEditorState;
	authority: string;
}

export interface UpdateCapsule {
	id: string;
	generation?: number;
	cwd?: string;
	mode?: CapsuleMode;
	lineEditor?: LineEditorState;
}

export interface ActionTarget {
	capsuleId: string;
	host: string;
	session?: string;
	window?: string;
	pane?: string;
	expectedGeneration: number;
	expectedCwd: string;
	expectedCwdToken: string;
	state: ActionTargetState;
	updatedAt: string;
	witness?: string;
	exitCode?: number;
	output?: string;
}

export interface ActionRecord {
	id: string;
	selector: string;
	command: string;
	effectClass: EffectClass;
	reason: string;
	resources: string[];
	provenance: string;
	risk: RiskAssessment;
	approval: ActionApproval;
	approvalUpdatedAt?: string;
	approvalWitness?: string;
	status: ActionStatus;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
	targets: ActionTarget[];
}

export interface CreateAction {
	selector: string;
	command: string;
	effectClass: EffectClass;
	reason?: string;
	resources?: string[];
	provenance?: string;
	requireApproval?: boolean;
	ttlMs?: number;
}

export interface ApproveAction {
	actionId: string;
	capsuleId: string;
	generation: number;
	cwdToken: string;
}

export interface AdmitAction {
	actionId: string;
	capsuleId: string;
	generation: number;
	cwdToken: string;
	lineEditorReady: boolean;
}

export interface ReportAction {
	actionId: string;
	capsuleId: string;
	state: Extract<ActionTargetState, "running" | "succeeded" | "failed" | "stale" | "busy" | "denied" | "uncertain">;
	witness?: string;
	exitCode?: number;
	output?: string;
}

interface CapsuleFile {
	version: 1 | 2;
	capsules: CapsuleRecord[];
	actions: ActionRecord[];
}

const TERMINAL_TARGETS = new Set<ActionTargetState>([
	"succeeded",
	"failed",
	"stale",
	"busy",
	"denied",
	"cancelled",
	"unreached",
	"uncertain",
]);
const ACTIVE_TTL_MS = 30_000;

function now(): string {
	return new Date().toISOString();
}

export function cwdToken(cwd: string): string {
	let identity = cwd;
	try {
		const resolved = realpathSync(cwd);
		const metadata = statSync(resolved);
		identity = `${cwd}\0${resolved}\0${metadata.dev}:${metadata.ino}`;
	} catch {
		// Nonexistent test paths retain the stable lexical witness.
	}
	return createHash("sha256").update(identity).digest("hex");
}

export function newCapsuleId(): string {
	return `sh_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function actionStatus(targets: ActionTarget[]): ActionStatus {
	if (targets.length === 0 || targets.every((target) => target.state === "planned")) return "planned";
	if (targets.every((target) => target.state === "cancelled")) return "cancelled";
	if (targets.every((target) => target.state === "succeeded")) return "succeeded";
	if (targets.some((target) => ["dispatched", "admitted", "running"].includes(target.state))) return "running";
	if (targets.some((target) => target.state === "uncertain")) return "uncertain";
	if (targets.some((target) => target.state === "succeeded")) return "partial";
	return "failed";
}

function isActive(capsule: CapsuleRecord): boolean {
	return capsule.mode !== "offline" && Date.now() - Date.parse(capsule.lastSeenAt) <= ACTIVE_TTL_MS;
}

function matches(capsule: CapsuleRecord, selector: string): boolean {
	if (selector === "all") return true;
	if (selector.startsWith("capsule:")) return capsule.id === selector.slice("capsule:".length);
	if (selector.startsWith("pane:")) return capsule.pane === selector.slice("pane:".length);
	if (selector.startsWith("session:")) return capsule.session === selector.slice("session:".length);
	if (selector.startsWith("host:")) return capsule.host === selector.slice("host:".length);
	if (selector.startsWith("window:")) {
		const value = selector.slice("window:".length);
		return capsule.window === value || `${capsule.session ?? ""}:${capsule.window ?? ""}` === value;
	}
	throw new Error(`unsupported capsule selector: ${selector}`);
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

export class CapsuleActionStore {
	private readonly capsules = new Map<string, CapsuleRecord>();
	private readonly actions = new Map<string, ActionRecord>();
	private persistChain: Promise<void> = Promise.resolve();

	constructor(readonly stateDir: string) {}

	get statePath(): string {
		return path.join(this.stateDir, "capsules-actions.json");
	}

	async initialize(): Promise<void> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		try {
			const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as CapsuleFile;
			if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.capsules) || !Array.isArray(parsed.actions)) {
				throw new Error("unsupported capsule/action store format");
			}
			for (const capsule of parsed.capsules) {
				// Preserve the last shell witness across a daemon-only restart. The
				// heartbeat TTL and nonblocking FIFO open are the liveness checks;
				// nonterminal action state is reconciled separately below.
				this.capsules.set(capsule.id, capsule);
			}
			for (const action of parsed.actions) {
				action.reason ??= "";
				action.resources ??= [];
				action.provenance ??= "legacy";
				action.risk ??= assessRisk(action.command);
				action.approval ??= "not-required";
				let changed = false;
				for (const target of action.targets) {
					if (!TERMINAL_TARGETS.has(target.state) && target.state !== "planned") {
						target.state = "uncertain";
						target.witness = "intentd restarted without a terminal target acknowledgment";
						target.updatedAt = now();
						changed = true;
					}
				}
				if (changed) {
					action.updatedAt = now();
					action.status = actionStatus(action.targets);
				}
				this.actions.set(action.id, action);
			}
			await this.persist();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	listCapsules(includeOffline = false): CapsuleRecord[] {
		return [...this.capsules.values()]
			.filter((capsule) => includeOffline || isActive(capsule))
			.map((capsule) => structuredClone(capsule))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	async register(input: RegisterCapsule): Promise<CapsuleRecord> {
		if (!/^sh_[a-f0-9]{20}$/.test(input.id)) throw new Error("invalid capsule ID");
		if (!input.host || !input.bootId || !input.shell || !input.authority) throw new Error("capsule identity is incomplete");
		if (!Number.isInteger(input.pid) || input.pid <= 0) throw new Error("capsule pid must be positive");
		if (!Number.isInteger(input.generation) || input.generation < 0) throw new Error("capsule generation must be non-negative");
		if (!path.isAbsolute(input.cwd) || !path.isAbsolute(input.endpoint)) throw new Error("capsule cwd and endpoint must be absolute");
		const endpoint = await lstat(input.endpoint);
		if (!endpoint.isFIFO()) throw new Error("capsule endpoint must be a FIFO");
		const timestamp = now();
		const existing = this.capsules.get(input.id);
		const record: CapsuleRecord = {
			...input,
			cwdToken: cwdToken(input.cwd),
			mode: input.mode ?? "prompt",
			lineEditor: input.lineEditor ?? "ready",
			registeredAt: existing?.registeredAt ?? timestamp,
			lastSeenAt: timestamp,
		};
		this.capsules.set(record.id, record);
		await this.persist();
		return structuredClone(record);
	}

	async update(input: UpdateCapsule): Promise<CapsuleRecord> {
		const record = this.requireCapsule(input.id);
		if (input.generation !== undefined) {
			if (!Number.isInteger(input.generation) || input.generation < record.generation) {
				throw new Error("capsule generation cannot move backward");
			}
			record.generation = input.generation;
		}
		if (input.cwd !== undefined) {
			if (!path.isAbsolute(input.cwd)) throw new Error("capsule cwd must be absolute");
			record.cwd = input.cwd;
			record.cwdToken = cwdToken(input.cwd);
		}
		if (input.mode !== undefined) record.mode = input.mode;
		if (input.lineEditor !== undefined) record.lineEditor = input.lineEditor;
		record.lastSeenAt = now();
		await this.persist();
		return structuredClone(record);
	}

	async heartbeat(id: string): Promise<CapsuleRecord> {
		const record = this.requireCapsule(id);
		record.lastSeenAt = now();
		await this.persist();
		return structuredClone(record);
	}

	async unregister(id: string): Promise<CapsuleRecord> {
		const record = this.requireCapsule(id);
		record.mode = "offline";
		record.lineEditor = "inactive";
		record.lastSeenAt = now();
		await this.persist();
		return structuredClone(record);
	}

	listActions(): ActionRecord[] {
		return [...this.actions.values()]
			.map((action) => structuredClone(action))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	getAction(id: string): ActionRecord {
		return structuredClone(this.requireAction(id));
	}

	async createAction(input: CreateAction): Promise<ActionRecord> {
		const command = input.command;
		if (!command.trim()) throw new Error("action command is required");
		if (!["observation", "effectful", "unsafe"].includes(input.effectClass)) throw new Error("invalid effect class");
		const risk = assessRisk(command);
		if (risk.level === "critical" && input.effectClass !== "unsafe") {
			throw new Error(`critical-risk command requires unsafe effect class: ${risk.rule}`);
		}
		this.validateEffectClass(command, input.effectClass);
		const selected = this.listCapsules().filter((capsule) => matches(capsule, input.selector));
		if (selected.length === 0) throw new Error(`selector matched no active capsules: ${input.selector}`);
		const timestamp = now();
		const ttlMs = Math.max(100, Math.min(600_000, input.ttlMs ?? 30_000));
		const action: ActionRecord = {
			id: `op_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
			selector: input.selector,
			command,
			effectClass: input.effectClass,
			reason: input.reason?.trim() ?? "",
			resources: [...new Set((input.resources ?? []).map((resource) => resource.trim()).filter(Boolean))],
			provenance: input.provenance?.trim() || "ishctl",
			risk,
			approval: input.requireApproval ? "pending" : "not-required",
			status: "planned",
			createdAt: timestamp,
			updatedAt: timestamp,
			expiresAt: new Date(Date.now() + ttlMs).toISOString(),
			targets: selected.map((capsule) => ({
				capsuleId: capsule.id,
				host: capsule.host,
				session: capsule.session,
				window: capsule.window,
				pane: capsule.pane,
				expectedGeneration: capsule.generation,
				expectedCwd: capsule.cwd,
				expectedCwdToken: capsule.cwdToken,
				state: "planned",
				updatedAt: timestamp,
			})),
		};
		this.actions.set(action.id, action);
		await this.persist();
		return structuredClone(action);
	}

	async dispatchAction(id: string): Promise<ActionRecord> {
		const action = this.requireAction(id);
		if (action.approval === "pending") throw new Error(`action ${id} requires interactive ish approval`);
		if (action.approval === "cancelled") throw new Error(`action ${id} was cancelled`);
		if (action.effectClass === "unsafe") throw new Error("unsafe actions cannot be dispatched automatically");
		if (Date.now() > Date.parse(action.expiresAt)) {
			for (const target of action.targets) {
				if (target.state === "planned") this.rejectTarget(target, "stale", "action expired before dispatch");
			}
			await this.finishAction(action);
			return structuredClone(action);
		}

		for (const target of action.targets) {
			if (target.state !== "planned") continue;
			const capsule = this.capsules.get(target.capsuleId);
			if (!capsule || !isActive(capsule)) {
				this.rejectTarget(target, "unreached", "capsule is offline or heartbeat expired");
				continue;
			}
			if (capsule.generation !== target.expectedGeneration || capsule.cwdToken !== target.expectedCwdToken) {
				this.rejectTarget(
					target,
					"stale",
					`capsule changed before dispatch: generation ${target.expectedGeneration}->${capsule.generation}, cwd ${target.expectedCwd}->${capsule.cwd}`,
				);
				continue;
			}
			if (capsule.mode !== "prompt" || capsule.lineEditor !== "ready") {
				this.rejectTarget(target, "busy", `capsule mode=${capsule.mode}, lineEditor=${capsule.lineEditor}`);
				continue;
			}

			target.state = "dispatched";
			target.updatedAt = now();
			action.updatedAt = target.updatedAt;
			action.status = actionStatus(action.targets);
			await this.persist();
			try {
				await this.writeEnvelope(capsule, action, target);
			} catch (error) {
				this.rejectTarget(target, "unreached", `endpoint delivery failed: ${error instanceof Error ? error.message : String(error)}`);
				await this.persist();
			}
		}
		await this.finishAction(action);
		return structuredClone(action);
	}

	async approveAction(input: ApproveAction): Promise<ActionRecord> {
		const action = this.requireAction(input.actionId);
		if (action.approval !== "pending") throw new Error(`action ${action.id} approval is ${action.approval}`);
		if (action.effectClass === "unsafe") {
			await this.cancelAction(action.id, `unsafe proposal refused: ${action.risk.rule}`);
			throw new Error(`unsafe proposal cannot be approved: ${action.risk.rule}`);
		}
		const capsule = this.requireCapsule(input.capsuleId);
		this.requireTarget(action, input.capsuleId);
		if (capsule.generation !== input.generation || capsule.cwdToken !== input.cwdToken) {
			action.approvalUpdatedAt = now();
			action.approvalWitness = "interactive approval witness did not match the current shell";
			await this.persist();
			throw new Error(action.approvalWitness);
		}
		action.approval = "approved";
		action.approvalUpdatedAt = now();
		action.approvalWitness = `approved once by ${input.capsuleId} at generation ${input.generation}`;
		await this.persist();
		return this.dispatchAction(action.id);
	}

	async cancelAction(id: string, witness = "cancelled by user in ish"): Promise<ActionRecord> {
		const action = this.requireAction(id);
		if (action.approval !== "pending") throw new Error(`action ${action.id} approval is ${action.approval}`);
		action.approval = "cancelled";
		action.approvalUpdatedAt = now();
		action.approvalWitness = witness;
		for (const target of action.targets) {
			if (target.state === "planned") this.rejectTarget(target, "cancelled", witness);
		}
		await this.finishAction(action);
		return structuredClone(action);
	}

	async admit(input: AdmitAction): Promise<{ action: ActionRecord; execute: boolean; witness?: string }> {
		const action = this.requireAction(input.actionId);
		const target = this.requireTarget(action, input.capsuleId);
		if (["admitted", "running", "succeeded", "failed"].includes(target.state)) {
			return { action: structuredClone(action), execute: false, witness: "duplicate operation ID" };
		}
		if (target.state !== "dispatched") {
			return { action: structuredClone(action), execute: false, witness: `target state is ${target.state}` };
		}
		if (Date.now() > Date.parse(action.expiresAt)) {
			this.rejectTarget(target, "stale", "action expired before shell admission");
			await this.finishAction(action);
			return { action: structuredClone(action), execute: false, witness: target.witness };
		}
		if (!input.lineEditorReady) {
			this.rejectTarget(target, "busy", "shell line editor or user buffer is not eligible");
			await this.finishAction(action);
			return { action: structuredClone(action), execute: false, witness: target.witness };
		}
		if (input.generation !== target.expectedGeneration || input.cwdToken !== target.expectedCwdToken) {
			this.rejectTarget(
				target,
				"stale",
				`shell witness changed: generation ${target.expectedGeneration}->${input.generation}, cwdTokenMatch=${input.cwdToken === target.expectedCwdToken}`,
			);
			await this.finishAction(action);
			return { action: structuredClone(action), execute: false, witness: target.witness };
		}
		target.state = "admitted";
		target.updatedAt = now();
		action.updatedAt = target.updatedAt;
		action.status = actionStatus(action.targets);
		await this.persist();
		return { action: structuredClone(action), execute: true };
	}

	async report(input: ReportAction): Promise<ActionRecord> {
		const action = this.requireAction(input.actionId);
		const target = this.requireTarget(action, input.capsuleId);
		if (TERMINAL_TARGETS.has(target.state) && target.state !== "uncertain") return structuredClone(action);
		target.state = input.state;
		target.updatedAt = now();
		target.witness = input.witness;
		target.exitCode = input.exitCode;
		target.output = input.output?.slice(0, 65_536);
		await this.finishAction(action);
		return structuredClone(action);
	}

	private async writeEnvelope(capsule: CapsuleRecord, action: ActionRecord, target: ActionTarget): Promise<void> {
		const endpoint = await lstat(capsule.endpoint);
		if (!endpoint.isFIFO()) throw new Error("registered endpoint is no longer a FIFO");
		const fields = [
			"v1",
			action.id,
			target.capsuleId,
			String(target.expectedGeneration),
			target.expectedCwdToken,
			String(Date.parse(action.expiresAt)),
			action.effectClass,
			encode(action.command),
		];
		const handle = await open(capsule.endpoint, constants.O_WRONLY | constants.O_NONBLOCK);
		try {
			await handle.write(`${fields.join("\t")}\n`);
		} finally {
			await handle.close();
		}
	}

	private validateEffectClass(command: string, effectClass: EffectClass): void {
		const destructive = /(^|[;&|]\s*)(rm\s+-[^\n]*r[^\n]*f\s+\/|mkfs\b|shutdown\b|reboot\b|poweroff\b)|\bdd\s+if=|:\(\)\s*\{/i;
		if (destructive.test(command) && effectClass !== "unsafe") {
			throw new Error("command requires unsafe effect class and cannot be dispatched automatically");
		}
		if (effectClass === "observation" && /(^|[^<])>>?|\b(rm|mv|cp|install|mkdir|rmdir|touch|chmod|chown|kill|pkill|systemctl\s+(start|stop|restart|enable|disable)|apt|dnf|yum|pacman)\b|(^|[^&])&&|;/.test(command)) {
			throw new Error("observation action contains an effectful construct");
		}
	}

	private rejectTarget(target: ActionTarget, state: Extract<ActionTargetState, "stale" | "busy" | "denied" | "cancelled" | "unreached">, witness: string): void {
		target.state = state;
		target.witness = witness;
		target.updatedAt = now();
	}

	private async finishAction(action: ActionRecord): Promise<void> {
		action.updatedAt = now();
		action.status = actionStatus(action.targets);
		await this.persist();
	}

	private requireCapsule(id: string): CapsuleRecord {
		const record = this.capsules.get(id);
		if (!record) throw new Error(`unknown capsule: ${id}`);
		return record;
	}

	private requireAction(id: string): ActionRecord {
		const action = this.actions.get(id);
		if (!action) throw new Error(`unknown action: ${id}`);
		return action;
	}

	private requireTarget(action: ActionRecord, capsuleId: string): ActionTarget {
		const target = action.targets.find((candidate) => candidate.capsuleId === capsuleId);
		if (!target) throw new Error(`action ${action.id} does not target capsule ${capsuleId}`);
		return target;
	}

	private async persist(): Promise<void> {
		const snapshot: CapsuleFile = {
			version: 2,
			capsules: [...this.capsules.values()].map((value) => structuredClone(value)),
			actions: [...this.actions.values()].map((value) => structuredClone(value)),
		};
		this.persistChain = this.persistChain.then(async () => {
			const tempPath = `${this.statePath}.${process.pid}.tmp`;
			await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
			await rename(tempPath, this.statePath);
		});
		await this.persistChain;
	}
}
