import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const ctl = path.join(sourceRoot, "dist", "src", "ctl-cli.js");
const fakePi = path.join(sourceRoot, "dist", "test", "fixtures", "fake-pi.js");

async function waitForActivityFrame(
	tmux: (args: string[]) => { stdout: string },
	previous = "",
): Promise<string> {
	const deadline = Date.now() + 3000;
	let pane = "";
	while (Date.now() < deadline) {
		pane = tmux(["capture-pane", "-p", "-t", "activity:0.0", "-S", "-20"]).stdout;
		if (/Pi is working/.test(pane) && pane !== previous) return pane;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.match(pane, /Pi is working/);
	assert.notEqual(pane, previous, "activity frame should change while Pi is running");
	return pane;
}

test("animated agent activity changes and interruption returns to zsh", async (t) => {
	if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return t.skip("tmux is unavailable");
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-activity-real-"));
	const socket = `ish-activity-${process.pid}-${Date.now()}`;
	const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	await chmod(fakePi, 0o755);
	t.after(async () => {
		tmux(["kill-server"]);
		await rm(root, { recursive: true, force: true });
	});
	let result = tmux(["-f", "/dev/null", "new-session", "-d", "-s", "activity", "zsh", "-f"]);
	assert.equal(result.status, 0, result.stderr);
	const command = `ISH_TUI=1 ISH_PI=${JSON.stringify(fakePi)} ISH_FAKE_PI_DELAY_MS=5000 ${JSON.stringify(process.execPath)} ${JSON.stringify(ctl)} ask -- LONG`;
	tmux(["send-keys", "-t", "activity:0.0", command, "Enter"]);
	const first = await waitForActivityFrame(tmux);
	await waitForActivityFrame(tmux, first);
	tmux(["send-keys", "-t", "activity:0.0", "C-c"]);
	const deadline = Date.now() + 3000;
	let current = "";
	while (Date.now() < deadline && current !== "zsh") {
		current = tmux(["display-message", "-p", "-t", "activity:0.0", "#{pane_current_command}"]).stdout.trim();
		if (current !== "zsh") await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(current, "zsh");
});
