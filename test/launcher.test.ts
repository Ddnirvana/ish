import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ish = fileURLToPath(new URL("../../bin/ish", import.meta.url));

test("ish launcher preserves user zsh configuration and loads the shell layer", async (t) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "ish-launcher-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await writeFile(path.join(home, ".zshrc"), "typeset -g ISH_USER_RC_OK=preserved\n");
	const result = spawnSync(ish, ["-ic", "print -r -- $ISH_USER_RC_OK:${+functions[_ish_accept_line]}:$ZDOTDIR"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, TERM: "dumb", NO_COLOR: "1", ISH_DISABLE_CAPSULES: "1" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /preserved:1:/);
	assert.match(result.stdout, /shell\/zdot/);
});
