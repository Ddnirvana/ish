import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { routeInput } from "../src/gateway.js";

const commands = new Set(["git", "ls", "rm", "systemctl"]);
const route = (line: string) => routeInput(line, { commandExists: (command) => commands.has(command) }).route;

test("semantic gateway keeps deterministic shell input on the native fast path", () => {
	for (const input of [
		"ls",
		"git status",
		"rm 检查报告.txt",
		"echo hello | wc -c",
		"FOO=bar command",
		"./configure --help",
		"for x in *; do echo $x; done",
		"unknown-command",
	]) {
		assert.equal(route(input), "native", input);
	}
});

test("semantic gateway routes only high-confidence or explicit requests to the agent", () => {
	for (const input of ["? inspect memory pressure", "/ask explain this failure", "why is nginx failing?", "帮我检查内存", "如何查看系统日志"]) {
		assert.equal(route(input), "agent", input);
	}
	for (const input of ["/intent list", "/panes", "/broadcast session:prod -- uptime"]) {
		assert.equal(route(input), "control", input);
	}
});

test("routing is a local deterministic operation with no agent dependency", () => {
	const start = performance.now();
	for (let index = 0; index < 100_000; index += 1) route(index % 2 ? "ls" : "why is nginx failing?");
	const elapsedMs = performance.now() - start;
	assert.ok(elapsedMs < 1000, `100k routes took ${elapsedMs.toFixed(1)} ms`);
});
