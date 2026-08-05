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
import { assessRisk } from "./risk.js";
import { TmuxTopology, type BroadcastPlan, type TmuxPane } from "./tmux.js";
import type { IntentRecord } from "./types.js";
import { ISH_SYSTEM_PROMPT, renderAgentActivityFrame, renderAgentEnd, renderAgentStart, renderFailure } from "./ui.js";
import { formatNativeContext, readNativeTranscriptsWhenReady } from "./transcript.js";
import { cwdToken, type ActionRecord, type ActionTargetState, type EffectClass } from "./capsules.js";
import { defaultConfigPath, readConfig, updateConfig, type IshConfigKey } from "./config.js";
import {
	credentialStatus,
	defaultCredentialPath,
	piEnvironment,
	updateCredential,
} from "./credentials.js";

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

function versionAtLeast(version: string, minimum: string): boolean {
	const have = version.split(".").map(Number);
	const need = minimum.split(".").map(Number);
	for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
		if ((have[index] ?? 0) > (need[index] ?? 0)) return true;
		if ((have[index] ?? 0) < (need[index] ?? 0)) return false;
	}
	return true;
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
	const config = await readConfig();
	const sessionDir = process.env.ISH_PI_SESSION_DIR ?? path.join(defaultStateDir(), "pi-sessions");
	const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "pi-extension.js");
	const nativeEvents = await readNativeTranscriptsWhenReady();
	const expectedNativeId = process.env.ISH_TRANSCRIPT_EXPECT_ID;
	const captureStatus = expectedNativeId && !nativeEvents.some((event) => event.id === expectedNativeId)
		? "incomplete-recorder-timeout"
		: process.env.ISH_TRANSCRIPT_STATUS;
	const nativeContext = formatNativeContext(nativeEvents, undefined, captureStatus);
	const effectivePrompt = nativeContext ? `${prompt}\n\n${nativeContext}` : prompt;
	const started = Date.now();
	process.stdout.write(renderAgentStart(prompt));
	const animated = Boolean(process.stdout.isTTY && process.env.ISH_TUI === "1" && process.env.TERM !== "dumb");
	let activityFrame = 0;
	let activityTimer: NodeJS.Timeout | undefined;
	let activityVisible = false;
	const drawActivity = () => {
		activityVisible = true;
		process.stdout.write(`${animated ? "\r\u001b[2K" : ""}${renderAgentActivityFrame(activityFrame++)}${animated ? "" : "\n"}`);
	};
	const stopActivity = () => {
		if (activityTimer) clearInterval(activityTimer);
		activityTimer = undefined;
		if (animated && activityVisible) process.stdout.write("\r\u001b[2K");
		activityVisible = false;
	};
	drawActivity();
	if (animated) {
		activityTimer = setInterval(drawActivity, 120);
		activityTimer.unref();
	}
	const piArgs = [
		"--session-dir",
		sessionDir,
		"--continue",
	];
	if (config.provider) piArgs.push("--provider", config.provider);
	if (config.model) piArgs.push("--model", config.model);
	piArgs.push(
		"--extension",
		extension,
		"--append-system-prompt",
		ISH_SYSTEM_PROMPT,
		"--tools",
		process.env.ISH_PI_TOOLS ?? "read,grep,find,ls,system_inspect",
		"-p",
		effectivePrompt,
	);
	const child = spawn(binary, piArgs, {
		cwd: process.cwd(),
		env: await piEnvironment(config),
		stdio: ["inherit", "pipe", "pipe"],
	});
	let outputStarted = false;
	const forward = (chunk: Buffer | string, destination: NodeJS.WriteStream) => {
		if (!outputStarted) {
			outputStarted = true;
			stopActivity();
		}
		destination.write(chunk);
	};
	child.stdout.on("data", (chunk) => forward(chunk, process.stdout));
	child.stderr.on("data", (chunk) => forward(chunk, process.stderr));
	const interrupt = (signal: NodeJS.Signals) => {
		stopActivity();
		child.kill(signal);
	};
	const interruptOnSigint = () => interrupt("SIGINT");
	const interruptOnSigterm = () => interrupt("SIGTERM");
	process.once("SIGINT", interruptOnSigint);
	process.once("SIGTERM", interruptOnSigterm);
	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", () => {
			stopActivity();
			reject(new Error(`Pi could not start from ${binary}. Run \`ish doctor\` or correct ISH_PI.`));
		});
		child.once("close", (code) => resolve(code ?? 1));
	}).finally(() => {
		stopActivity();
		process.off("SIGINT", interruptOnSigint);
		process.off("SIGTERM", interruptOnSigterm);
	});
	if (exitCode !== 0) throw new Error(`${binary} exited with code ${exitCode}`);
	process.stdout.write(renderAgentEnd(Date.now() - started));
}

