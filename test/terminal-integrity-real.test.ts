import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const ish = path.join(sourceRoot, "bin", "ish");
const hasMacTools = process.platform === "darwin" && ["tmux", "expect", "vim"].every((tool) =>
	spawnSync("sh", ["-c", `command -v ${tool} >/dev/null 2>&1`], { stdio: "ignore" }).status === 0
);
const hasMacTmux = process.platform === "darwin" &&
	spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPrompt(
	tmux: (args: string[]) => { stdout: string },
	target: string,
	pattern: RegExp = /ish /,
	deadlineMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + deadlineMs;
	let pane = "";
	while (Date.now() < deadline) {
		pane = tmux(["capture-pane", "-p", "-t", target, "-S", "-20"]).stdout;
		if (pattern.test(pane)) return pane;
		await sleep(25);
	}
	assert.match(pane, pattern);
	return pane;
}

async function waitForPane(tmux: (args: string[]) => { stdout: string }, pattern: RegExp): Promise<string> {
	const deadline = Date.now() + 8000;
	let pane = "";
	while (Date.now() < deadline) {
		pane = tmux(["capture-pane", "-p", "-t", "integrity:0.0"]).stdout;
		if (pattern.test(pane)) return pane;
		await sleep(25);
	}
	assert.match(pane, pattern);
	return pane;
}

async function waitForPaneText(
	tmux: (args: string[]) => { stdout: string },
	target: string,
	pattern: RegExp,
	deadlineMs: number,
): Promise<string> {
	const deadline = Date.now() + deadlineMs;
	let pane = "";
	while (Date.now() < deadline) {
		pane = tmux(["capture-pane", "-p", "-t", target]).stdout;
		if (pattern.test(pane)) return pane;
		await sleep(25);
	}
	return pane;
}

async function waitForVimGeometry(
	tmux: (args: string[]) => { stdout: string },
	file: string,
	expected: string,
): Promise<void> {
	const deadline = Date.now() + 8000;
	let value = "";
	while (Date.now() < deadline) {
		tmux(["send-keys", "-t", "integrity:0.0", `:call writefile([printf('%d:%d', &lines, &columns)], '${file}')`, "Enter"]);
		await sleep(50);
		try {
			value = (await readFile(file, "utf8")).trim();
		} catch {
			// Vim has not completed the write yet.
		}
		if (value === expected) return;
	}
	assert.equal(value, expected);
}

async function waitForFileValue(file: string, expected: string): Promise<void> {
	const deadline = Date.now() + 8000;
	let value = "";
	while (Date.now() < deadline) {
		try {
			value = (await readFile(file, "utf8")).trim();
		} catch {
			// The producer has not written the observation yet.
		}
		if (value === expected) return;
		await sleep(25);
	}
	assert.equal(value, expected);
}

async function waitForShellGeometry(
	tmux: (args: string[]) => { stdout: string },
	target: string,
	columns: number,
	lines: number,
	file: string,
	expected: string,
): Promise<void> {
	const deadline = Date.now() + 8000;
	let value = "";
	while (Date.now() < deadline) {
		tmux(["resize-window", "-t", target, "-x", String(columns), "-y", String(lines)]);
		tmux([
			"send-keys", "-t", target,
			`print -r -- "$(stty size):$LINES:$COLUMNS" > ${file}`,
			"Enter",
		]);
		await sleep(100);
		try {
			value = (await readFile(file, "utf8")).trim();
		} catch {
			// The shell has not completed the probe yet.
		}
		if (value === expected) return;
		// The PTY bridge can coalesce WINCH events while it is busy, so a
		// same-size retry would never be delivered. Resize to a different
		// size and give the bridge time to apply it so the next target resize
		// is a real change.
		tmux([
			"resize-window", "-t", target,
			"-x", String(Math.max(10, columns - 2)),
			"-y", String(Math.max(5, lines - 2)),
		]);
		await sleep(1000);
	}
	assert.equal(value, expected);
}

