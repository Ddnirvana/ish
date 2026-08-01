import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SystemTmuxExecutor, TmuxTopology } from "../src/tmux.js";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("broadcast executes in isolated real tmux shell panes", { skip: !hasTmux }, async (t) => {
	const socket = `ish-test-${process.pid}-${Date.now()}`;
	const executor = new SystemTmuxExecutor(socket);
	t.after(async () => {
		try {
			await executor.run(["kill-server"]);
		} catch {
			// The isolated server may already have exited with its last pane.
		}
		const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
		await rm(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${uid}`, socket), { force: true });
	});

	await executor.run(["-f", "/dev/null", "new-session", "-d", "-s", "prod", "zsh", "-dfi"]);
	await executor.run(["split-window", "-d", "-t", "prod:0", "zsh", "-dfi"]);
	const topology = new TmuxTopology(executor);
	let panes = await topology.discover();
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && panes.filter((pane) => pane.session === "prod" && pane.command === "zsh").length !== 2) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		panes = await topology.discover();
	}
	assert.equal(
		panes.filter((pane) => pane.session === "prod" && pane.command === "zsh").length,
		2,
		`expected two persistent zsh panes: ${JSON.stringify(panes)}`,
	);
	const plan = topology.planBroadcast(panes, "session:prod", "printf 'ISH_REAL_TMUX_OK\\n'");
	assert.equal(plan.targets.length, 2);
	await topology.executeBroadcast(plan);
	await new Promise((resolve) => setTimeout(resolve, 100));

	for (const pane of plan.targets) {
		const { stdout } = await executor.run(["capture-pane", "-p", "-t", pane.id, "-S", "-20"]);
		assert.match(stdout, /ISH_REAL_TMUX_OK/);
	}
});
