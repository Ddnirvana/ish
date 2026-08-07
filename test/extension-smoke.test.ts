import assert from "node:assert/strict";
import test from "node:test";
import intentExtension from "../src/pi-extension.js";
import type { PiExtensionAPI } from "../src/pi-types.js";

test("Pi adapter registers durable, inspection, and staged capability tools", async () => {
	const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const commands = new Map<string, unknown>();
	const handlers = new Map<string, () => void | Promise<void>>();
	let active = ["read", "bash", "edit", "write", "package_tool"];
	const api = {
		on(event: string, handler: () => void | Promise<void>) {
			handlers.set(event, handler);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.push(tool);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		getActiveTools() {
			return [...active];
		},
		getAllTools() {
			return [
				...tools.map((tool) => ({ name: tool.name, description: tool.name, sourceInfo: { source: "ish", path: "ish", scope: "user" } })),
				{ name: "read", description: "read", sourceInfo: { source: "builtin", path: "read", scope: "user" } },
				{ name: "bash", description: "bash", sourceInfo: { source: "builtin", path: "bash", scope: "user" } },
				{ name: "edit", description: "edit", sourceInfo: { source: "builtin", path: "edit", scope: "user" } },
				{ name: "write", description: "write", sourceInfo: { source: "builtin", path: "write", scope: "user" } },
				{ name: "grep", description: "grep", sourceInfo: { source: "builtin", path: "grep", scope: "user" } },
				{ name: "find", description: "find", sourceInfo: { source: "builtin", path: "find", scope: "user" } },
				{ name: "ls", description: "ls", sourceInfo: { source: "builtin", path: "ls", scope: "user" } },
				{ name: "package_tool", description: "package tool", sourceInfo: { source: "test-package", path: "package", scope: "user" } },
			];
		},
		setActiveTools(names: string[]) {
			active = [...names];
		},
	};

	intentExtension(api as unknown as PiExtensionAPI);

	assert.deepEqual(tools.map((tool) => tool.name), [
		"intent_job",
		"system_inspect",
		"list_capabilities",
		"activate_capabilities",
	]);
	assert.deepEqual([...commands.keys()], ["intent"]);

	await handlers.get("session_start")?.();
	assert.deepEqual(active, ["read", "grep", "find", "ls", "intent_job", "system_inspect", "list_capabilities", "activate_capabilities"]);

	const list = tools.find((tool) => tool.name === "list_capabilities");
	assert.ok(list);
	const listed = await list.execute("call", { query: "package" });
	assert.deepEqual((listed as { details: { tools: unknown[] } }).details.tools, [{
		name: "package_tool",
		description: "package tool",
		source: "test-package",
		active: false,
		manualOnly: false,
	}]);

	const activate = tools.find((tool) => tool.name === "activate_capabilities");
	assert.ok(activate);
	const result = await activate.execute("call", { names: ["package_tool", "bash", "missing"] });
	assert.deepEqual(active, ["read", "grep", "find", "ls", "intent_job", "system_inspect", "list_capabilities", "activate_capabilities", "package_tool"]);
	assert.deepEqual((result as { details: unknown }).details, {
		activated: ["package_tool"],
		refused: ["bash"],
		unknown: ["missing"],
		active,
	});
});
