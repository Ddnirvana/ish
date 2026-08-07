import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));

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
	const checkout = path.join(root, "source");
	await cp(sourceRoot, checkout, {
		recursive: true,
		filter: (source) => ![".git", "node_modules"].includes(path.basename(source)),
	});
	const install = path.join(checkout, "scripts", "install.sh");
	const uninstall = path.join(checkout, "scripts", "uninstall.sh");
	const prefix = path.join(root, "prefix");
	const fakeBin = path.join(root, "bin");
	await mkdir(fakeBin);
	const fakeNpm = path.join(fakeBin, "npm");
	const oldNode = path.join(fakeBin, "node");
	await writeFile(oldNode, "#!/bin/sh\n[ \"$1\" = --version ] && echo v12.22.9 || echo 0\n");
	await chmod(oldNode, 0o755);
	await writeFile(
		fakeNpm,
		`#!/bin/sh
if [ "$1" = ci ]; then
  target="$PWD/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"
  mkdir -p "$target"
  printf '%s\n' '{"version":"5.0.7"}' > "$target/package.json"
  case "$PWD" in
    *.stage.*)
      mkdir -p "$PWD/node_modules/@earendil-works/pi-coding-agent" "$PWD/node_modules/.bin"
      printf '%s\n' '{"version":"0.84.1"}' > "$PWD/node_modules/@earendil-works/pi-coding-agent/package.json"
      printf '%s\n' '#!/bin/sh' 'test "$(node --version)" != v12.22.9' 'echo pi 0.84.1' > "$PWD/node_modules/.bin/pi"
      chmod 755 "$PWD/node_modules/.bin/pi"
      ;;
  esac
fi
exit 0
`,
	);
	await chmod(fakeNpm, 0o755);
	const fakeZsh = path.join(fakeBin, "zsh-for-ish");
	const fakeBrew = path.join(fakeBin, "brew");
	await writeFile(
		fakeBrew,
		`#!/bin/sh
test "$1" = install && test "$2" = zsh
printf '%s\n' '#!/bin/sh' 'echo zsh 5.9' > "${fakeZsh}"
chmod 755 "${fakeZsh}"
`,
	);
	await chmod(fakeBrew, 0o755);
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
		ISH_INSTALL_PLATFORM: "Darwin",
		ISH_NODE: process.execPath,
		ISH_ZSH: fakeZsh,
		ISH_NPM: fakeNpm,
		ISH_BREW: fakeBrew,
		ISH_LAUNCHCTL: launchctl,
		ISH_SERVICE_UID: "501",
		ISH_LAUNCH_AGENT_DIR: agentDir,
		ISH_SERVICE_LOG_DIR: path.join(root, "logs"),
		PATH: `${fakeBin}:${process.env.PATH}`,
	};
	let result = spawnSync(install, ["--no-service"], { encoding: "utf8", env });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--install-deps/);
	result = spawnSync(install, ["--install-deps", "--no-service"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /installing zsh with Homebrew/);
	assert.match(result.stdout, /bundled Pi 0\.84\.1/);
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
	assert.equal(await exists(path.join(prefix, "lib", "ish", "docs", "getting-started.md")), true);
	assert.equal(await exists(path.join(prefix, "lib", "ish", "scripts", "macos-pty.exp")), true);
	const installedNode = await readlink(path.join(prefix, "lib", "ish", "runtime", "node"));
	assert.equal(path.isAbsolute(installedNode), true);
	assert.equal(await exists(installedNode), true);
	const hardened = JSON.parse(
		await readFile(path.join(prefix, "lib", "ish", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "brace-expansion", "package.json"), "utf8"),
	) as { version: string };
	assert.equal(hardened.version, "5.0.9");
	result = spawnSync(path.join(prefix, "bin", "ish"), ["--version"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "ish 0.1.0");
	result = spawnSync(path.join(prefix, "bin", "ish"), ["doctor"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /\[ok\] node:/);
	assert.match(result.stdout, /\[ok\] pi:/);
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

test("installer finds a compatible user toolchain Node behind an old system Node", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-node-resolution-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const checkout = path.join(root, "source");
	await cp(sourceRoot, checkout, {
		recursive: true,
		filter: (source) => ![".git", "node_modules"].includes(path.basename(source)),
	});
	const install = path.join(checkout, "scripts", "install.sh");
	const fakeBin = path.join(root, "bin");
	await mkdir(fakeBin);
	const oldNode = path.join(fakeBin, "node");
	await writeFile(
		oldNode,
		`#!/bin/sh
if [ "$1" = --version ]; then echo v12.22.9; else echo 0; fi
`,
	);
	await chmod(oldNode, 0o755);
	const fakeZsh = path.join(fakeBin, "zsh");
	await writeFile(fakeZsh, "#!/bin/sh\necho zsh 5.9\n");
	await chmod(fakeZsh, 0o755);
	const npmLog = path.join(root, "npm.log");
	const compatibleBin = path.join(root, "existing-project", "toolchain", "node-v22.19.0-linux-x64", "bin");
	const compatibleNode = path.join(compatibleBin, "node");
	const compatibleNpm = path.join(compatibleBin, "npm");
	const env = {
		...process.env,
		HOME: root,
		ISH_INSTALL_PLATFORM: "Linux",
		ISH_ZSH: fakeZsh,
		PATH: `${fakeBin}:/usr/bin:/bin`,
	};

	let result = spawnSync(install, ["--no-service"], { encoding: "utf8", env });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /v12\.22\.9/);
	assert.match(result.stderr, /Nothing was installed/);
	assert.match(result.stderr, /ISH_NODE=\/absolute\/path\/to\/node/);

	await mkdir(compatibleBin, { recursive: true });
	await symlink(process.execPath, compatibleNode);
	await writeFile(
		compatibleNpm,
		`#!/bin/sh
if [ "$1" = --version ]; then echo 10.9.3; exit 0; fi
printf '%s\n' "$*" >> "${npmLog}"
exit 73
`,
	);
	await chmod(compatibleNpm, 0o755);
	result = spawnSync(install, ["--no-service"], { encoding: "utf8", env });
	assert.equal(result.status, 73);
	assert.match(result.stdout, new RegExp(`using Node .* from ${compatibleNode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(await readFile(npmLog, "utf8"), /^ci --ignore-scripts --no-audit/m);
});
