import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
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
	await writeFile(
		fakeNpm,
		`#!/bin/sh
case "$PWD" in
  *.stage.*)
    target="$PWD/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"
    mkdir -p "$target"
    printf '%s\n' '{"version":"5.0.7"}' > "$target/package.json"
    ;;
esac
exit 0
`,
	);
	await chmod(fakeNpm, 0o755);
	const launchctl = path.join(fakeBin, "launchctl");
	const launchdState = path.join(root, "launchd-loaded");
	await writeFile(
		launchctl,
		`#!/bin/sh
case "$1" in
  print) test -f "${launchdState}" ;;
  bootstrap) touch "${launchdState}" ;;
  bootout) rm -f "${launchdState}" ;;
esac
`,
	);
	await chmod(launchctl, 0o755);
	const agentDir = path.join(root, "LaunchAgents");
	const env = {
		...process.env,
		ISH_PREFIX: prefix,
		ISH_SERVICE_PLATFORM: "Darwin",
		ISH_LAUNCHCTL: launchctl,
		ISH_SERVICE_UID: "501",
		ISH_LAUNCH_AGENT_DIR: agentDir,
		ISH_SERVICE_LOG_DIR: path.join(root, "logs"),
		PATH: `${fakeBin}:${process.env.PATH}`,
	};
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
	assert.equal(
		await exists(path.join(prefix, "lib", "ish", "dist", "extensions", "system-inspect", "index.js")),
		true,
		"installed prefix must include the compiled system_inspect extension",
	);
	const hardened = JSON.parse(
		await readFile(path.join(prefix, "lib", "ish", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "brace-expansion", "package.json"), "utf8"),
	) as { version: string };
	assert.equal(hardened.version, "5.0.9");
	let result = spawnSync(path.join(prefix, "bin", "ish"), ["--version"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "ish 0.1.0");
	result = spawnSync(install, [], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /ish intent service installed and started/);
	assert.equal(await exists(path.join(agentDir, "com.ish.intentd.plist")), true);
	for (let iteration = 0; iteration < 2; iteration += 1) {
		result = spawnSync(uninstall, [], { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
	}
	assert.equal(await exists(path.join(prefix, "lib", "ish")), false);
	assert.equal(await exists(path.join(prefix, "bin", "ish")), false);
	assert.equal(await exists(path.join(agentDir, "com.ish.intentd.plist")), false);
});