async function waitForPtyBridge(
	root: string,
	deadlineMs = 10_000,
): Promise<string> {
	// The macOS Expect bridge writes the child PTY path only after it has
	// applied the initial geometry and entered its interact loop. Resizes
	// before that handoff can be lost, so wait for the slave path first.
	const transcriptBase = path.join(root, "runtime", "transcripts");
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const [transcriptDir] = await readdir(transcriptBase);
			const slave = (await readFile(path.join(transcriptBase, transcriptDir, "macos-pty-slave"), "utf8")).trim();
			if (slave) return slave;
		} catch {
			// The bridge has not completed its handoff yet.
		}
		await sleep(25);
	}
	assert.fail(`macOS PTY bridge did not become ready within ${deadlineMs}ms`);
}

function assertRawTerminal(tty: string): void {
	const fd = openSync(tty, "r+");
	try {
		const result = spawnSync("stty", ["-a"], { encoding: "utf8", stdio: [fd, "pipe", "pipe"] });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /(?:^|\s)-icanon(?:\s|$)/);
		assert.match(result.stdout, /(?:^|\s)-echo(?:\s|$)/);
	} finally {
		closeSync(fd);
	}
}

async function stopSession(
	tmux: (args: string[]) => { stdout: string; status: number | null },
	target: string,
): Promise<void> {
	const pane = tmux(["capture-pane", "-p", "-t", target]).stdout;
	if (/ISH_VIM_SCREEN_SENTINEL/.test(pane)) {
		tmux(["send-keys", "-t", target, "Escape", ":qa!", "Enter"]);
		await sleep(100);
	}
	tmux(["send-keys", "-t", target, "exit", "Enter"]);
	await sleep(100);
	tmux(["send-keys", "-t", target, "exit", "Enter"]);
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline && tmux(["has-session"]).status === 0) await sleep(25);
	tmux(["kill-server"]);
}

