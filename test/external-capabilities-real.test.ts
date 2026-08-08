import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

async function loadSession(root: string, extensionPaths: string[]) {
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: path.join(root, "agent"),
		settingsManager,
		additionalExtensionPaths: extensionPaths,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: path.join(root, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(root),
		noTools: "builtin",
	});
	await session.bindExtensions({ mode: "print" });
	return session;
}

test("enabled web pack registers only the three ish-approved tools", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-web-pack-"));
	const config = path.join(root, "capabilities.json");
	await writeFile(config, `${JSON.stringify({ version: 1, web: { enabled: true, provider: "brave" }, mcp: { servers: {} } })}\n`);
	const previous = process.env.ISH_CAPABILITIES;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.ISH_CAPABILITIES = config;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	t.after(async () => {
		if (previous === undefined) delete process.env.ISH_CAPABILITIES; else process.env.ISH_CAPABILITIES = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	const session = await loadSession(root, [fileURLToPath(new URL("../src/web-capability-extension.js", import.meta.url))]);
	t.after(() => session.dispose());
	const names = session.getAllTools().map((tool) => tool.name);
	assert.ok(names.includes("web_search"));
	assert.ok(names.includes("source_check"));
	assert.ok(names.includes("fetch_content"));
	assert.ok(!names.includes("get_search_content"));
	const fetchInfo = session.getAllTools().find((tool) => tool.name === "fetch_content");
	assert.ok(fetchInfo);
	assert.doesNotMatch(JSON.stringify(fetchInfo.parameters), /forceClone|timestamp|answerModel|frames/);
	assert.match(fetchInfo.description, /Repository, video, and local handlers are rejected/);
	const fetchTool = session.getToolDefinition("fetch_content");
	assert.ok(fetchTool);
	await assert.rejects(
		() => fetchTool.execute("web-1", { url: "file:///etc/passwd" } as never, undefined, undefined, { cwd: root } as never),
		/rejects URL scheme/,
	);
	await assert.rejects(
		() => fetchTool.execute("web-2", { url: "https://github.com/example/repository" } as never, undefined, undefined, { cwd: root } as never),
		/rejects repository and video handlers/,
	);
});

test("MCP pack starts with zero servers and no active tool", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-mcp-empty-"));
	const config = path.join(root, "capabilities.json");
	await writeFile(config, `${JSON.stringify({ version: 1, mcp: { servers: {} } })}\n`);
	const previous = process.env.ISH_CAPABILITIES;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.ISH_CAPABILITIES = config;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	t.after(async () => {
		if (previous === undefined) delete process.env.ISH_CAPABILITIES; else process.env.ISH_CAPABILITIES = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	const session = await loadSession(root, [fileURLToPath(new URL("../src/mcp-capability-extension.js", import.meta.url))]);
	t.after(() => session.dispose());
	assert.deepEqual(session.getActiveToolNames(), []);
	assert.ok(session.getAllTools().some((tool) => tool.name === "mcp"));
});

test("effectful MCP calls fail closed headlessly and excluded tools stay hidden", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-mcp-policy-"));
	const config = path.join(root, "capabilities.json");
	const marker = path.join(root, "effect-ran");
	const server = fileURLToPath(new URL("./fixtures/mcp-server.js", import.meta.url));
	await writeFile(config, `${JSON.stringify({
		version: 1,
		mcp: { servers: {
			ops: {
				command: process.execPath,
				args: [server, marker],
				version: "1.0.0",
				tools: ["status", "delete"],
				authority: "effectful",
				approval: "always",
			},
			reader: {
				command: process.execPath,
				args: [server],
				version: "1.0.0",
				tools: ["huge"],
				authority: "observation",
				approval: "none",
			},
		} },
	})}\n`);
	const previous = process.env.ISH_CAPABILITIES;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.ISH_CAPABILITIES = config;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	t.after(async () => {
		if (previous === undefined) delete process.env.ISH_CAPABILITIES; else process.env.ISH_CAPABILITIES = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	const session = await loadSession(root, [fileURLToPath(new URL("../src/mcp-capability-extension.js", import.meta.url))]);
	t.after(() => session.dispose());
	const mcp = session.getToolDefinition("mcp");
	assert.ok(mcp);
	const ctx = { cwd: root, hasUI: false, ui: {} } as never;
	const connected = await mcp.execute("mcp-connect", { connect: "ops" } as never, undefined, undefined, ctx) as { content: Array<{ text?: string }> };
	assert.match(connected.content.map((part) => part.text ?? "").join("\n"), /ops/i);
	const hidden = await mcp.execute("mcp-hidden", { tool: "ops_hidden", args: {} } as never, undefined, undefined, ctx) as { content: Array<{ text?: string }> };
	assert.match(hidden.content.map((part) => part.text ?? "").join("\n"), /not found/i);
	const denied = await mcp.execute("mcp-delete", { tool: "ops_delete", args: {} } as never, undefined, undefined, ctx) as { content: Array<{ text?: string }> };
	assert.match(denied.content.map((part) => part.text ?? "").join("\n"), /approval|required|denied/i);
	assert.equal(existsSync(marker), false);
	await mcp.execute("mcp-reader-connect", { connect: "reader" } as never, undefined, undefined, ctx);
	const bounded = await mcp.execute("mcp-huge", { tool: "reader_huge", args: {} } as never, undefined, undefined, ctx);
	const serialized = JSON.stringify(bounded);
	assert.ok(Buffer.byteLength(serialized) < 40_000, `guarded MCP result was ${Buffer.byteLength(serialized)} bytes`);
	assert.match(serialized, /truncat|spill|output/i);
});
