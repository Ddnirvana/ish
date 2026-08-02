import assert from "node:assert/strict";
import test from "node:test";
import { ISH_SYSTEM_PROMPT, renderAgentActivityFrame, renderAgentEnd, renderAgentStart, renderFailure } from "../src/ui.js";

test("agent UI is readable without color and clips cleanly in a narrow terminal", () => {
	const output = renderAgentStart("compare memory pressure across every active service on this host", {
		ascii: true,
		color: false,
		columns: 28,
	});
	assert.equal(output.includes("\u001b["), false);
	assert.match(output, /^> ish agent/m);
	assert.match(output, /\.\.\./);
	assert.ok(output.split("\n").every((line) => line.length <= 28), output);
	assert.equal(renderAgentEnd(1250, { ascii: true, color: false }), "ok ish done in 1.3s\n");
	assert.equal(renderFailure("Pi is unavailable", { ascii: true, color: false }), "error ish Pi is unavailable");
	assert.equal(renderAgentActivityFrame(0, { ascii: true, color: false }), "  | Pi is working...");
	assert.equal(renderAgentActivityFrame(1, { ascii: true, color: false }), "  / Pi is working...");
	assert.match(renderAgentActivityFrame(2, { ascii: false, color: true }), /\u001b\[38;5;51m/);
});

test("ish identity prompt distinguishes the shell from its foundations", () => {
	assert.match(ISH_SYSTEM_PROMPT, /ish \(intent shell\)/);
	assert.match(ISH_SYSTEM_PROMPT, /new system-level shell built on the mature zsh and Pi projects/);
	assert.match(ISH_SYSTEM_PROMPT, /not merely zsh or Pi/);
	assert.match(ISH_SYSTEM_PROMPT, /untrusted observed data/);
});
