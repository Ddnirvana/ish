import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const ish = path.join(sourceRoot, "bin", "ish");
const fakePi = path.join(sourceRoot, "dist", "test", "fixtures", "fake-pi.js");
const hasTools = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0 &&
	spawnSync("zsh", ["--version"], { stdio: "ignore" }).status === 0 &&
	spawnSync("sh", ["-c", "command -v script >/dev/null"], { stdio: "ignore" }).status === 0;

test("native visible output and status reach the next agent request", { skip: !hasTools }, async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-transcript-real-"));
	const log = path.join(root, "agent-prompt.log");
	const socket = `ish-transcript-${process.pid}-${Date.now()}`;
	const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	await chmod(fakePi, 0o755);
	t.after(async () => {
		tmux(["kill-server"]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await rm(root, { recursive: true, force: true });
	});
	let result = tmux([
		"-f", "/dev/null", "new-session", "-d", "-s", "native", "env",
		`HOME=${root}`, `ISH_RUNTIME_DIR=${path.join(root, "runtime")}`, "ISH_DISABLE_CAPSULES=1",
		`ISH_PI=${fakePi}`, `ISH_TEST_LOG=${log}`, "NO_COLOR=1", "ISH_ASCII=1", ish,
	]);
	assert.equal(result.status, 0, result.stderr);
	await new Promise((resolve) => setTimeout(resolve, 150));
	const transcriptBase = path.join(root, "runtime", "transcripts");
	const transcriptDirs = await readdir(transcriptBase);
	assert.equal(transcriptDirs.length, 1);
	const transcriptDir = path.join(transcriptBase, transcriptDirs[0]);
	assert.equal((await stat(transcriptBase)).mode & 0o777, 0o700);
	assert.equal((await stat(transcriptDir)).mode & 0o777, 0o700);
	tmux(["send-keys", "-t", "native:0.0", "print -r -- KERNEL_OK_SENTINEL; print -u2 -r -- KERNEL_WARN_SENTINEL; sleep 30 & jobs; false", "Enter"]);
	tmux(["send-keys", "-t", "native:0.0", "? analyze the above dmesg log", "Enter"]);
	let prompt = "";
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && !prompt) {
		try {
			prompt = await readFile(log, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	assert.match(prompt, /analyze the above dmesg log/);
	assert.match(prompt, /command: print -r -- KERNEL_OK_SENTINEL/);
	assert.match(prompt, /KERNEL_OK_SENTINEL/);
	assert.match(prompt, /KERNEL_WARN_SENTINEL/);
	assert.match(prompt, /sleep 30/);
	assert.match(prompt, /exit_code: 1/);
	assert.match(prompt, /provenance: ish-pty-visible-output/);
	assert.equal((await stat(path.join(transcriptDir, "events.jsonl"))).mode & 0o777, 0o600);
	result = tmux(["capture-pane", "-p", "-t", "native:0.0", "-S", "-100"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /completed: analyze the above dmesg log/);
	tmux(["send-keys", "-t", "native:0.0", "exit", "Enter"]);
	await new Promise((resolve) => setTimeout(resolve, 50));
	tmux(["send-keys", "-t", "native:0.0", "exit", "Enter"]);
	const cleanupDeadline = Date.now() + 2000;
	while (Date.now() < cleanupDeadline && (await readdir(transcriptBase)).length) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.deepEqual(await readdir(transcriptBase), []);
});
