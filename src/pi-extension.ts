import { Type } from "typebox";
import { IntentClient } from "./client.js";
import { defaultSocketPath } from "./paths.js";
import type { PiExtensionAPI, PiExtensionContext } from "./pi-types.js";
import type { IntentRecord } from "./types.js";

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
	pi.registerTool({
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
