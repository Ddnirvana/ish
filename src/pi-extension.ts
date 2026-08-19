import { Type } from "typebox";
import { registerSystemInspect } from "../extensions/system-inspect/index.js";
import { registerSystemObserve } from "../extensions/system-observe/index.js";
import { IntentClient } from "./client.js";
import { defaultSocketPath } from "./paths.js";
import type { PiExtensionAPI, PiExtensionContext, PiToolInfo } from "./pi-types.js";
import { assessRisk } from "./risk.js";
import type { IntentRecord } from "./types.js";

const DEFAULT_ACTIVE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"intent_job",
	"system_inspect",
	"shell_observe",
	"process_observe",
	"log_query",
	"service_observe",
	"network_observe",
	"git_inspect",
	"shell_propose",
	"shell_apply",
	"list_capabilities",
	"activate_capabilities",
];
const MANUAL_ONLY_TOOLS = new Set(["bash", "edit", "write"]);

const CapabilityListParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Optional name, description, or source filter" })),
});

const CapabilityActivateParams = Type.Object({
	names: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 12,
		description: "Installed tool names returned by list_capabilities",
	}),
});

interface CapabilityListParams extends Record<string, unknown> {
	query?: string;
}

interface CapabilityActivateParams extends Record<string, unknown> {
	names: string[];
}

const ShellProposeParams = Type.Object({
	command: Type.String({ minLength: 1, description: "Exact zsh command to propose without executing it" }),
	reason: Type.String({ minLength: 1, description: "Why this effect is needed" }),
	resources: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 16,
		description: "Files, services, processes, ports, or other resources the command may affect",
	}),
	selector: Type.Optional(Type.String({ description: "ish capsule selector; defaults to the shell asking Pi" })),
});

const ShellApplyParams = Type.Object({
	id: Type.String({ pattern: "^op_[a-f0-9]{20}$", description: "Proposal ID returned by shell_propose" }),
});

interface ShellProposeParams extends Record<string, unknown> {
	command: string;
	reason: string;
	resources: string[];
	selector?: string;
}

interface ShellApplyParams extends Record<string, unknown> {
	id: string;
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function configuredActiveTools(): string[] {
	return unique((process.env.ISH_PI_TOOLS ?? DEFAULT_ACTIVE_TOOLS.join(",")).split(","));
}

function source(tool: PiToolInfo): string {
	return tool.sourceInfo?.source ?? "unknown";
}

function matchingTools(pi: PiExtensionAPI, query?: string): PiToolInfo[] {
	const needle = query?.trim().toLowerCase();
	return pi.getAllTools()
		.filter((tool) => !needle || `${tool.name} ${tool.description} ${source(tool)}`.toLowerCase().includes(needle))
		.sort((left, right) => left.name.localeCompare(right.name));
}

const IntentParams = Type.Object({
	action: Type.Union([
		Type.Literal("submit"),
		Type.Literal("list"),
		Type.Literal("show"),
		Type.Literal("logs"),
		Type.Literal("cancel"),
		Type.Literal("retry"),
	]),
	objective: Type.Optional(Type.String({ description: "Durable objective for submit" })),
	id: Type.Optional(Type.String({ description: "Intent ID for show, logs, cancel, or retry" })),
	acceptance: Type.Optional(Type.Array(Type.String({ description: "Observable completion criterion" }))),
});

interface IntentToolParams extends Record<string, unknown> {
	action: "submit" | "list" | "show" | "logs" | "cancel" | "retry";
	objective?: string;
	id?: string;
	acceptance?: string[];
}

function client(): IntentClient {
	return new IntentClient(process.env.INTENTD_SOCKET ?? defaultSocketPath());
}

function requester(): string {
	return `pi:${process.pid}`;
}

function line(record: IntentRecord): string {
	return `${record.id}  ${record.status.padEnd(11)}  ${record.objective}`;
}

async function runAction(
	action: "submit" | "list" | "show" | "logs" | "cancel" | "retry",
	ctx: PiExtensionContext,
	objective?: string,
	id?: string,
	acceptance?: string[],
): Promise<string> {
	const api = client();
	switch (action) {
		case "submit": {
			if (!objective?.trim()) throw new Error("submit requires an objective");
			const record = await api.submit({ objective, acceptance, cwd: ctx.cwd, requester: requester() });
			return `submitted ${line(record)}`;
		}
		case "list": {
			const records = await api.list();
			return records.length ? records.map(line).join("\n") : "no durable intents";
		}
		case "show":
			if (!id) throw new Error("show requires an intent ID");
			return JSON.stringify(await api.get(id), null, 2);
		case "logs":
			if (!id) throw new Error("logs requires an intent ID");
			return (await api.logs(id)).text || "no log output yet";
		case "cancel":
			if (!id) throw new Error("cancel requires an intent ID");
			return line(await api.cancel(id));
		case "retry":
			if (!id) throw new Error("retry requires an intent ID");
			return line(await api.retry(id));
	}
}

export default function (pi: PiExtensionAPI) {
	pi.registerTool<IntentToolParams>({
		name: "intent_job",
		label: "Intent Job",
		description:
			"Submit and control durable Pi jobs owned by intentd. Use this when work must outlive the current Pi session or be visible from another terminal.",
		parameters: IntentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = await runAction(params.action, ctx, params.objective, params.id, params.acceptance);
			return { content: [{ type: "text", text }], details: { action: params.action } };
		},
	});

