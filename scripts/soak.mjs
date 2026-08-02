#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntentClient } from "../dist/src/client.js";
import { IntentDaemon } from "../dist/src/daemon.js";
import { routeInput } from "../dist/src/gateway.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakePi = path.join(sourceRoot, "dist", "test", "fixtures", "fake-pi.js");
const ish = path.join(sourceRoot, "bin", "ish");
const requested = Number(process.argv[process.argv.indexOf("--iterations") + 1] ?? 200);
if (!Number.isInteger(requested) || requested < 10 || requested > 10_000) {
	throw new Error("--iterations must be an integer from 10 to 10000");
}

const root = await mkdtemp(path.join(os.tmpdir(), "ish-daily-soak-"));
const socketPath = path.join(root, "intentd.sock");
const stateDir = path.join(root, "state");
const options = {
	socketPath,
	stateDir,
	runner: { command: process.execPath, args: [fakePi] },
};
let daemon = new IntentDaemon(options);
let durableJobs = 0;
let restarts = 0;

async function waitFor(client, id) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const record = await client.get(id);
		if (["succeeded", "failed"].includes(record.status)) return record;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`intent ${id} did not finish`);
}

try {
	await daemon.start();
	let client = new IntentClient(socketPath);
	for (let index = 0; index < requested; index += 1) {
		assert.equal(routeInput(`printf '%s\\n' ${index}`, { commandExists: () => true }).route, "native");
		assert.equal(routeInput(`? explain iteration ${index}`, { commandExists: () => true }).route, "agent");
		await client.ping();
		await client.recordContext({
			kind: "native-command",
			scope: { host: "soak", cwd: root },
			content: `iteration ${index}`,
			provenance: "daily-soak",
		});
		if (index % 10 === 0) {
			const shell = spawnSync(ish, ["-f", "-c", `print -r -- native-${index}`], {
				encoding: "utf8",
				env: {
					...process.env,
					HOME: root,
					ISH_DISABLE_CAPSULES: "1",
					NO_COLOR: "1",
				},
			});
			assert.equal(shell.status, 0, shell.stderr);
			assert.equal(shell.stdout.trim(), `native-${index}`);
			const submitted = await client.submit({
				objective: `durable soak job ${index}`,
				cwd: root,
				requester: "daily-soak",
			});
			const completed = await waitFor(client, submitted.id);
			assert.equal(completed.status, "succeeded");
			durableJobs += 1;
		}
		if (index > 0 && index % 50 === 0) {
			await daemon.stop();
			daemon = new IntentDaemon(options);
			await daemon.start();
			client = new IntentClient(socketPath);
			await client.ping();
			restarts += 1;
		}
	}
	const context = await client.queryContext({ scope: { host: "soak", cwd: root }, limit: requested });
	assert.equal(context.length, requested);
	console.log(JSON.stringify({ result: "PASS", iterations: requested, durableJobs, restarts }));
} finally {
	await daemon.stop().catch(() => undefined);
	await rm(root, { recursive: true, force: true });
}
