import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ish = fileURLToPath(new URL("../../bin/ish", import.meta.url));
const intentd = fileURLToPath(new URL("../../bin/intentd", import.meta.url));

test("ish launcher preserves user zsh configuration and loads the shell layer", async (t) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "ish-launcher-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await writeFile(path.join(home, ".zshrc"), "typeset -g ISH_USER_RC_OK=preserved\nHISTFILE=$ZDOTDIR/.zsh_history\n");
	const result = spawnSync(ish, ["-ic", "print -r -- $ISH_USER_RC_OK:${+functions[_ish_accept_line]}:$ZDOTDIR:$HISTFILE"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, TERM: "dumb", NO_COLOR: "1", ISH_DISABLE_CAPSULES: "1" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /preserved:1:/);
	assert.match(result.stdout, /shell\/zdot/);
	assert.match(result.stdout, new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/.zsh_history`));
	assert.doesNotMatch(result.stdout, /shell\/zdot\/\.zsh_history/);
});

test("intentd launcher uses bundled Pi while preserving an explicit runner", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-intentd-launcher-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "bin"), { recursive: true });
	await mkdir(path.join(root, "dist", "src"), { recursive: true });
	await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
	await copyFile(intentd, path.join(root, "bin", "intentd"));
	await chmod(path.join(root, "bin", "intentd"), 0o755);
	await writeFile(path.join(root, "node_modules", ".bin", "pi"), "#!/bin/sh\nexit 0\n");
	await chmod(path.join(root, "node_modules", ".bin", "pi"), 0o755);
	await writeFile(path.join(root, "dist", "src", "daemon-cli.js"), "console.log(process.env.INTENTD_PI ?? '');\n");

	let result = spawnSync(path.join(root, "bin", "intentd"), [], { encoding: "utf8", env: { ...process.env, INTENTD_PI: undefined } });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), path.join(root, "node_modules", ".bin", "pi"));

	result = spawnSync(path.join(root, "bin", "intentd"), [], { encoding: "utf8", env: { ...process.env, INTENTD_PI: "/custom/pi" } });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "/custom/pi");
});
