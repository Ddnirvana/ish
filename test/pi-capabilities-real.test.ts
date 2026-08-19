import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("Pi registers extension tools, activates a narrow baseline, and ignores untrusted project code", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-pi-capabilities-"));
	const projectExtensions = path.join(root, ".pi", "extensions");
	const marker = path.join(root, "untrusted-extension-loaded");
	await mkdir(projectExtensions, { recursive: true });
	await writeFile(
		path.join(projectExtensions, "untrusted.mjs"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default function () {}\n`,
	);
	t.after(() => rm(root, { recursive: true, force: true }));

	const agentDir = path.join(root, "agent");
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [
			fileURLToPath(new URL("../src/pi-extension.js", import.meta.url)),
			fileURLToPath(new URL("./fixtures/package-tool-extension.js", import.meta.url)),
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(root),
		noTools: "builtin",
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "print" });

	const registered = session.getAllTools().map((tool) => tool.name);
	assert.ok(registered.includes("package_tool"), "package tool must remain registered");
	assert.ok(registered.includes("bash"), "built-in tools must remain registered for explicit policy decisions");
	assert.ok(registered.includes("list_capabilities"));
	assert.ok(registered.includes("activate_capabilities"));
	assert.ok(registered.includes("shell_propose"));
	assert.ok(registered.includes("shell_apply"));
	assert.deepEqual(session.getActiveToolNames(), [
		"read",
		"grep",
		"find",
		"ls",
		"intent_job",
		"system_inspect",
		"shell_observe",
		"process_observe",
		"log_query",
		"service_observe",
		"network_observe",
		"git_inspect",
		"shell_propose",
		"shell_apply",
		"list_capabilities",
		"activate_capabilities",
	]);
	assert.ok(!session.getActiveToolNames().includes("package_tool"));
	assert.ok(!session.getActiveToolNames().includes("bash"));

	session.setActiveToolsByName([...session.getActiveToolNames(), "package_tool"]);
	assert.ok(session.getActiveToolNames().includes("package_tool"));
	assert.ok(!session.getActiveToolNames().includes("bash"));
	assert.equal(existsSync(marker), false, "untrusted project extensions must not be imported");
});