test("macOS PTY tracks resizes and preserves repeated Vim screens", { skip: !hasMacTools }, async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-terminal-integrity-"));
	const home = path.join(root, "home");
	const fixture = path.join(root, "fixture.txt");
	const geometry = path.join(root, "geometry.txt");
	const shellGeometry = path.join(root, "shell-geometry.txt");
	const movement = path.join(root, "movement.txt");
	const original = "ISH_VIM_SCREEN_SENTINEL\nsecond line\n";
	const socket = `ish-terminal-${process.pid}-${Date.now()}`;
	const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	await mkdir(home);
	await writeFile(fixture, original);
	t.after(async () => {
		await stopSession(tmux, "integrity:0.0");
		await rm(root, { recursive: true, force: true });
	});

	let result = tmux([
		"-f", "/dev/null", "new-session", "-d", "-x", "80", "-y", "24", "-s", "integrity", "env",
		`HOME=${home}`, `ISH_RUNTIME_DIR=${path.join(root, "runtime")}`, "ISH_DISABLE_CAPSULES=1",
		"NO_COLOR=1", "ISH_ASCII=1", ish,
	]);
	assert.equal(result.status, 0, result.stderr);
	await waitForPrompt(tmux, "integrity:0.0");
	await waitForPtyBridge(root);
	// Give the bridge one full WINCH-processing cycle before the first
	// resize so the initial target size is not coalesced away.
	await sleep(1000);

	await waitForShellGeometry(tmux, "integrity:0.0", 121, 37, shellGeometry, "37 121:37:121");

	for (let iteration = 0; iteration < 12; iteration += 1) {
		const columns = iteration % 2 === 0 ? 100 : 121;
		const lines = iteration % 2 === 0 ? 30 : 37;
		const vimCommand = `vim -Nu NONE -n -c "autocmd CursorMoved * call writefile([string(line('.'))], '${movement}')" ${fixture}`;
		tmux(["send-keys", "-t", "integrity:0.0", vimCommand, "Enter"]);
		let pane = await waitForPaneText(tmux, "integrity:0.0", /ISH_VIM_SCREEN_SENTINEL/, 8000);
		if (!/ISH_VIM_SCREEN_SENTINEL/.test(pane)) {
			// A loaded runner can swallow the first keystrokes while the PTY
			// bridge settles; retry the exact same command once before failing.
			tmux(["send-keys", "-t", "integrity:0.0", "Escape"]);
			await sleep(100);
			tmux(["send-keys", "-t", "integrity:0.0", vimCommand, "Enter"]);
			pane = await waitForPaneText(tmux, "integrity:0.0", /ISH_VIM_SCREEN_SENTINEL/, 8000);
		}
		assert.match(pane, /ISH_VIM_SCREEN_SENTINEL/);
		tmux(["resize-window", "-t", "integrity:0", "-x", String(columns), "-y", String(lines)]);
		assert.equal(
			tmux(["display-message", "-p", "-t", "integrity:0.0", "#{pane_width}:#{pane_height}"]).stdout.trim(),
			`${columns}:${lines}`,
		);
		await sleep(100);
		const paneTty = tmux(["display-message", "-p", "-t", "integrity:0.0", "#{pane_tty}"]).stdout.trim();
		const transcriptBase = path.join(root, "runtime", "transcripts");
		const [transcriptDir] = await readdir(transcriptBase);
		const childTty = (await readFile(path.join(transcriptBase, transcriptDir, "macos-pty-slave"), "utf8")).trim();
		assertRawTerminal(paneTty);
		assertRawTerminal(childTty);
		await rm(movement, { force: true });
		tmux(["send-keys", "-t", "integrity:0.0", "j"]);
		await waitForFileValue(movement, "2");
		tmux(["send-keys", "-t", "integrity:0.0", "k"]);
		await waitForFileValue(movement, "1");
		await rm(geometry, { force: true });
		await waitForVimGeometry(tmux, geometry, `${lines}:${columns}`);
		const vimPane = tmux(["capture-pane", "-p", "-t", "integrity:0.0"]).stdout;
		assert.match(vimPane, /ISH_VIM_SCREEN_SENTINEL/);
		tmux(["send-keys", "-t", "integrity:0.0", ":qa!", "Enter"]);
		await waitForPane(tmux, /ish .* > /);
		assert.equal(await readFile(fixture, "utf8"), original);
	}

	tmux(["send-keys", "-t", "integrity:0.0", "stty sane; print -r -- ISH_VIM_RETURNED", "Enter"]);
	await sleep(100);
	result = tmux(["capture-pane", "-p", "-t", "integrity:0.0", "-S", "-20"]);
	assert.match(result.stdout, /ISH_VIM_RETURNED/);
	assert.doesNotMatch(result.stdout, /\^\[\[|\[\?1049[hl]/);
	await stopSession(tmux, "integrity:0.0");
});

test("macOS without Expect preserves a direct resizable zsh terminal", { skip: !hasMacTmux }, async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-terminal-fallback-"));
	const home = path.join(root, "home");
	const socket = `ish-terminal-fallback-${process.pid}-${Date.now()}`;
	const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	await mkdir(home);
	t.after(async () => {
		await stopSession(tmux, "fallback:0.0");
		await rm(root, { recursive: true, force: true });
	});

	let result = tmux([
		"-f", "/dev/null", "new-session", "-d", "-x", "80", "-y", "24", "-s", "fallback", "env",
		`HOME=${home}`, `ISH_RUNTIME_DIR=${path.join(root, "runtime")}`, "ISH_DISABLE_CAPSULES=1",
		"ISH_EXPECT=/definitely/missing/expect", "NO_COLOR=1", "ISH_ASCII=1", ish,
	]);
	assert.equal(result.status, 0, result.stderr);
	await waitForPrompt(tmux, "fallback:0.0");
	tmux(["resize-window", "-t", "fallback:0", "-x", "111", "-y", "35"]);
	tmux(["send-keys", "-t", "fallback:0.0", "stty size; print -r -- STATUS:$ISH_TRANSCRIPT_STATUS:$LINES:$COLUMNS", "Enter"]);
	const expectedStatus = /STATUS:unavailable-macos-expect:35:111/;
	const statusPane = await waitForPrompt(tmux, "fallback:0.0", expectedStatus, 5_000);
	assert.match(statusPane, /35 111/);
	assert.match(statusPane, expectedStatus);
	await stopSession(tmux, "fallback:0.0");
});
