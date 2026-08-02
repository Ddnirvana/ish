import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { IntentClient } from "../src/client.js";
import { IntentDaemon } from "../src/daemon.js";
import type { IntentRecord, IntentStatus } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.js", import.meta.url));

async function waitFor(
	client: IntentClient,
	id: string,
	statuses: IntentStatus[],
	timeoutMs = 5000,
): Promise<IntentRecord> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = await client.get(id);
		if (statuses.includes(record.status)) return record;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${id} to reach ${statuses.join(", ")}`);
}

test("a second client can inspect, read, and cancel durable Pi jobs", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-test-"));
	const socketPath = path.join(root, "intentd.sock");
	const stateDir = path.join(root, "state");
	const daemon = new IntentDaemon({
		socketPath,
		stateDir,
		runner: { command: process.execPath, args: [fixture] },
	});
	await daemon.start();
	t.after(async () => {
		await daemon.stop();
		await rm(root, { recursive: true, force: true });
	});

	const sessionA = new IntentClient(socketPath);
	const sessionB = new IntentClient(socketPath);
	const submitted = await sessionA.submit({
		objective: "produce cross-session evidence",
		acceptance: ["emit an agent_end event"],
		cwd: process.cwd(),
		requester: "pi-session-A",
	});
	const completed = await waitFor(sessionB, submitted.id, ["succeeded"]);

	assert.equal(completed.requester, "pi-session-A");
	assert.equal(completed.attempt, 1);
	assert.equal(completed.exitCode, 0);
	assert.ok((await sessionB.list()).some((record) => record.id === submitted.id));
	const output = (await sessionB.logs(submitted.id)).text;
	assert.match(output, /agent_start/);
	assert.match(output, /Acceptance criteria/);
	assert.match(output, /agent_end/);

	const longJob = await sessionA.submit({
		objective: "LONG cancellable work",
		cwd: process.cwd(),
		requester: "pi-session-A",
	});
	await waitFor(sessionB, longJob.id, ["running"]);
	const cancelled = await sessionB.cancel(longJob.id);
	assert.equal(cancelled.status, "cancelled");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal((await sessionA.get(longJob.id)).status, "cancelled");
});

test("completed intent state survives daemon restart", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-restart-"));
	const socketPath = path.join(root, "intentd.sock");
	const stateDir = path.join(root, "state");
	const options = {
		socketPath,
		stateDir,
		runner: { command: process.execPath, args: [fixture] },
	};
	const first = new IntentDaemon(options);
	await first.start();
	const firstClient = new IntentClient(socketPath);
	const submitted = await firstClient.submit({
		objective: "persist this result",
		cwd: process.cwd(),
		requester: "pi-session-A",
	});
	await firstClient.recordContext({
		kind: "agent-request",
		scope: { host: "server-a", session: "prod", pane: "%1", cwd: "/srv/api" },
		content: "persistent system-level question",
		provenance: "pi-session-A",
	});
	await waitFor(firstClient, submitted.id, ["succeeded"]);
	await first.stop();

	const second = new IntentDaemon(options);
	await second.start();
	t.after(async () => {
		await second.stop();
		await rm(root, { recursive: true, force: true });
	});
	const recovered = await new IntentClient(socketPath).get(submitted.id);
	assert.equal(recovered.status, "succeeded");
	assert.equal(recovered.objective, "persist this result");
	const context = await new IntentClient(socketPath).queryContext({
		scope: { host: "server-a", session: "prod", pane: "%1", cwd: "/srv/api/logs" },
	});
	assert.equal(context[0]?.content, "persistent system-level question");
});

test("runner configuration failures become terminal intent failures", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-runner-config-failure-"));
	const socketPath = path.join(root, "intentd.sock");
	const daemon = new IntentDaemon({
		socketPath,
		stateDir: path.join(root, "state"),
		runner: {
			command: process.execPath,
			args: async () => {
				throw new Error("invalid provider configuration");
			},
		},
	});
	await daemon.start();
	t.after(async () => {
		await daemon.stop();
		await rm(root, { recursive: true, force: true });
	});
	const client = new IntentClient(socketPath);
	const submitted = await client.submit({
		objective: "fail clearly",
		cwd: process.cwd(),
		requester: "test",
	});
	const failed = await waitFor(client, submitted.id, ["failed"]);
	assert.match(failed.error ?? "", /runner configuration failed: invalid provider configuration/);
	assert.match((await client.logs(submitted.id)).text, /invalid provider configuration/);
});