async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		const value = Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
		if (!value) throw new Error("API key input was empty");
		return value;
	}
	process.stderr.write(prompt);
	const wasRaw = process.stdin.isRaw;
	process.stdin.setRawMode(true);
	process.stdin.resume();
	return new Promise<string>((resolve, reject) => {
		let value = "";
		const finish = (error?: Error) => {
			process.stdin.off("data", onData);
			process.stdin.setRawMode(wasRaw ?? false);
			process.stdin.pause();
			process.stderr.write("\n");
			if (error) reject(error);
			else if (!value) reject(new Error("API key input was empty"));
			else resolve(value);
		};
		const onData = (chunk: Buffer | string) => {
			for (const character of chunk.toString()) {
				if (character === "\r" || character === "\n") return finish();
				if (character === "\u0003" || character === "\u0004") return finish(new Error("credential input cancelled"));
				if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
				else if (character >= " ") value += character;
			}
		};
		process.stdin.on("data", onData);
	});
}

async function configuredProvider(explicit?: string): Promise<string> {
	if (explicit) return explicit;
	const config = await readConfig();
	if (!config.provider) throw new Error("configure a provider first: ish config set provider <provider>");
	return config.provider;
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
		case "config": {
			const subcommand = args[0] ?? "show";
			if (subcommand === "show") {
				const config = await readConfig();
				const credential = config.provider
					? await credentialStatus(config.provider)
					: { source: "not-checked", detail: "configure a provider to check credentials" };
				console.log(JSON.stringify({ path: defaultConfigPath(), credentialPath: defaultCredentialPath(), ...config, credential }, null, 2));
				return;
			}
			if (subcommand === "key-status") {
				console.log(JSON.stringify(await credentialStatus(await configuredProvider(args[1])), null, 2));
				return;
			}
			const key = args[1];
			if (key === "key") {
				if (args.length > 3) throw new Error("API keys must be entered at the hidden prompt, not as command arguments");
				const provider = await configuredProvider(args[2]);
				if (subcommand === "set") {
					await updateCredential(provider, await readSecret(`API key for ${provider}: `));
					console.log(`stored API key for ${provider}; restart is not required`);
					return;
				}
				if (subcommand === "unset") {
					await updateCredential(provider, undefined);
					console.log(`removed stored API key for ${provider}`);
					return;
				}
			}
			if (!key || !["provider", "model"].includes(key)) {
				throw new Error("usage: ish config show | set provider|model <value> | set key [provider] | unset provider|model|key [provider] | key-status [provider]");
			}
			if (subcommand === "set") {
				if (!args[2]) throw new Error(`missing value for ${key}`);
				console.log(JSON.stringify(await updateConfig(key as IshConfigKey, args[2]), null, 2));
				return;
			}
			if (subcommand === "unset") {
				console.log(JSON.stringify(await updateConfig(key as IshConfigKey, undefined), null, 2));
				return;
			}
			throw new Error("usage: ish config show | set provider|model <value> | set key [provider] | unset provider|model|key [provider] | key-status [provider]");
		}
		case "doctor": {
			let failures = 0;
			const check = (state: "ok" | "warn" | "fail", label: string, detail: string) => {
				console.log(`[${state}] ${label}: ${detail}`);
				if (state === "fail") failures += 1;
			};
			const [major, minor] = process.versions.node.split(".").map(Number);
			check(major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail", "node", process.version);
			const zsh = spawnSync(process.env.ISH_ZSH ?? "zsh", ["--version"], { encoding: "utf8" });
			const zshVersion = /zsh\s+([0-9.]+)/.exec(zsh.stdout)?.[1];
			check(zsh.status === 0 && zshVersion && versionAtLeast(zshVersion, "5.8") ? "ok" : "fail", "zsh", zsh.status === 0 ? zsh.stdout.trim() : "not found");
			if (process.platform === "darwin") {
				const expectCommand = process.env.ISH_EXPECT ?? "expect";
				const expect = spawnSync(expectCommand, ["-v"], { encoding: "utf8" });
				check(
					expect.status === 0 ? "ok" : "warn",
					"terminal capture",
					expect.status === 0
						? `${expectCommand} (${(expect.stdout || expect.stderr).trim()})`
						: "Expect is unavailable; ish will preserve direct zsh terminal behavior but native output will not reach later agent requests",
				);
			}
			try {
				const pi = resolvePiBinary();
				const version = spawnSync(pi, ["--version"], { encoding: "utf8", env: process.env });
				const state = version.status !== 0 ? "fail" : /0\.83\.0/.test(version.stdout) ? "ok" : "warn";
				check(state, "pi", version.status === 0 ? `${pi} (${version.stdout.trim()}; tested 0.83.0)` : `${pi} did not start`);
			} catch (error) {
				check("fail", "pi", error instanceof Error ? error.message : String(error));
			}
			const config = await readConfig();
			check(config.provider ? "ok" : "warn", "provider", config.provider ?? "not configured; Pi default applies");
			check(config.model ? "ok" : "warn", "model", config.model ?? "not configured; Pi default applies");
			if (config.provider) {
				try {
					const credential = await credentialStatus(config.provider);
					check(["missing", "pi-managed"].includes(credential.source) ? "warn" : "ok", "credential", `${credential.variable}: ${credential.source}`);
				} catch (error) {
					check("warn", "credential", error instanceof Error ? error.message : String(error));
				}
			} else check("warn", "credential", "configure a provider to check credentials");
			try {
				await client.ping();
				check("ok", "intentd", process.env.INTENTD_SOCKET ?? defaultSocketPath());
			} catch {
				check("warn", "intentd", "not reachable; native commands and direct agent requests still work");
			}
			if (failures) process.exitCode = 1;
			return;
		}
		case "risk": {
			const assessment = assessRisk(args.join(" "));
			console.log([assessment.level, assessment.rule, assessment.reason].join("\t"));
			return;
		}
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
			{
				const capsules = await client.listCapsules(args.includes("--all"));
				if ((process.stdout.isTTY || process.env.ISH_TUI === "1") && !process.env.NO_COLOR) {
					console.log("\u001b[38;5;39m◆ ish capsules\u001b[0m");
					for (const capsule of capsules) {
						const target = capsule.session ? `${capsule.session}${capsule.pane ? `/${capsule.pane}` : ""}` : "local";
						console.log(`  \u001b[38;5;42m●\u001b[0m ${target.padEnd(14)} ${capsule.mode.padEnd(8)} gen ${String(capsule.generation).padEnd(3)} ${path.basename(capsule.cwd) || "/"}`);
					}
					if (!capsules.length) console.log("  \u001b[2mno live shells\u001b[0m");
				} else {
					for (const capsule of capsules) {
						console.log([capsule.id, capsule.mode, capsule.host, capsule.session ?? "-", capsule.pane ?? "-", capsule.generation, capsule.cwd].join("\t"));
					}
				}
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
			console.log("ishctl commands: config, doctor, risk, route, ask, panes, broadcast, context, capsules, action, action-dispatch, actions, action-show, ping, submit, list, show, logs, cancel, retry");
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
