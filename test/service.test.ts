import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const service = fileURLToPath(new URL("../../scripts/service.sh", import.meta.url));

test("systemd user service lifecycle is idempotent and stores no credential", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-service-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const systemctl = path.join(root, "systemctl");
	const log = path.join(root, "systemctl.log");
	await writeFile(systemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
	await chmod(systemctl, 0o755);
	const env = {
		...process.env,
		HOME: root,
		XDG_CONFIG_HOME: path.join(root, "config"),
		ISH_SERVICE_PLATFORM: "Linux",
		ISH_SYSTEMCTL: systemctl,
		DEEPSEEK_API_KEY: "must-not-be-written",
	};
	for (const action of ["install", "install", "restart", "stop"]) {
		const result = spawnSync(service, [action], { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
	}
	const unit = path.join(root, "config", "systemd", "user", "ish-intentd.service");
	const contents = await readFile(unit, "utf8");
	assert.match(contents, /Restart=on-failure/);
	assert.match(contents, /bin\/intentd/);
	assert.doesNotMatch(contents, /must-not-be-written|API_KEY/);
	let result = spawnSync(service, ["uninstall"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	result = spawnSync(service, ["uninstall"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.match(await readFile(log, "utf8"), /--user enable --now ish-intentd\.service/);
});

test("launchd user service lifecycle is idempotent and stores no credential", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-launchd-service-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const launchctl = path.join(root, "launchctl");
	const log = path.join(root, "launchctl.log");
	const loaded = path.join(root, "loaded");
	await writeFile(
		launchctl,
		`#!/bin/sh
printf '%s\n' "$*" >> "${log}"
case "$1" in
  print) test -f "${loaded}" ;;
  bootstrap) touch "${loaded}" ;;
  bootout) rm -f "${loaded}" ;;
esac
`,
	);
	await chmod(launchctl, 0o755);
	const agentDir = path.join(root, "LaunchAgents");
	const logDir = path.join(root, "logs");
	const env = {
		...process.env,
		HOME: root,
		ISH_SERVICE_PLATFORM: "Darwin",
		ISH_LAUNCHCTL: launchctl,
		ISH_SERVICE_UID: "501",
		ISH_LAUNCH_AGENT_DIR: agentDir,
		ISH_SERVICE_LOG_DIR: logDir,
		DEEPSEEK_API_KEY: "must-not-be-written",
	};
	for (const action of ["install", "install", "restart", "stop", "start", "status"]) {
		const result = spawnSync(service, [action], { encoding: "utf8", env });
		assert.equal(result.status, 0, `${action}: ${result.stderr}`);
	}
	const plist = path.join(agentDir, "com.ish.intentd.plist");
	const contents = await readFile(plist, "utf8");
	assert.match(contents, /<string>com\.ish\.intentd<\/string>/);
	assert.match(contents, /<key>ProgramArguments<\/key>/);
	assert.match(contents, /bin\/intentd<\/string>/);
	assert.match(contents, /<key>RunAtLoad<\/key>/);
	assert.match(contents, /<key>KeepAlive<\/key>/);
	assert.match(contents, /<key>EnvironmentVariables<\/key>/);
	assert.match(contents, /<key>PATH<\/key>/);
	assert.match(contents, /intentd\.error\.log/);
	assert.doesNotMatch(contents, /must-not-be-written|API_KEY/);
	if (process.platform === "darwin") {
		const lint = spawnSync("plutil", ["-lint", plist], { encoding: "utf8" });
		assert.equal(lint.status, 0, lint.stderr);
	}
	for (let iteration = 0; iteration < 2; iteration += 1) {
		const result = spawnSync(service, ["uninstall"], { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
	}
	await assert.rejects(access(plist));
	const calls = await readFile(log, "utf8");
	assert.match(calls, /bootstrap gui\/501 .*com\.ish\.intentd\.plist/);
	assert.match(calls, /kickstart -k gui\/501\/com\.ish\.intentd/);
	assert.match(calls, /bootout gui\/501\/com\.ish\.intentd/);
});
