import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import intentExtension from "../src/pi-extension.js";

test("Pi adapter registers one durable-job tool and one slash command", () => {
	const tools: Array<{ name: string }> = [];
	const commands = new Map<string, unknown>();
	const api = {
		registerTool(tool: { name: string }) {
			tools.push(tool);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
	};

	intentExtension(api as unknown as ExtensionAPI);

	assert.deepEqual(tools.map((tool) => tool.name), ["intent_job"]);
	assert.deepEqual([...commands.keys()], ["intent"]);
});
