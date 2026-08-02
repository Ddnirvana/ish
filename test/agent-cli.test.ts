import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { updateConfig } from "../src/config.js";
import { updateCredential } from "../src/credentials.js";

const cli = fileURLToPath(new URL("../src/ctl-cli.js", import.meta.url));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.js", import.meta.url));

test("agent CLI passes the ish identity to Pi and renders bounded status", () => {
	chmodSync(fakePi, 0o755);
	const result = spawnSync(process.execPath, [cli, "ask", "--", "what shell is this?"], {
		encoding: "utf8",
		env: { ...process.env, ISH_PI: fakePi, NO_COLOR: "1", ISH_ASCII: "1", INTENTD_SOCKET: "/missing/intentd.sock" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^> ish agent/m);
	assert.match(result.stdout, /completed: what shell is this\?/);
	assert.match(result.stdout, /--append-system-prompt/);
	assert.match(result.stdout, /ish \(intent shell\)/);
	assert.match(result.stdout, /--extension/);
	assert.match(result.stdout, /pi-extension\.js/);
	assert.match(result.stdout, /read,grep,find,ls,system_inspect/);
	assert.match(result.stdout, /^ok ish done in /m);
});

test("missing Pi reports a concise recovery action without a Node stack", () => {
	const result = spawnSync(process.execPath, [cli, "ask", "--", "hello"], {
		encoding: "utf8",
		env: { ...process.env, ISH_PI: "/definitely/missing/pi", NO_COLOR: "1", ISH_ASCII: "1", INTENTD_SOCKET: "/missing/intentd.sock" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^error ish /);
	assert.doesNotMatch(result.stderr, /node:internal|at ChildProcess|ENOENT/);
});

test("agent CLI loads a stored provider key without displaying it", async (t) => {
	chmodSync(fakePi, 0o755);
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-agent-credential-"));
	const config = path.join(root, "config.json");
	const credentials = path.join(root, "credentials.json");
	t.after(() => rm(root, { recursive: true, force: true }));
	await updateConfig("provider", "deepseek", config);
	await updateCredential("deepseek", "test-key-not-secret", credentials);
	const result = spawnSync(process.execPath, [cli, "ask", "--", "credential probe"], {
		encoding: "utf8",
		env: {
			...process.env,
			ISH_PI: fakePi,
			ISH_CONFIG: config,
			ISH_CREDENTIALS: credentials,
			DEEPSEEK_API_KEY: undefined,
			NO_COLOR: "1",
			ISH_ASCII: "1",
			INTENTD_SOCKET: "/missing/intentd.sock",
		},
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"credentialVariable":"DEEPSEEK_API_KEY"/);
	assert.doesNotMatch(result.stdout + result.stderr, /test-key-not-secret/);
});

test("leading question routing stays invisible in a real zsh editor", async (t) => {
	const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
	if (!hasTmux) return t.skip("tmux is unavailable");
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-zle-ui-"));
	const bin = path.join(root, "bin");
	const log = path.join(root, "agent.log");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
	const fakeCtl = path.join(bin, "ishctl");
	await writeFile(fakeCtl, `#!/bin/sh\ncase "$1" in\n  route) echo agent ;;\n  ask) shift; [ "$1" = -- ] && shift; printf 'agent-reply:%s\\n' "$*"; printf '%s\\n' "$*" >> "$ISH_TEST_LOG" ;;\n  ping) exit 1 ;;\n  *) exit 0 ;;\nesac\n`);
	await chmod(fakeCtl, 0o755);
	const socket = `ish-zle-${process.pid}-${Date.now()}`;
	const shell = fileURLToPath(new URL("../../shell/ish.zsh", import.meta.url));
	const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	t.after(async () => {
		tmux(["kill-server"]);
		await rm(root, { recursive: true, force: true });
	});
	let result = tmux(["-f", "/dev/null", "new-session", "-d", "-s", "ux", "env", `PATH=${bin}:${process.env.PATH}`, "ISH_PROMPT_STYLE=off", `ISH_TEST_LOG=${log}`, "zsh", "-df"]);
	assert.equal(result.status, 0, result.stderr);
	tmux(["send-keys", "-t", "ux:0.0", `source ${shell}`, "Enter"]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	tmux(["send-keys", "-t", "ux:0.0", "? what shell is this?", "Enter"]);
	let recorded = "";
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && !recorded) {
		try {
			recorded = (await readFile(log, "utf8")).trim();
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	assert.equal(recorded, "what shell is this?");
	result = tmux(["capture-pane", "-p", "-t", "ux:0.0", "-S", "-100"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /agent-reply:what shell is this\?/);
	assert.doesNotMatch(result.stdout, /ishctl ask --/);
});
