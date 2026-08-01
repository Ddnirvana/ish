import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type ContextEventKind =
	| "agent-request"
	| "agent-response"
	| "intent-event"
	| "native-command"
	| "topology-note";

export type ContextSensitivity = "private" | "secret" | "system";

export interface ContextScope {
	host: string;
	tmuxServer?: string;
	session?: string;
	window?: string;
	pane?: string;
	cwd?: string;
	intentId?: string;
}

export interface ContextEvent {
	id: string;
	timestamp: string;
	kind: ContextEventKind;
	scope: ContextScope;
	content: string;
	sensitivity: ContextSensitivity;
	provenance: string;
}

export interface RecordContextEvent {
	kind: ContextEventKind;
	scope: ContextScope;
	content: string;
	sensitivity?: ContextSensitivity;
	provenance: string;
}

export interface ContextQuery {
	scope: ContextScope;
	limit?: number;
	includeSecrets?: boolean;
}

function sameOrUnspecified(expected: string | undefined, actual: string | undefined): boolean {
	return expected === undefined || expected === actual;
}

function cwdContains(parent: string | undefined, child: string | undefined): boolean {
	if (parent === undefined) return true;
	if (child === undefined) return false;
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function visible(event: ContextEvent, query: ContextQuery): boolean {
	const expected = event.scope;
	const actual = query.scope;
	return (
		expected.host === actual.host &&
		sameOrUnspecified(expected.tmuxServer, actual.tmuxServer) &&
		sameOrUnspecified(expected.session, actual.session) &&
		sameOrUnspecified(expected.window, actual.window) &&
		sameOrUnspecified(expected.pane, actual.pane) &&
		sameOrUnspecified(expected.intentId, actual.intentId) &&
		cwdContains(expected.cwd, actual.cwd) &&
		(query.includeSecrets === true || event.sensitivity !== "secret")
	);
}

function specificity(event: ContextEvent): number {
	return Object.values(event.scope).filter((value) => value !== undefined).length;
}

export function selectContext(events: ContextEvent[], query: ContextQuery): ContextEvent[] {
	const limit = Math.max(1, Math.min(1000, query.limit ?? 100));
	return events
		.filter((event) => visible(event, query))
		.sort((a, b) => specificity(b) - specificity(a) || b.timestamp.localeCompare(a.timestamp))
		.slice(0, limit)
		.map((event) => structuredClone(event));
}

export class ContextJournal {
	private events: ContextEvent[] = [];
	private appendChain: Promise<void> = Promise.resolve();

	constructor(private readonly stateDir: string) {}

	get journalPath(): string {
		return path.join(this.stateDir, "context.jsonl");
	}

	async initialize(): Promise<void> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		try {
			const lines = (await readFile(this.journalPath, "utf8")).split("\n").filter(Boolean);
			this.events = lines.map((line) => JSON.parse(line) as ContextEvent);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async append(input: RecordContextEvent): Promise<ContextEvent> {
		if (!input.scope.host) throw new Error("context scope requires a host");
		if (!input.content.trim()) throw new Error("context content is required");
		const event: ContextEvent = {
			...input,
			id: `cx_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
			timestamp: new Date().toISOString(),
			content: input.content.trim(),
			sensitivity: input.sensitivity ?? "private",
		};
		this.events.push(event);
		this.appendChain = this.appendChain.then(() =>
			appendFile(this.journalPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
		);
		await this.appendChain;
		return structuredClone(event);
	}

	query(query: ContextQuery): ContextEvent[] {
		return selectContext(this.events, query);
	}
}
