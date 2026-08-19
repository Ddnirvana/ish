import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ActionRecord, CapsuleRecord } from "../src/capsules.js";
import { IntentClient } from "../src/client.js";
import { IntentDaemon } from "../src/daemon.js";
import { SystemTmuxExecutor } from "../src/tmux.js";

const hasTools = ["tmux", "zsh", "mkfifo"].every(
	(tool) => spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "ish-test", tool], { stdio: "ignore" }).status === 0,
);
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const shellPath = path.join(sourceRoot, "shell", "ish.zsh");
const ctlPath = path.join(sourceRoot, "dist", "src", "ctl-cli.js");

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeoutMs = 8000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		const value = await read();
		last = value;
		if (ready(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function targetState(action: ActionRecord, capsule: CapsuleRecord): string | undefined {
	return action.targets.find((target) => target.capsuleId === capsule.id)?.state;
}

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

test("real zsh capsules execute through ZLE and reject stale or typed-buffer targets", { skip: !hasTools }, async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-real-capsule-"));
	const socketPath = path.join(root, "intentd.sock");
	const stateDir = path.join(root, "state");
	const runtimeDir = path.join(root, "runtime");
	const binDir = path.join(root, "bin");
	const zdotdir = path.join(root, "zdot");
	const resultPath = path.join(root, "results.txt");
	const tmuxSocket = `ish-capsule-${process.pid}-${Date.now()}`;
	const executor = new SystemTmuxExecutor(tmuxSocket);
	const fixture = fileURLToPath(new URL("./fixtures/fake-pi.js", import.meta.url));
	const daemon = new IntentDaemon({
		socketPath,
		stateDir,
		runner: { command: process.execPath, args: [fixture] },
	});

	await Promise.all([
		writeFile(path.join(root, "placeholder"), ""),
		import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(binDir), mkdir(zdotdir), mkdir(runtimeDir)])),
	]);
	const wrapper = path.join(binDir, "ishctl");
	await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ctlPath)} "$@"\n`);
	await chmod(wrapper, 0o755);
	await writeFile(
		path.join(zdotdir, ".zshrc"),
		[
			`export PATH=${JSON.stringify(`${binDir}:${process.env.PATH ?? ""}`)}`,
			`export INTENTD_SOCKET=${JSON.stringify(socketPath)}`,
			`export INTENTD_STATE_DIR=${JSON.stringify(stateDir)}`,
			`export ISH_RUNTIME_DIR=${JSON.stringify(runtimeDir)}`,
			`source ${JSON.stringify(shellPath)}`,
			`PROMPT='ISH> '`,
		].join("\n") + "\n",
	);

	await daemon.start();
	t.after(async () => {
		await daemon.stop();
		try {
			await executor.run(["kill-server"]);
		} catch {
			// The isolated server may have exited with its shells.
		}
		await rm(root, { recursive: true, force: true });
	});

	const envArgs = ["env", `ZDOTDIR=${zdotdir}`, `HOME=${root}`, `PATH=${binDir}:${process.env.PATH ?? ""}`, "zsh", "-d"];
	await executor.run(["-f", "/dev/null", "new-session", "-d", "-s", "prod", ...envArgs]);
	await executor.run(["split-window", "-d", "-t", "prod:0", ...envArgs]);

	const client = new IntentClient(socketPath);
	const capsules = await waitFor(
		() => client.listCapsules(),
		(value) => value.length === 2 && value.every((capsule) => capsule.generation >= 1),
		"two registered prompt capsules",
	);
	assert.equal(new Set(capsules.map((capsule) => capsule.id)).size, 2);
	assert.equal(new Set(capsules.map((capsule) => capsule.endpoint)).size, 2);

	const approvalCapsule = capsules[0]!;
	const routedPath = path.join(root, "routed-effect");
	const routedCommand = `touch ${JSON.stringify(routedPath)}`;
	await executor.run(["send-keys", "-t", approvalCapsule.pane!, `/apply capsule:${approvalCapsule.id} -- ${routedCommand}`, "Enter"]);
	const routed = await waitFor(
		async () => (await client.listActions()).find((action) => action.command === routedCommand),
		(value) => value !== undefined && value.approval === "pending",
		"shell-routed effect proposal",
	);
	const routedCapsule = await waitFor(
		async () => (await client.listCapsules()).find((capsule) => capsule.id === approvalCapsule.id),
		(value) => value !== undefined && value.mode === "prompt" && value.lineEditor === "ready",
		"stable post-agent proposal witness",
	);
	assert.ok(routed);
	assert.ok(routedCapsule);
	assert.equal(routed.targets[0]?.expectedGeneration, routedCapsule.generation);
	assert.equal(routed.targets[0]?.expectedCwdToken, routedCapsule.cwdToken);
	await client.cancelAction(routed.id, "test cleanup");
	assert.equal(await exists(routedPath), false);

	const cancelledPath = path.join(root, "cancelled-effect");
	const cancelled = await client.createAction({
		selector: `capsule:${approvalCapsule.id}`,
		command: `touch ${JSON.stringify(cancelledPath)}`,
		effectClass: "effectful",
		reason: "verify user cancellation",
		resources: [cancelledPath],
		provenance: "pi:test",
		requireApproval: true,
	});
	await executor.run(["send-keys", "-t", approvalCapsule.pane!, `/apply ${cancelled.id}`, "Enter"]);
	await waitFor(
		async () => (await executor.run(["capture-pane", "-p", "-t", approvalCapsule.pane!, "-S", "-60"])).stdout,
		(value) => value.includes("ish controlled effect") && value.includes(cancelled.id),
		"interactive proposal preview",
	);
	await executor.run(["send-keys", "-t", approvalCapsule.pane!, "n"]);
	const cancelledResult = await waitFor(
		() => client.getAction(cancelled.id),
		(value) => value.status === "cancelled",
		"durable user cancellation",
	);
	assert.equal(cancelledResult.approvalWitness, "cancelled by user in ish");
	assert.equal(await exists(cancelledPath), false);

	const exactPath = path.join(root, "quoted result.txt");
	const exactCommand = `printf '%s\\n' 'quoted ; $(not-executed)' > ${JSON.stringify(exactPath)}`;
	const approved = await client.createAction({
		selector: `capsule:${approvalCapsule.id}`,
		command: exactCommand,
		effectClass: "effectful",
		reason: "verify exact command binding",
		resources: [exactPath],
		provenance: "pi:test",
		requireApproval: true,
	});
	await executor.run(["send-keys", "-t", approvalCapsule.pane!, `/apply ${approved.id}`, "Enter"]);
	await waitFor(
		async () => (await executor.run(["capture-pane", "-p", "-t", approvalCapsule.pane!, "-S", "-80"])).stdout,
		(value) => value.includes(approved.id) && value.includes("verify exact command binding"),
		"exact command preview",
	);
	await executor.run(["send-keys", "-t", approvalCapsule.pane!, "y"]);
	const approvedResult = await waitFor(
		() => client.getAction(approved.id),
		(value) => value.status === "succeeded",
		"interactive approved execution",
	);
	assert.equal(approvedResult.approval, "approved");
	assert.equal(await readFile(exactPath, "utf8"), "quoted ; $(not-executed)\n");

	const headless = await client.createAction({
		selector: `capsule:${approvalCapsule.id}`,
		command: `touch ${JSON.stringify(path.join(root, "headless-effect"))}`,
		effectClass: "effectful",
		requireApproval: true,
	});
	const headlessResult = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [ctlPath, "action-approve", headless.id], {
			env: { ...process.env, INTENTD_SOCKET: socketPath },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stderr }));
	});
	assert.equal(headlessResult.code, 1);
	assert.match(headlessResult.stderr, /headless approval denied/);
	assert.equal((await client.getAction(headless.id)).approval, "cancelled");

	const command = `print -r -- "$_ISH_CAPSULE_ID:$PWD" >> ${JSON.stringify(resultPath)}`;
	const fanout = await client.createAction({ selector: "session:prod", command, effectClass: "effectful" });
	await client.dispatchAction(fanout.id);
	let completed: ActionRecord;
	try {
		completed = await waitFor(
			() => client.getAction(fanout.id),
			(value) => value.status === "succeeded",
			"successful two-capsule action",
		);
	} catch (error) {
		const panes = await Promise.all(capsules.map((capsule) => executor.run(["capture-pane", "-p", "-t", capsule.pane!, "-S", "-40"])));
		const results = await readFile(resultPath, "utf8").catch(() => "<missing>");
		throw new Error(`${error instanceof Error ? error.message : String(error)}; results=${JSON.stringify(results)}; panes=${JSON.stringify(panes.map((pane) => pane.stdout))}`);
	}
	assert.equal(completed.targets.filter((target) => target.state === "succeeded").length, 2);
	const resultLines = (await readFile(resultPath, "utf8")).trim().split("\n");
	assert.equal(resultLines.length, 2);
	for (const capsule of capsules) assert.ok(resultLines.some((line) => line.startsWith(`${capsule.id}:`)));
	await waitFor(
		() => client.listCapsules(),
		(value) => value.length === 2 && value.every((capsule) => capsule.generation > 1),
		"post-action capsule generations",
	);

	const typedCapsule = capsules[0]!;
	const otherCapsule = capsules[1]!;
	const busyAction = await client.createAction({
		selector: "session:prod",
		command: `print -r -- SHOULD_RUN_ONCE >> ${JSON.stringify(resultPath)}`,
		effectClass: "effectful",
		requireApproval: true,
	});
	await executor.run(["send-keys", "-t", typedCapsule.pane!, "-l", "PRESERVE_TYPED_INPUT"]);
	await new Promise((resolve) => setTimeout(resolve, 80));
	const busyApprover = (await client.listCapsules()).find((capsule) => capsule.id === otherCapsule.id)!;
	await client.approveAction({
		actionId: busyAction.id,
		capsuleId: busyApprover.id,
		generation: busyApprover.generation,
		cwdToken: busyApprover.cwdToken,
	});
	const partialBusy = await waitFor(
		() => client.getAction(busyAction.id),
		(value) => ["partial", "failed"].includes(value.status) && value.targets.every((target) => ["succeeded", "busy"].includes(target.state)),
		"typed-buffer partial outcome",
	);
	assert.equal(targetState(partialBusy, typedCapsule), "busy");
	assert.equal(targetState(partialBusy, otherCapsule), "succeeded");
	const captured = await executor.run(["capture-pane", "-p", "-t", typedCapsule.pane!]);
	assert.match(captured.stdout, /PRESERVE_TYPED_INPUT/);
	await executor.run(["send-keys", "-t", typedCapsule.pane!, "C-c"]);
	await waitFor(
		() => client.listCapsules(),
		(value) =>
			value.length === 2 &&
			value.every((capsule) => {
				const planned = busyAction.targets.find((target) => target.capsuleId === capsule.id);
				return planned !== undefined && capsule.generation > planned.expectedGeneration && capsule.mode === "prompt";
			}),
		"post-busy capsule generations",
	);

	const beforeChange = (await client.listCapsules()).find((capsule) => capsule.id === typedCapsule.id)!;
	const staleAction = await client.createAction({
		selector: "session:prod",
		command: `print -r -- STALE_GUARD >> ${JSON.stringify(resultPath)}`,
		effectClass: "effectful",
		requireApproval: true,
	});
	await executor.run(["send-keys", "-t", typedCapsule.pane!, "true", "Enter"]);
	await waitFor(
		async () => (await client.listCapsules()).find((capsule) => capsule.id === typedCapsule.id),
		(value) => value !== undefined && value.generation > beforeChange.generation,
		"prompt generation advance",
	);
	const staleApprover = (await client.listCapsules()).find((capsule) => capsule.id === otherCapsule.id)!;
	await client.approveAction({
		actionId: staleAction.id,
		capsuleId: staleApprover.id,
		generation: staleApprover.generation,
		cwdToken: staleApprover.cwdToken,
	});
	const partialStale = await waitFor(
		() => client.getAction(staleAction.id),
		(value) => value.status === "partial" && value.targets.some((target) => target.state === "stale"),
		"stale-target partial outcome",
	);
	assert.equal(targetState(partialStale, typedCapsule), "stale");
	assert.equal(targetState(partialStale, otherCapsule), "succeeded");
});
