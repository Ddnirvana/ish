import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextJournal } from "../src/context.js";

test("context journal composes global, directory, session, and pane scopes without leakage", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-context-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const journal = new ContextJournal(root);
	await journal.initialize();

	await journal.append({
		kind: "topology-note",
		scope: { host: "server-a" },
		content: "global host fact",
		provenance: "intentd",
	});
	await journal.append({
		kind: "native-command",
		scope: { host: "server-a", session: "prod", window: "api", pane: "%1", cwd: "/srv/api" },
		content: "systemctl status api",
		provenance: "zsh-history",
	});
	await journal.append({
		kind: "native-command",
		scope: { host: "server-a", session: "dev", pane: "%9", cwd: "/home/dev" },
		content: "npm test",
		provenance: "zsh-history",
	});
	await journal.append({
		kind: "agent-request",
		scope: { host: "server-a", session: "prod", pane: "%1" },
		content: "credential material",
		sensitivity: "secret",
		provenance: "ish-agent",
	});

	const visible = journal.query({
		scope: { host: "server-a", session: "prod", window: "api", pane: "%1", cwd: "/srv/api/logs" },
	});
	assert.deepEqual(visible.map((event) => event.content), ["systemctl status api", "global host fact"]);
	assert.equal(journal.query({ scope: { host: "server-b", session: "prod", pane: "%1" } }).length, 0);

	const privileged = journal.query({
		scope: { host: "server-a", session: "prod", window: "api", pane: "%1", cwd: "/srv/api" },
		includeSecrets: true,
	});
	assert.ok(privileged.some((event) => event.sensitivity === "secret"));
});

test("context journal persists events across daemon-style restart", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-context-restart-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = new ContextJournal(root);
	await first.initialize();
	await first.append({
		kind: "agent-response",
		scope: { host: "server-a", session: "prod" },
		content: "diagnosis result",
		provenance: "pi",
	});

	const second = new ContextJournal(root);
	await second.initialize();
	assert.equal(second.query({ scope: { host: "server-a", session: "prod" } })[0]?.content, "diagnosis result");
});
