import assert from "node:assert/strict";
import test from "node:test";
import intentExtension from "../src/pi-extension.js";
import type { PiExtensionAPI } from "../src/pi-types.js";

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

	intentExtension(api as unknown as PiExtensionAPI);

	assert.deepEqual(tools.map((tool) => tool.name), ["intent_job"]);
	assert.deepEqual([...commands.keys()], ["intent"]);
});
