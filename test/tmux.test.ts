import assert from "node:assert/strict";
import test from "node:test";
import { TmuxTopology, type TmuxExecutor } from "../src/tmux.js";

class FakeTmux implements TmuxExecutor {
	readonly calls: string[][] = [];

	async run(args: string[]): Promise<{ stdout: string }> {
		this.calls.push(args);
		if (args[0] !== "list-panes") return { stdout: "" };
		return {
			stdout: [
				"%1\tprod\t@1\t0\tapi\tzsh\t/srv/api\t0",
				"%2\tprod\t@2\t1\tlogs\tless\t/srv/api\t0",
				"%3\tdev\t@3\t0\tbuild\tbash\t/home/dev\t0",
				"%4\tprod\t@1\t0\tapi\tzsh\t/srv/api\t1",
			].join("\n"),
		};
	}
}

test("tmux topology discovers system-level session, window, and pane state", async () => {
	const fake = new FakeTmux();
	const topology = new TmuxTopology(fake);
	const panes = await topology.discover();
	assert.equal(panes.length, 4);
	assert.deepEqual(panes[0], {
		id: "%1",
		session: "prod",
		windowId: "@1",
		windowIndex: "0",
		windowName: "api",
		command: "zsh",
		path: "/srv/api",
		inMode: false,
	});
	assert.match(fake.calls[0][3], /\|:ish:\|/);
});

test("broadcast planning selects only idle shells and excludes busy panes", async () => {
	const fake = new FakeTmux();
	const topology = new TmuxTopology(fake);
	const plan = topology.planBroadcast(await topology.discover(), "session:prod", "uptime && echo '$HOME'");
	assert.deepEqual(plan.targets.map((pane) => pane.id), ["%1"]);
	assert.deepEqual(plan.excluded.map(({ pane }) => pane.id), ["%2", "%4"]);

	await topology.executeBroadcast(plan);
	assert.deepEqual(fake.calls.slice(1), [
		["send-keys", "-t", "%1", "-l", "--", "uptime && echo '$HOME'"],
		["send-keys", "-t", "%1", "Enter"],
	]);
});

test("broadcast refuses selectors with no safe shell target", async () => {
	const topology = new TmuxTopology(new FakeTmux());
	const panes = await topology.discover();
	assert.throws(() => topology.planBroadcast(panes, "pane:%2", "uptime"), /none are safe shell targets/);
});
