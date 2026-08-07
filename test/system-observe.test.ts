import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { inspectGit } from "../extensions/system-observe/git.js";
import { observeService, queryLogs } from "../extensions/system-observe/log-service.js";
import { observeNetwork } from "../extensions/system-observe/network.js";
import { observeProcesses } from "../extensions/system-observe/process.js";
import { runObservation } from "../extensions/system-observe/runner.js";
import { observeShell } from "../extensions/system-observe/shell.js";

async function temporary(t: TestContext, prefix: string): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("shell_observe searches retained native output without injecting the whole log", async (t) => {
	const root = await temporary(t, "ish-shell-observe-");
	const events = path.join(root, "events.jsonl");
	const output = `${"routine kernel line\n".repeat(20_000)}WARNING: thermal throttle detected\n${"tail\n".repeat(2_000)}`;
	await writeFile(events, `${JSON.stringify({
		version: 1,
		id: "dmesg-1",
		timestamp: "2026-08-07T00:00:00.000Z",
		command: "sudo dmesg",
		cwd: "/srv",
		exitCode: 0,
		durationMs: 25,
		output,
		outputBytes: Buffer.byteLength(output),
		truncated: false,
		provenance: "ish-pty-visible-output",
	})}\n`, { mode: 0o600 });
	const result = await observeShell({ operation: "search", query: "warning", command: "dmesg", maxOutputBytes: 2048 }, events);
	assert.equal(result.matchedEvents, 1);
	assert.match(result.events[0].output, /thermal throttle detected/);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024);
});

test("process_observe returns exact ownership for the current process", async () => {
	const result = await observeProcesses({ operation: "pid", pid: process.pid });
	assert.equal(result.supported, true);
	assert.equal(result.complete, true);
	assert.equal(result.processes[0]?.pid, process.pid);
	assert.ok(result.processes[0]?.user);
});

test("network_observe identifies the process holding a real TCP port", async (t) => {
	const server = createServer();
	await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const result = await observeNetwork({ operation: "listening_port", port: address.port });
	if (!result.supported) return t.skip("ss/lsof is unavailable on this platform");
	assert.equal(result.listeners.some((listener) => listener.pid === process.pid), true, JSON.stringify(result));
	assert.equal(result.listeners.find((listener) => listener.pid === process.pid)?.owner?.pid, process.pid);
});

test("git_inspect explains a dirty tree without changing it", async (t) => {
	const root = await temporary(t, "ish-git-observe-");
	const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	run(["init", "-q"]);
	run(["config", "user.name", "ish test"]);
	run(["config", "user.email", "ish@example.invalid"]);
	await writeFile(path.join(root, "tracked.txt"), "before\n");
	run(["add", "tracked.txt"]);
	run(["commit", "-qm", "base"]);
	await writeFile(path.join(root, "tracked.txt"), "after\n");
	await writeFile(path.join(root, "untracked.txt"), "new\n");
	const before = run(["status", "--porcelain=v1"]);
	const result = await inspectGit({ operation: "overview" }, { cwd: root, ui: { notify() {} } });
	const after = run(["status", "--porcelain=v1"]);
	assert.equal(result.complete, true, JSON.stringify(result));
	assert.equal(before, after);
	const details = result as typeof result & { status: unknown; diffs: unknown };
	assert.match(JSON.stringify(details.status), /tracked\.txt/);
	assert.match(JSON.stringify(details.status), /untracked\.txt/);
	assert.match(JSON.stringify(details.diffs), /before/);
	assert.match(JSON.stringify(details.diffs), /after/);
});

test("observation runner reports output limits, timeouts, and cancellation", async () => {
	const truncated = await runObservation(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxOutputBytes: 128 });
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.complete, false);
	assert.deepEqual(truncated.incompleteReasons, ["output-limit"]);
	assert.equal(Buffer.byteLength(truncated.stdout), 128);
	const tail = await runObservation(process.execPath, ["-e", "process.stdout.write('FIRST' + 'x'.repeat(4096) + 'LAST')"], { maxOutputBytes: 128, retain: "tail" });
	assert.equal(tail.truncated, true);
	assert.doesNotMatch(tail.stdout, /FIRST/);
	assert.match(tail.stdout, /LAST$/);

	const timedOut = await runObservation(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 30 });
	assert.equal(timedOut.timedOut, true);
	assert.equal(timedOut.complete, false);
	assert.ok(timedOut.incompleteReasons.includes("timeout"));

	const controller = new AbortController();
	const pending = runObservation(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});

test("service and journal observations diagnose a failed user unit on Linux", { skip: process.platform !== "linux" }, async (t) => {
	const root = await temporary(t, "ish-service-observe-");
	const systemctl = path.join(root, "systemctl");
	const journalctl = path.join(root, "journalctl");
	await writeFile(systemctl, "#!/bin/sh\nprintf '%s\\n' 'Id=demo.service' 'Description=Demo' 'LoadState=loaded' 'ActiveState=failed' 'SubState=failed' 'Result=exit-code' 'MainPID=0' 'ExecMainStatus=1'\n");
	await writeFile(journalctl, "#!/bin/sh\nprintf '%s\\n' 'demo[42]: startup failed: missing configuration'\n");
	await chmod(systemctl, 0o755);
	await chmod(journalctl, 0o755);
	const env = { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` };
	const service = await observeService({ unit: "demo.service", scope: "user", journalLines: 20 }, undefined, env);
	assert.equal(service.complete, true);
	assert.equal((service.properties as Record<string, string>).ActiveState, "failed");
	assert.equal((service.properties as Record<string, string>).Result, "exit-code");
	assert.match(service.journal, /missing configuration/);
	const journal = await queryLogs({ source: "journal", unit: "demo.service", scope: "user", lines: 10 }, undefined, env);
	assert.equal(journal.complete, true);
	assert.match(journal.records, /startup failed/);
});
