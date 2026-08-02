import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig, updateConfig } from "../src/config.js";

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

test("documented zsh credential prompt reads the value from hidden stdin", () => {
	const result = spawnSync(
		"zsh",
		["-c", "read -rs 'ISH_SECRET?API key: '; print; print -r -- set:${#ISH_SECRET}"],
		{ encoding: "utf8", input: "example-secret\n" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "\nset:14\n");
});
