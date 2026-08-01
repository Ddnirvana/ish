#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntentClient } from "./client.js";
import type { ContextEventKind, ContextScope } from "./context.js";
import { routeInput } from "./gateway.js";
import { defaultSocketPath, defaultStateDir } from "./paths.js";
import { TmuxTopology, type BroadcastPlan, type TmuxPane } from "./tmux.js";
import type { IntentRecord } from "./types.js";
import { ISH_SYSTEM_PROMPT, renderAgentEnd, renderAgentStart, renderFailure } from "./ui.js";
import { cwdToken, type ActionRecord, type ActionTargetState, type EffectClass } from "./capsules.js";

function summarize(record: IntentRecord): string {
	return [record.id, record.status.padEnd(11), record.requester, record.objective].join("\t");
}

function withoutSeparator(args: string[]): string[] {
	return args[0] === "--" ? args.slice(1) : args;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function requiredOption(args: string[], name: string): string {
	const value = option(args, name);
	if (value === undefined) throw new Error(`missing ${name}`);
	return value;
}

function optionalScope(value: string | undefined): string | undefined {
	return value && value !== "-" ? value : undefined;
}

function printAction(action: ActionRecord): void {
	console.log(JSON.stringify(action, null, 2));
}

function commandExists(command: string): boolean {
	if (!command || !/^[A-Za-z0-9_.:+-]+$/.test(command)) return false;
	const shell = process.env.SHELL ?? "/bin/sh";
	const result = spawnSync(shell, ["-lc", 'command -v -- "$1" >/dev/null 2>&1', "ish-route", command], {
		stdio: "ignore",
	});
	return result.status === 0;
}

function formatPane(pane: TmuxPane): string {
	return [pane.id, pane.session, `${pane.windowIndex}:${pane.windowName}`, pane.command, pane.path].join("\t");
}

function printPlan(plan: BroadcastPlan): void {
	console.log(`command: ${plan.command}`);
	for (const pane of plan.targets) console.log(`target\t${formatPane(pane)}`);
	for (const { pane, reason } of plan.excluded) console.log(`excluded\t${formatPane(pane)}\t${reason}`);
}

function resolvePiBinary(): string {
	const configured = process.env.ISH_PI?.trim();
	if (configured) return configured;
	const executable = process.platform === "win32" ? "pi.cmd" : "pi";
	const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".bin", executable);
	if (existsSync(bundled)) return bundled;
	if (commandExists("pi")) return "pi";
	throw new Error("Pi is unavailable. Run `ish doctor` or set ISH_PI to a Pi executable.");
}

async function runPi(prompt: string): Promise<void> {
	if (!prompt.trim()) throw new Error("agent request is required");
	const binary = resolvePiBinary();
	const sessionDir = process.env.ISH_PI_SESSION_DIR ?? path.join(defaultStateDir(), "pi-sessions");
	const started = Date.now();
	process.stdout.write(renderAgentStart(prompt));
	const child = spawn(binary, [
		"--session-dir",
		sessionDir,
		"--continue",
		"--append-system-prompt",
		ISH_SYSTEM_PROMPT,
		"-p",
		prompt,
	], {
		cwd: process.cwd(),
		env: process.env,
		stdio: "inherit",
	});
	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", () => {
			reject(new Error(`Pi could not start from ${binary}. Run \`ish doctor\` or correct ISH_PI.`));
		});
		child.once("close", (code) => resolve(code ?? 1));
	});
	if (exitCode !== 0) throw new Error(`${binary} exited with code ${exitCode}`);
	process.stdout.write(renderAgentEnd(Date.now() - started));
}

async function currentScope(): Promise<ContextScope> {
	const scope: ContextScope = {
		host: os.hostname(),
		cwd: process.cwd(),
		pane: process.env.TMUX_PANE,
		tmuxServer: process.env.TMUX?.split(",", 1)[0],
	};
	if (scope.pane) {
		try {
			const pane = (await new TmuxTopology().discover()).find((candidate) => candidate.id === scope.pane);
			if (pane) {
				scope.session = pane.session;
				scope.window = pane.windowId;
			}
		} catch {
			// The shell still has a useful host/pane/cwd scope if tmux disappears.
		}
	}
	return scope;
}

