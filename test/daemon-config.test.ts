import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { IntentClient } from "../src/client.js";
import { updateConfig } from "../src/config.js";
import { updateCredential } from "../src/credentials.js";
import type { IntentRecord } from "../src/types.js";

const daemonCli = fileURLToPath(new URL("../src/daemon-cli.js", import.meta.url));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.js", import.meta.url));

async function waitForDaemon(client: IntentClient): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			await client.ping();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error("intentd did not start");
}

async function waitForIntent(client: IntentClient, id: string): Promise<IntentRecord> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const record = await client.get(id);
		if (["succeeded", "failed"].includes(record.status)) return record;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("intent did not finish");
}

test("intentd reloads provider, model, and stored credential for every job", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-daemon-config-"));
	const socket = path.join(root, "intentd.sock");
	const state = path.join(root, "state");
	const config = path.join(root, "config.json");
	const credentials = path.join(root, "credentials.json");
	await updateConfig("provider", "deepseek", config);
	await updateConfig("model", "first-model", config);
	await updateCredential("deepseek", "test-key-not-secret", credentials);
	const child = spawn(
		process.execPath,
		[daemonCli, "--socket", socket, "--state-dir", state, "--runner", process.execPath, "--runner-arg", fakePi],
		{
			env: {
				...process.env,
				ISH_CONFIG: config,
				ISH_CREDENTIALS: credentials,
				DEEPSEEK_API_KEY: undefined,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	t.after(async () => {
		child.kill("SIGTERM");
		await new Promise((resolve) => child.once("close", resolve));
		await rm(root, { recursive: true, force: true });
	});
	const client = new IntentClient(socket);
	await waitForDaemon(client);
	let submitted = await client.submit({ objective: "first job", cwd: process.cwd(), requester: "test" });
	let completed = await waitForIntent(client, submitted.id);
	assert.equal(completed.status, "succeeded");
	let output = (await client.logs(submitted.id)).text;
	assert.match(output, /--provider.*deepseek/);
	assert.match(output, /--model.*first-model/);
	assert.match(output, /--append-system-prompt/);
	assert.match(output, /--no-builtin-tools/);
	assert.doesNotMatch(output, /--tools/);
	assert.match(output, /"credentialVariable":"DEEPSEEK_API_KEY"/);
	assert.doesNotMatch(output, /test-key-not-secret/);

	await updateConfig("model", "second-model", config);
	submitted = await client.submit({ objective: "second job", cwd: process.cwd(), requester: "test" });
	completed = await waitForIntent(client, submitted.id);
	assert.equal(completed.status, "succeeded");
	output = (await client.logs(submitted.id)).text;
	assert.match(output, /--model.*second-model/);
});
