import net from "node:net";
import type { ContextEvent, ContextQuery, RecordContextEvent } from "./context.js";
import type {
	ActionRecord,
	AdmitAction,
	ApproveAction,
	CapsuleRecord,
	CreateAction,
	RegisterCapsule,
	ReportAction,
	UpdateCapsule,
} from "./capsules.js";
import type { IntentRecord, IntentRequest, IntentResponse, SubmitIntent } from "./types.js";

export class IntentClient {
	constructor(readonly socketPath: string) {}

	private request<T>(request: IntentRequest): Promise<T> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(this.socketPath);
			let buffer = "";

			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("data", (chunk) => {
				buffer += chunk;
			});
			socket.on("error", reject);
			socket.on("end", () => {
				try {
					const response = JSON.parse(buffer) as IntentResponse;
					if (!response.ok) reject(new Error(response.error));
					else resolve(response.data as T);
				} catch (error) {
					reject(error);
				}
			});
		});
	}

	ping(): Promise<{ pid: number }> {
		return this.request({ action: "ping" });
	}

	newCapsuleId(): Promise<{ id: string }> {
		return this.request({ action: "capsule-new-id" });
	}

	registerCapsule(capsule: RegisterCapsule): Promise<CapsuleRecord> {
		return this.request({ action: "capsule-register", capsule });
	}

	updateCapsule(capsule: UpdateCapsule): Promise<CapsuleRecord> {
		return this.request({ action: "capsule-update", capsule });
	}

	heartbeatCapsule(id: string): Promise<CapsuleRecord> {
		return this.request({ action: "capsule-heartbeat", id });
	}

	unregisterCapsule(id: string): Promise<CapsuleRecord> {
		return this.request({ action: "capsule-unregister", id });
	}

	listCapsules(includeOffline = false): Promise<CapsuleRecord[]> {
		return this.request({ action: "capsule-list", includeOffline });
	}

	createAction(input: CreateAction): Promise<ActionRecord> {
		return this.request({ action: "action-create", input });
	}

	dispatchAction(id: string): Promise<ActionRecord> {
		return this.request({ action: "action-dispatch", id });
	}

	approveAction(input: ApproveAction): Promise<ActionRecord> {
		return this.request({ action: "action-approve", input });
	}

	cancelAction(id: string, witness?: string): Promise<ActionRecord> {
		return this.request({ action: "action-cancel", id, witness });
	}

	listActions(): Promise<ActionRecord[]> {
		return this.request({ action: "action-list" });
	}

	getAction(id: string): Promise<ActionRecord> {
		return this.request({ action: "action-get", id });
	}

	admitAction(input: AdmitAction): Promise<{ action: ActionRecord; execute: boolean; witness?: string }> {
		return this.request({ action: "action-admit", input });
	}

	reportAction(input: ReportAction): Promise<ActionRecord> {
		return this.request({ action: "action-report", input });
	}

	recordContext(event: RecordContextEvent): Promise<ContextEvent> {
		return this.request({ action: "record-context", event });
	}

	queryContext(query: ContextQuery): Promise<ContextEvent[]> {
		return this.request({ action: "query-context", query });
	}

	submit(intent: SubmitIntent): Promise<IntentRecord> {
		return this.request({ action: "submit", intent });
	}

	list(): Promise<IntentRecord[]> {
		return this.request({ action: "list" });
	}

	get(id: string): Promise<IntentRecord> {
		return this.request({ action: "get", id });
	}

	logs(id: string, tail = 80): Promise<{ id: string; text: string }> {
		return this.request({ action: "logs", id, tail });
	}

	cancel(id: string): Promise<IntentRecord> {
		return this.request({ action: "cancel", id });
	}

	retry(id: string): Promise<IntentRecord> {
		return this.request({ action: "retry", id });
	}
}