async function runShellControl(raw: string): Promise<void> {
	const line = raw.trim();
	if (line === "/panes") return run("panes", []);
	if (line === "/intent") return run("list", []);
	if (line === "/context") return run("context", ["show"]);
	if (line === "/capsules") return run("capsules", []);
	if (line === "/actions") return run("actions", []);
	if (line.startsWith("/ask ")) return run("ask", [line.slice("/ask ".length)]);
	if (line.startsWith("/intent ")) {
		const rest = line.slice("/intent ".length).trim();
		const [command, ...args] = rest.split(/\s+/);
		return run(command, args);
	}
	if (line.startsWith("/context ")) {
		const rest = line.slice("/context ".length).trim();
		const [command, ...args] = rest.split(/\s+/);
		return run("context", [command, ...args]);
	}
	if (line.startsWith("/broadcast ")) {
		const rest = line.slice("/broadcast ".length);
		const marker = rest.indexOf(" -- ");
		if (marker === -1) throw new Error("usage: /broadcast <selector> [--execute] -- <command>");
		const header = rest.slice(0, marker).trim().split(/\s+/);
		return run("broadcast", [...header, "--", rest.slice(marker + 4)]);
	}
	for (const [prefix, effectClass] of [["/observe ", "observation"], ["/apply ", "effectful"]] as const) {
		if (!line.startsWith(prefix)) continue;
		const rest = line.slice(prefix.length);
		const marker = rest.indexOf(" -- ");
		if (marker === -1) throw new Error(`usage: ${prefix.trim()} <selector> [--execute] -- <command>`);
		const header = rest.slice(0, marker).trim().split(/\s+/);
		return run("action", [header[0], "--class", effectClass, ...header.slice(1), "--", rest.slice(marker + 4)]);
	}
	throw new Error(`unknown ish control command: ${line}`);
}

