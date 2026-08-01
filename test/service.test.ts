import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), ISH_SYSTEMCTL: systemctl, DEEPSEEK_API_KEY: "must-not-be-written" };
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