	registerSystemInspect(pi);
	registerSystemObserve(pi);

	pi.registerTool<ShellProposeParams>({
		name: "shell_propose",
		label: "Propose Shell Effect",
		description:
			"Persist an exact command as a non-executing ish proposal. Declare why it is needed and every known affected resource. The user must review it in ish before anything runs.",
		parameters: ShellProposeParams,
		async execute(_toolCallId, params) {
			const selector = params.selector?.trim() || (process.env.ISH_CAPSULE_ID ? `capsule:${process.env.ISH_CAPSULE_ID}` : "");
			if (!selector) throw new Error("no current ish capsule; specify an explicit capsule selector");
			const risk = assessRisk(params.command);
			const action = await client().createAction({
				selector,
				command: params.command,
				effectClass: risk.level === "critical" ? "unsafe" : "effectful",
				reason: params.reason,
				resources: params.resources,
				provenance: requester(),
				requireApproval: true,
			});
			const result = {
				id: action.id,
				status: action.status,
				approval: action.approval,
				command: action.command,
				risk: action.risk,
				next: `Run /apply ${action.id} in ish to review and approve once.`,
			};
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool<ShellApplyParams>({
		name: "shell_apply",
		label: "Request Shell Approval",
		description:
			"Hand a persisted shell proposal back to the user for interactive ish approval. This tool never executes or approves the command.",
		parameters: ShellApplyParams,
		async execute(_toolCallId, params) {
			const action = await client().getAction(params.id);
			const next = action.approval === "pending"
				? `Run /apply ${action.id} in ish to inspect the exact command, targets, cwd witnesses, resources, and risk before approving once.`
				: `Proposal ${action.id} is ${action.approval} with status ${action.status}; it was not executed by shell_apply.`;
			const result = { id: action.id, approval: action.approval, status: action.status, next };
			return { content: [{ type: "text", text: next }], details: result };
		},
	});

	pi.registerTool<CapabilityListParams>({
		name: "list_capabilities",
		label: "List Capabilities",
		description:
			"List tools registered by Pi and installed extensions, including whether each is active. Use this when the current tools cannot complete a request.",
		parameters: CapabilityListParams,
		async execute(_toolCallId, params) {
			const active = new Set(pi.getActiveTools());
			const tools = matchingTools(pi, params.query).map((tool) => ({
				name: tool.name,
				description: tool.description,
				source: source(tool),
				active: active.has(tool.name),
				manualOnly: MANUAL_ONLY_TOOLS.has(tool.name),
			}));
			return { content: [{ type: "text", text: JSON.stringify({ tools }, null, 2) }], details: { tools } };
		},
	});

	pi.registerTool<CapabilityActivateParams>({
		name: "activate_capabilities",
		label: "Activate Capabilities",
		description:
			"Activate installed extension tools for the current Pi session. Call list_capabilities first. Built-in shell mutation tools require explicit ish configuration and cannot be activated here.",
		parameters: CapabilityActivateParams,
		async execute(_toolCallId, params) {
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const requested = unique(params.names);
			const refused = requested.filter((name) => MANUAL_ONLY_TOOLS.has(name));
			const unknown = requested.filter((name) => !available.has(name));
			const activated = requested.filter((name) => available.has(name) && !MANUAL_ONLY_TOOLS.has(name));
			const active = unique([...pi.getActiveTools(), ...activated]);
			pi.setActiveTools(active);
			const result = { activated, refused, unknown, active };
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.on("session_start", () => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(configuredActiveTools().filter((name) => available.has(name)));
	});

	pi.registerCommand("intent", {
		description: "Control durable cross-session Pi jobs",
		handler: async (args, ctx) => {
			const [rawAction = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const action = rawAction as "submit" | "list" | "show" | "logs" | "cancel" | "retry";
			if (!["submit", "list", "show", "logs", "cancel", "retry"].includes(action)) {
				ctx.ui.notify("usage: /intent submit <objective> | list | show/logs/cancel/retry <id>", "error");
				return;
			}
			try {
				const output = await runAction(
					action,
					ctx,
					action === "submit" ? rest.join(" ") : undefined,
					action === "submit" || action === "list" ? undefined : rest[0],
				);
				ctx.ui.notify(output, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