async function run(command = "help", rawArgs: string[]): Promise<void> {
	const args = withoutSeparator(rawArgs);
	const client = new IntentClient(process.env.INTENTD_SOCKET ?? defaultSocketPath());
	switch (command) {
		case "route": {
			const decision = routeInput(args.join(" "), { commandExists });
			console.log(decision.route);
			return;
		}
		case "ask":
			try {
				await client.recordContext({
					kind: "agent-request",
					scope: await currentScope(),
					content: args.join(" "),
					provenance: "ishctl",
				});
			} catch {
				// Context persistence must never block the explicit agent slow path.
			}
			return runPi(args.join(" "));
		case "shell-control":
			return runShellControl(args.join(" "));
		case "panes": {
			for (const pane of await new TmuxTopology().discover()) console.log(formatPane(pane));
			return;
		}
		case "context": {
			const subcommand = args[0] ?? "show";
			if (subcommand === "show") {
				for (const event of await client.queryContext({ scope: await currentScope() })) {
					console.log([event.timestamp, event.kind, event.scope.pane ?? "-", event.content].join("\t"));
				}
				return;
			}
			if (subcommand === "record") {
				const kind = args[1] as ContextEventKind | undefined;
				const allowed: ContextEventKind[] = [
					"agent-request",
					"agent-response",
					"intent-event",
					"native-command",
					"topology-note",
				];
				if (!kind || !allowed.includes(kind)) throw new Error(`invalid context event kind: ${kind ?? ""}`);
				console.log(
					JSON.stringify(
						await client.recordContext({
							kind,
							scope: await currentScope(),
							content: args.slice(2).join(" "),
							provenance: "ishctl",
						}),
						null,
						2,
					),
				);
				return;
			}
			throw new Error("usage: ishctl context show | context record <kind> <content>");
		}
		case "broadcast": {
			const execute = args.includes("--execute");
			const separator = args.indexOf("--");
			if (!args[0] || separator === -1) {
				throw new Error("usage: ishctl broadcast <selector> [--execute] -- <command>");
			}
			const topology = new TmuxTopology();
			const plan = topology.planBroadcast(
				await topology.discover(),
				args[0],
				args.slice(separator + 1).join(" "),
			);
			printPlan(plan);
			if (execute) await topology.executeBroadcast(plan);
			else console.log("preview only; add --execute to send the command");
			return;
		}
		case "ping":
			console.log(JSON.stringify(await client.ping(), null, 2));
			return;
		case "digest":
			console.log(cwdToken(args.join(" ")));
			return;
		case "decode":
			if (!args[0]) throw new Error("usage: ishctl decode <base64url>");
			process.stdout.write(Buffer.from(args[0], "base64url").toString("utf8"));
			return;
		case "capsule-id":
			console.log((await client.newCapsuleId()).id);
			return;
		case "capsule-register": {
			const record = await client.registerCapsule({
				id: requiredOption(args, "--id"),
				endpoint: requiredOption(args, "--endpoint"),
				pid: Number(requiredOption(args, "--pid")),
				processStart: requiredOption(args, "--process-start"),
				generation: Number(requiredOption(args, "--generation")),
				cwd: requiredOption(args, "--cwd"),
				host: requiredOption(args, "--host"),
				bootId: requiredOption(args, "--boot-id"),
				shell: requiredOption(args, "--shell"),
				authority: requiredOption(args, "--authority"),
				tmuxServer: optionalScope(option(args, "--tmux-server")),
				session: optionalScope(option(args, "--session")),
				window: optionalScope(option(args, "--window")),
				pane: optionalScope(option(args, "--pane")),
				mode: "prompt",
				lineEditor: "ready",
			});
			console.log(JSON.stringify(record));
			return;
		}
		case "capsule-update": {
			const record = await client.updateCapsule({
				id: requiredOption(args, "--id"),
				generation: option(args, "--generation") === undefined ? undefined : Number(option(args, "--generation")),
				cwd: option(args, "--cwd"),
				mode: option(args, "--mode") as "prompt" | "running" | "offline" | undefined,
				lineEditor: option(args, "--line-editor") as "ready" | "busy" | "inactive" | undefined,
			});
			console.log(JSON.stringify(record));
			return;
		}
		case "capsule-heartbeat":
			if (!args[0]) throw new Error("usage: ishctl capsule-heartbeat <capsule-id>");
			await client.heartbeatCapsule(args[0]);
			return;
		case "capsule-unregister":
			if (!args[0]) throw new Error("usage: ishctl capsule-unregister <capsule-id>");
			await client.unregisterCapsule(args[0]);
			return;
		case "capsules":
			for (const capsule of await client.listCapsules(args.includes("--all"))) {
				console.log([capsule.id, capsule.mode, capsule.host, capsule.session ?? "-", capsule.pane ?? "-", capsule.generation, capsule.cwd].join("\t"));
			}
			return;
		case "action": {
			const separator = args.indexOf("--");
			if (!args[0] || separator === -1) throw new Error("usage: ishctl action <selector> [--class observation|effectful|unsafe] [--ttl MS] [--execute] -- <command>");
			const effectClass = (option(args.slice(0, separator), "--class") ?? "observation") as EffectClass;
			const ttl = option(args.slice(0, separator), "--ttl");
			let action = await client.createAction({
				selector: args[0],
				command: args.slice(separator + 1).join(" "),
				effectClass,
				ttlMs: ttl === undefined ? undefined : Number(ttl),
			});
			if (args.slice(0, separator).includes("--execute")) action = await client.dispatchAction(action.id);
			printAction(action);
			return;
		}
		case "action-dispatch":
			if (!args[0]) throw new Error("usage: ishctl action-dispatch <action-id>");
			printAction(await client.dispatchAction(args[0]));
			return;
		case "actions":
			for (const action of await client.listActions()) {
				console.log([action.id, action.status, action.effectClass, action.selector, action.command].join("\t"));
			}
			return;
		case "action-show":
			if (!args[0]) throw new Error("usage: ishctl action-show <action-id>");
			printAction(await client.getAction(args[0]));
			return;
		case "action-admit": {
			const result = await client.admitAction({
				actionId: requiredOption(args, "--action"),
				capsuleId: requiredOption(args, "--capsule"),
				generation: Number(requiredOption(args, "--generation")),
				cwdToken: requiredOption(args, "--cwd-token"),
				lineEditorReady: requiredOption(args, "--line-editor-ready") === "1",
			});
			console.log(result.execute ? "execute" : `reject:${result.witness ?? "not admitted"}`);
			return;
		}
		case "action-report": {
			const state = requiredOption(args, "--state") as ActionTargetState;
			const allowed: ActionTargetState[] = ["running", "succeeded", "failed", "stale", "busy", "denied", "uncertain"];
			if (!allowed.includes(state)) throw new Error(`invalid report state: ${state}`);
			printAction(
				await client.reportAction({
					actionId: requiredOption(args, "--action"),
					capsuleId: requiredOption(args, "--capsule"),
					state: state as "running" | "succeeded" | "failed" | "stale" | "busy" | "denied" | "uncertain",
					exitCode: option(args, "--exit-code") === undefined ? undefined : Number(option(args, "--exit-code")),
					witness: option(args, "--witness"),
					output: option(args, "--output"),
				}),
			);
			return;
		}
		case "submit": {
			const objective = args.join(" ").trim();
			if (!objective) throw new Error("usage: ishctl submit <objective>");
			console.log(
				JSON.stringify(
					await client.submit({ objective, cwd: process.cwd(), requester: `ishctl:${process.pid}` }),
					null,
					2,
				),
			);
			return;
		}
		case "list":
			for (const record of await client.list()) console.log(summarize(record));
			return;
		case "show":
			if (!args[0]) throw new Error("usage: ishctl show <intent-id>");
			console.log(JSON.stringify(await client.get(args[0]), null, 2));
			return;
		case "logs":
			if (!args[0]) throw new Error("usage: ishctl logs <intent-id> [lines]");
			console.log((await client.logs(args[0], args[1] ? Number(args[1]) : 80)).text);
			return;
		case "cancel":
			if (!args[0]) throw new Error("usage: ishctl cancel <intent-id>");
			console.log(JSON.stringify(await client.cancel(args[0]), null, 2));
			return;
		case "retry":
			if (!args[0]) throw new Error("usage: ishctl retry <intent-id>");
			console.log(JSON.stringify(await client.retry(args[0]), null, 2));
			return;
		default:
			console.log("ishctl commands: route, ask, panes, broadcast, context, capsules, action, action-dispatch, actions, action-show, ping, submit, list, show, logs, cancel, retry");
	}
}

const [command, ...args] = process.argv.slice(2);
try {
	await run(command, args);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(renderFailure(message));
	process.exitCode = 1;
}
