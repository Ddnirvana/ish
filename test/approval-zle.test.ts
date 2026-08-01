import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

test("dangerous native operations require visible one-shot approval", { skip: !hasTmux }, async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-approval-"));
	const marker = path.join(root, "keep-until-approved");
	const riskLog = path.join(root, "risk.log");
	const bin = path.join(root, "bin");
	await mkdir(marker);
	await mkdir(bin);
	const fakeCtl = path.join(bin, "ishctl");
	await writeFile(fakeCtl, "#!/bin/sh\ncase \"$1\" in\n  risk) printf x >> \"$ISH_RISK_LOG\"; printf 'danger\\trecursive-delete\\trecursive deletion can remove a directory tree\\n' ;;\n  ping) exit 1 ;;\n  route) echo native ;;\n  *) exit 0 ;;\nesac\n");
	await chmod(fakeCtl, 0o755);
	const socket = `ish-approval-${process.pid}-${Date.now()}`;
	const shell = fileURLToPath(new URL("../../shell/ish.zsh", import.meta.url));
	const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	t.after(async () => {
		tmux(["kill-server"]);
		await rm(root, { recursive: true, force: true });
	});
	let result = tmux(["-f", "/dev/null", "new-session", "-d", "-s", "approval", "env", `PATH=${bin}:${process.env.PATH}`, `ISH_RISK_LOG=${riskLog}`, "ISH_PROMPT_STYLE=off", "NO_COLOR=1", "zsh", "-df"]);
	assert.equal(result.status, 0, result.stderr);
	tmux(["send-keys", "-t", "approval:0.0", `source ${shell}`, "Enter"]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	const destructive = `rm -rf ${marker}`;
	tmux(["send-keys", "-t", "approval:0.0", destructive, "Enter"]);
	let riskCalls = 0;
	let activationDeadline = Date.now() + 3000;
	while (Date.now() < activationDeadline && riskCalls < 1) {
		try {
			riskCalls = (await readFile(riskLog, "utf8")).length;
		} catch {
			// The first classification has not started yet.
		}
		if (riskCalls < 1) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	await new Promise((resolve) => setTimeout(resolve, 25));
	result = tmux(["capture-pane", "-p", "-t", "approval:0.0", "-S", "-40"]);
	assert.match(result.stdout, /ish approval required \[danger\/recursive-delete\]/);
	assert.match(result.stdout, /y=run once/);
	assert.match(result.stdout, /n=cancel/);
	tmux(["send-keys", "-t", "approval:0.0", "n"]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(await exists(marker), true, "cancel must preserve the target");

	tmux(["send-keys", "-t", "approval:0.0", destructive, "Enter"]);
	activationDeadline = Date.now() + 3000;
	while (Date.now() < activationDeadline && riskCalls < 2) {
		riskCalls = (await readFile(riskLog, "utf8")).length;
		if (riskCalls < 2) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	tmux(["send-keys", "-t", "approval:0.0", "y"]);
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && (await exists(marker))) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(await exists(marker), false, "approval must execute the exact displayed command");
});
