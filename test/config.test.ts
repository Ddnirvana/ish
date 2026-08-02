import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readConfig, updateConfig } from "../src/config.js";
import { credentialStatus, piEnvironment, readCredentials, updateCredential } from "../src/credentials.js";

const cli = fileURLToPath(new URL("../src/ctl-cli.js", import.meta.url));

test("configuration persists provider and model without accepting secrets", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-config-"));
	const file = path.join(root, "config.json");
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.deepEqual(await readConfig(file), {});
	await updateConfig("provider", "deepseek", file);
	await updateConfig("model", "deepseek-v4-flash", file);
	assert.deepEqual(await readConfig(file), { provider: "deepseek", model: "deepseek-v4-flash" });
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.doesNotMatch(await readFile(file, "utf8"), /api.?key|secret/i);
	await assert.rejects(() => updateConfig("provider", "deepseek; export KEY=value", file));
	await updateConfig("model", undefined, file);
	assert.deepEqual(await readConfig(file), { provider: "deepseek" });
});

test("credentials are atomic, private, redacted, and overridden by the environment", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-credentials-"));
	const file = path.join(root, "config", "credentials.json");
	t.after(() => rm(root, { recursive: true, force: true }));
	await updateCredential("deepseek", "test-key-not-secret", file);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
	assert.deepEqual(await readCredentials(file), { version: 1, providers: { deepseek: "test-key-not-secret" } });
	assert.equal((await credentialStatus("deepseek", {}, file)).source, "stored");
	assert.equal((await credentialStatus("deepseek", { DEEPSEEK_API_KEY: "temporary" }, file)).source, "environment");
	assert.equal((await piEnvironment({ provider: "deepseek" }, {}, file)).DEEPSEEK_API_KEY, "test-key-not-secret");
	assert.equal((await piEnvironment({ provider: "deepseek" }, { DEEPSEEK_API_KEY: "temporary" }, file)).DEEPSEEK_API_KEY, "temporary");
	assert.deepEqual(await piEnvironment({ provider: "openai-codex" }, {}, file), {});
	assert.equal((await credentialStatus("openai-codex", {}, file)).source, "pi-managed");
	await updateCredential("deepseek", undefined, file);
	assert.equal((await credentialStatus("deepseek", {}, file)).source, "missing");
	await assert.rejects(() => updateCredential("custom-provider", "value", file), /pi\.dev\/docs\/latest\/providers/);
});

test("ish config accepts a key only from stdin and never displays it", async (t) => {
	const { spawnSync } = await import("node:child_process");
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-config-key-"));
	const config = path.join(root, "config.json");
	const credentials = path.join(root, "credentials.json");
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env, ISH_CONFIG: config, ISH_CREDENTIALS: credentials, DEEPSEEK_API_KEY: undefined };
	let result = spawnSync(process.execPath, [cli, "config", "set", "provider", "deepseek"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	result = spawnSync(process.execPath, [cli, "config", "set", "key"], {
		encoding: "utf8",
		input: "test-key-not-secret\n",
		env,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout + result.stderr, /test-key-not-secret/);
	result = spawnSync(process.execPath, [cli, "config", "show"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"source": "stored"/);
	assert.doesNotMatch(result.stdout, /test-key-not-secret/);
	result = spawnSync(process.execPath, [cli, "config", "set", "key", "deepseek", "argument-value"], { encoding: "utf8", env });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /hidden prompt/);
	result = spawnSync(process.execPath, [cli, "config", "unset", "key"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(await readFile(credentials, "utf8"), /test-key-not-secret|argument-value/);
});

test("interactive credential input is hidden in a real terminal", async (t) => {
	const { spawnSync } = await import("node:child_process");
	if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return t.skip("tmux is unavailable");
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-hidden-key-"));
	const credentials = path.join(root, "credentials.json");
	const socket = `ish-key-${process.pid}-${Date.now()}`;
	const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	t.after(async () => {
		tmux(["kill-server"]);
		await rm(root, { recursive: true, force: true });
	});
	let result = tmux(["-f", "/dev/null", "new-session", "-d", "-s", "key", "zsh", "-f"]);
	assert.equal(result.status, 0, result.stderr);
	const command = `ISH_CREDENTIALS=${JSON.stringify(credentials)} ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} config set key deepseek`;
	tmux(["send-keys", "-t", "key:0.0", command, "Enter"]);
	const promptDeadline = Date.now() + 3000;
	let prompt = "";
	while (Date.now() < promptDeadline && !/API key for deepseek:/.test(prompt)) {
		prompt = tmux(["capture-pane", "-p", "-t", "key:0.0", "-S", "-100"]).stdout;
		if (!/API key for deepseek:/.test(prompt)) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.match(prompt, /API key for deepseek:/);
	tmux(["send-keys", "-t", "key:0.0", "terminal-key-not-secret", "Enter"]);
	const deadline = Date.now() + 3000;
	let stored = "";
	while (Date.now() < deadline && !stored) {
		try {
			stored = await readFile(credentials, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	assert.match(stored, /terminal-key-not-secret/);
	result = tmux(["capture-pane", "-p", "-t", "key:0.0", "-S", "-100"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /API key for deepseek:/);
	assert.doesNotMatch(result.stdout, /terminal-key-not-secret/);
});
