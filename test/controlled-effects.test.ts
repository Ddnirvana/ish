import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { IntentClient } from "../src/client.js";
import { IntentDaemon } from "../src/daemon.js";
import intentExtension from "../src/pi-extension.js";
import type { PiExtensionAPI } from "../src/pi-types.js";

test("Pi can persist and hand off an effect proposal but cannot execute it", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-pi-effect-"));
	const socketPath = path.join(root, "intentd.sock");
	const stateDir = path.join(root, "state");
	const fifo = path.join(root, "capsule.fifo");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	const reader = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
	const daemon = new IntentDaemon({
		socketPath,
		stateDir,
		runner: { command: process.execPath, args: ["--version"] },
	});
	await daemon.start();
	const previousSocket = process.env.INTENTD_SOCKET;
	const previousCapsule = process.env.ISH_CAPSULE_ID;
	t.after(async () => {
		if (previousSocket === undefined) delete process.env.INTENTD_SOCKET;
		else process.env.INTENTD_SOCKET = previousSocket;
		if (previousCapsule === undefined) delete process.env.ISH_CAPSULE_ID;
		else process.env.ISH_CAPSULE_ID = previousCapsule;
		await daemon.stop();
		await reader.close();
		await rm(root, { recursive: true, force: true });
	});

	const client = new IntentClient(socketPath);
	const id = (await client.newCapsuleId()).id;
	await client.registerCapsule({
		id,
		host: "server-a",
		bootId: "boot-a",
		shell: "zsh",
		pid: process.pid,
		processStart: "start-a",
		endpoint: fifo,
		generation: 1,
		cwd: root,
		authority: "uid:test",
	});
	process.env.INTENTD_SOCKET = socketPath;
	process.env.ISH_CAPSULE_ID = id;

	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const api = {
		on() {},
		registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		getActiveTools() { return []; },
		getAllTools() { return []; },
		setActiveTools() {},
	};
	intentExtension(api as unknown as PiExtensionAPI);
	const context = { cwd: root, ui: { notify() {} } };
	const signal = new AbortController().signal;
	const proposed = await tools.get("shell_propose")!.execute(
		"call-propose",
		{
			command: "printf '%s\\n' 'quoted ; $(not-executed)'",
			reason: "verify the controlled effect bridge",
			resources: [path.join(root, "result file")],
		},
		signal,
		undefined,
		context,
	);
	const proposalId = proposed.details.id as string;
	const stored = await client.getAction(proposalId);
	assert.equal(stored.approval, "pending");
	assert.equal(stored.status, "planned");
	assert.match(proposed.details.next, new RegExp(`/apply ${proposalId}`));
	await assert.rejects(() => client.dispatchAction(proposalId), /requires interactive ish approval/);

	const handedOff = await tools.get("shell_apply")!.execute(
		"call-apply",
		{ id: proposalId },
		signal,
		undefined,
		context,
	);
	assert.equal(handedOff.details.status, "planned");
	assert.equal((await client.getAction(proposalId)).status, "planned");
	assert.match(handedOff.details.next, new RegExp(`/apply ${proposalId}`));

	const unsafe = await tools.get("shell_propose")!.execute(
		"call-unsafe",
		{
			command: "bash -c 'rm -rf /'",
			reason: "verify critical wrapper refusal",
			resources: ["/"],
		},
		signal,
		undefined,
		context,
	);
	const unsafeId = unsafe.details.id as string;
	assert.equal((await client.getAction(unsafeId)).effectClass, "unsafe");
	const capsule = (await client.listCapsules())[0]!;
	await assert.rejects(
		() => client.approveAction({
			actionId: unsafeId,
			capsuleId: id,
			generation: 1,
			cwdToken: capsule.cwdToken,
		}),
		/unsafe proposal cannot be approved/,
	);
	const refused = await client.getAction(unsafeId);
	assert.equal(refused.approval, "cancelled");
	assert.match(refused.approvalWitness ?? "", /unsafe proposal refused/);
});
