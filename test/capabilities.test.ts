import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	configureWeb,
	MCP_PACKAGE,
	readCapabilityConfig,
	removeMcpServer,
	toMcpAdapterConfig,
	upsertMcpServer,
	WEB_PACKAGE,
} from "../src/capabilities.js";
import { capWebResult } from "../src/web-capability-extension.js";

const cli = fileURLToPath(new URL("../src/ctl-cli.js", import.meta.url));

test("capability configuration is private, atomic, pinned, and fail-closed", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-capability-config-"));
	const file = path.join(root, "config", "capabilities.json");
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.equal(WEB_PACKAGE.version, "0.18.0");
	assert.equal(MCP_PACKAGE.version, "2.21.0");
	assert.deepEqual(await readCapabilityConfig(file), { version: 1, mcp: { servers: {} } });
	await configureWeb("brave", true, file);
	await upsertMcpServer("docs", {
		command: "npx",
		args: ["-y", "@example/docs-mcp@1.2.3"],
		version: "1.2.3",
		tools: ["search", "fetch"],
		authority: "observation",
		approval: "none",
	}, file);
	const config = await readCapabilityConfig(file);
	assert.equal(config.web?.enabled, true);
	assert.deepEqual(config.mcp.servers.docs.tools, ["search", "fetch"]);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.match(await readFile(file, "utf8"), /"version": "1\.2\.3"/);
	await assert.rejects(() => upsertMcpServer("unsafe", {
		command: "tool",
		args: [],
		version: "1.0.0",
		tools: ["delete"],
		authority: "effectful",
		approval: "none",
	}, file), /must use always approval/);
	assert.equal(await removeMcpServer("docs", file), true);
	assert.deepEqual((await readCapabilityConfig(file)).mcp.servers, {});
});

test("MCP adapter configuration disables discovery and exposes only declared tools", () => {
	const config = toMcpAdapterConfig({
		version: 1,
		mcp: { servers: {
			ops: {
				command: "ops-mcp",
				args: ["--stdio"],
				version: "4.0.1",
				tools: ["status", "restart"],
				authority: "effectful",
				approval: "always",
			},
		} },
	});
	assert.equal(config.settings.hostConfigDiscovery, "off");
	assert.equal(config.settings.scriptMode, false);
	assert.equal(config.settings.sampling, false);
	assert.deepEqual(config.mcpServers.ops.includeTools, ["status", "restart"]);
	assert.equal(config.mcpServers.ops.approveTools, true);
	assert.deepEqual(config.settings.outputGuard, { maxBytes: 32_768, maxLines: 500, detailsMaxBytes: 8_192 });
});

test("web results are capped before entering model context", () => {
	const result = capWebResult({ content: [{ type: "text", text: "x".repeat(50_000) }], details: { oversized: "x".repeat(50_000) } }) as {
		content: Array<{ text: string }>;
		details: Record<string, unknown>;
	};
	assert.ok(result.content[0].text.length < 33_000);
	assert.match(result.content[0].text, /truncated/);
	assert.deepEqual(result.details, { ishGuard: "read-only-web", maxTextChars: 32_768 });
});

test("ish MCP add records an exact declaration without starting the command", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-mcp-cli-"));
	const config = path.join(root, "capabilities.json");
	const marker = path.join(root, "started");
	const executable = path.join(root, "must-not-run");
	await writeFile(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
	await chmod(executable, 0o700);
	t.after(() => rm(root, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, [
		cli, "mcp", "add", "docs",
		"--command", executable,
		"--version", "1.2.3",
		"--tools", "search,fetch",
		"--authority", "observation",
		"--approval", "none",
		"--", "--stdio",
	], { encoding: "utf8", env: { ...process.env, ISH_CAPABILITIES: config } });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no process was started/);
	assert.equal(existsSync(marker), false);
	assert.deepEqual((await readCapabilityConfig(config)).mcp.servers.docs.args, ["--stdio"]);
});
