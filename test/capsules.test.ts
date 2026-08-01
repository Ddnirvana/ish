import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CapsuleActionStore, cwdToken, newCapsuleId } from "../src/capsules.js";

test("capsule action protocol validates versions and admits an operation at most once", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-capsule-"));
	const fifo = path.join(root, "capsule.fifo");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	const reader = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
	t.after(async () => {
		await reader.close();
		await rm(root, { recursive: true, force: true });
	});

	const store = new CapsuleActionStore(path.join(root, "state"));
	await store.initialize();
	const id = newCapsuleId();
	await store.register({
		id,
		host: "server-a",
		bootId: "boot-a",
		shell: "zsh",
		pid: process.pid,
		processStart: "start-a",
		endpoint: fifo,
		generation: 7,
		cwd: "/srv/api",
		mode: "prompt",
		lineEditor: "ready",
		authority: "uid:test",
		session: "prod",
		pane: "%1",
	});

	const planned = await store.createAction({ selector: "session:prod", command: "uptime", effectClass: "observation" });
	const dispatched = await store.dispatchAction(planned.id);
	assert.equal(dispatched.targets[0]?.state, "dispatched");
	const wire = Buffer.alloc(4096);
	const read = await reader.read(wire, 0, wire.length, null);
	assert.match(wire.subarray(0, read.bytesRead).toString(), new RegExp(`^v1\\t${planned.id}\\t${id}\\t7\\t`));

	const admitted = await store.admit({
		actionId: planned.id,
		capsuleId: id,
		generation: 7,
		cwdToken: cwdToken("/srv/api"),
		lineEditorReady: true,
	});
	assert.equal(admitted.execute, true);
	const duplicate = await store.admit({
		actionId: planned.id,
		capsuleId: id,
		generation: 7,
		cwdToken: cwdToken("/srv/api"),
		lineEditorReady: true,
	});
	assert.equal(duplicate.execute, false);
	assert.match(duplicate.witness ?? "", /duplicate/);
	await store.report({ actionId: planned.id, capsuleId: id, state: "running" });
	const completed = await store.report({ actionId: planned.id, capsuleId: id, state: "succeeded", exitCode: 0 });
	assert.equal(completed.status, "succeeded");
});

test("capsule action protocol exposes stale, busy, unsafe, and uncertain outcomes", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-capsule-failures-"));
	const fifo = path.join(root, "capsule.fifo");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	const reader = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
	const wire = Buffer.alloc(4096);
	t.after(async () => {
		await reader.close();
		await rm(root, { recursive: true, force: true });
	});

	const stateDir = path.join(root, "state");
	const store = new CapsuleActionStore(stateDir);
	await store.initialize();
	const id = newCapsuleId();
	await store.register({
		id,
		host: "server-a",
		bootId: "boot-a",
		shell: "zsh",
		pid: process.pid,
		processStart: "start-a",
		endpoint: fifo,
		generation: 1,
		cwd: "/srv/api",
		authority: "uid:test",
		session: "prod",
		pane: "%1",
	});

	const stale = await store.createAction({ selector: `capsule:${id}`, command: "pwd", effectClass: "observation" });
	await store.update({ id, generation: 2, cwd: "/srv/api-v2" });
	assert.equal((await store.dispatchAction(stale.id)).targets[0]?.state, "stale");

	const busy = await store.createAction({ selector: `capsule:${id}`, command: "pwd", effectClass: "observation" });
	await store.update({ id, lineEditor: "busy" });
	assert.equal((await store.dispatchAction(busy.id)).targets[0]?.state, "busy");
	await store.update({ id, lineEditor: "ready" });

	const unsafe = await store.createAction({ selector: `capsule:${id}`, command: "rm -rf /", effectClass: "unsafe" });
	await assert.rejects(() => store.dispatchAction(unsafe.id), /unsafe actions cannot/);
	await assert.rejects(
		() => store.createAction({ selector: `capsule:${id}`, command: "echo changed > state", effectClass: "observation" }),
		/effectful construct/,
	);

	const captured = await store.createAction({ selector: `capsule:${id}`, command: "printf diagnostic", effectClass: "observation" });
	await store.dispatchAction(captured.id);
	await reader.read(wire, 0, wire.length, null);
	await store.admit({
		actionId: captured.id,
		capsuleId: id,
		generation: 2,
		cwdToken: cwdToken("/srv/api-v2"),
		lineEditorReady: true,
	});
	const capturedResult = await store.report({
		actionId: captured.id,
		capsuleId: id,
		state: "succeeded",
		exitCode: 0,
		output: "x".repeat(70_000),
	});
	assert.equal(capturedResult.targets[0]?.output?.length, 65_536);

	const running = await store.createAction({ selector: `capsule:${id}`, command: "sleep 1", effectClass: "observation" });
	await store.dispatchAction(running.id);
	await reader.read(wire, 0, wire.length, null);
	await store.admit({
		actionId: running.id,
		capsuleId: id,
		generation: 2,
		cwdToken: cwdToken("/srv/api-v2"),
		lineEditorReady: true,
	});
	await store.report({ actionId: running.id, capsuleId: id, state: "running" });

	const restarted = new CapsuleActionStore(stateDir);
	await restarted.initialize();
	assert.equal(restarted.listCapsules().find((capsule) => capsule.id === id)?.mode, "prompt");
	const recovered = restarted.getAction(running.id);
	assert.equal(recovered.status, "uncertain");
	assert.equal(recovered.targets[0]?.state, "uncertain");
	assert.match(recovered.targets[0]?.witness ?? "", /restarted/);

	await rm(fifo);
	const unreachable = await restarted.createAction({ selector: `capsule:${id}`, command: "pwd", effectClass: "observation" });
	assert.equal((await restarted.dispatchAction(unreachable.id)).targets[0]?.state, "unreached");
});
