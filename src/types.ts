import type { ContextQuery, RecordContextEvent } from "./context.js";
import type { AdmitAction, CreateAction, RegisterCapsule, ReportAction, UpdateCapsule } from "./capsules.js";

export type IntentStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface IntentRecord {
	id: string;
	objective: string;
	acceptance: string[];
	cwd: string;
	requester: string;
	status: IntentStatus;
	createdAt: string;
	updatedAt: string;
	attempt: number;
	pid?: number;
	exitCode?: number | null;
	error?: string;
	logPath: string;
}

export interface SubmitIntent {
	objective: string;
	acceptance?: string[];
	cwd: string;
	requester: string;
}

export type IntentRequest =
	| { action: "ping" }
	| { action: "capsule-new-id" }
	| { action: "capsule-register"; capsule: RegisterCapsule }
	| { action: "capsule-update"; capsule: UpdateCapsule }
	| { action: "capsule-heartbeat"; id: string }
	| { action: "capsule-unregister"; id: string }
	| { action: "capsule-list"; includeOffline?: boolean }
	| { action: "action-create"; input: CreateAction }
	| { action: "action-dispatch"; id: string }
	| { action: "action-list" }
	| { action: "action-get"; id: string }
	| { action: "action-admit"; input: AdmitAction }
	| { action: "action-report"; input: ReportAction }
	| { action: "record-context"; event: RecordContextEvent }
	| { action: "query-context"; query: ContextQuery }
	| { action: "submit"; intent: SubmitIntent }
	| { action: "list" }
	| { action: "get"; id: string }
	| { action: "logs"; id: string; tail?: number }
	| { action: "cancel"; id: string }
	| { action: "retry"; id: string };

export type IntentResponse =
	| { ok: true; data: unknown }
	| { ok: false; error: string };

export interface RunnerConfig {
	command: string;
	args: string[] | (() => Promise<string[]>);
	environment?: () => Promise<NodeJS.ProcessEnv>;
}
