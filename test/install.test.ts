import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const install = fileURLToPath(new URL("../../scripts/install.sh", import.meta.url));
const uninstall = fileURLToPath(new URL("../../scripts/uninstall.sh", import.meta.url));

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

test("install, upgrade, launcher, and uninstall are idempotent in a disposable prefix", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-install-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const prefix = path.join(root, "prefix");
	const fakeBin = path.join(root, "bin");
	await mkdir(fakeBin);
	const fakeNpm = path.join(fakeBin, "npm");
	await writeFile(fakeNpm, "#!/bin/sh\nexit 0\n");
	await chmod(fakeNpm, 0o755);
	const env = { ...process.env, ISH_PREFIX: prefix, PATH: `${fakeBin}:${process.env.PATH}` };
	for (let iteration = 0; iteration < 2; iteration += 1) {
		const result = spawnSync(install, ["--no-service"], { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /installed ish/);
	}
	for (const binary of ["ish", "intentd", "ishctl"]) {
		const target = path.join(prefix, "bin", binary);
		assert.equal(await exists(target), true, target);
		assert.match(await readlink(target), /lib\/ish/);
	}
	let result = spawnSync(path.join(prefix, "bin", "ish"), ["--version"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "ish 0.1.0");
	for (let iteration = 0; iteration < 2; iteration += 1) {
		result = spawnSync(uninstall, [], { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
	}
	assert.equal(await exists(path.join(prefix, "lib", "ish")), false);
	assert.equal(await exists(path.join(prefix, "bin", "ish")), false);
});
