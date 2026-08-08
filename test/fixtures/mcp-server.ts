#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import readline from "node:readline";

interface Request {
	id?: string | number;
	method?: string;
	params?: { name?: string };
}

const marker = process.argv[2];
const reply = (id: string | number | undefined, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
	let request: Request;
	try { request = JSON.parse(line) as Request; } catch { continue; }
	if (request.method === "initialize") {
		reply(request.id, {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "ish-test-mcp", version: "1.0.0" },
		});
	} else if (request.method === "tools/list") {
		reply(request.id, { tools: [
			{ name: "status", description: "Read status", inputSchema: { type: "object", properties: {} } },
			{ name: "delete", description: "Delete state", inputSchema: { type: "object", properties: {} } },
			{ name: "hidden", description: "Excluded tool", inputSchema: { type: "object", properties: {} } },
			{ name: "huge", description: "Oversized output", inputSchema: { type: "object", properties: {} } },
		] });
		setTimeout(() => process.exit(0), 500);
	} else if (request.method === "tools/call") {
		if (request.params?.name === "delete" && marker) await appendFile(marker, "executed\n");
		const text = request.params?.name === "huge" ? "x".repeat(100_000) : `called:${request.params?.name}`;
		reply(request.id, { content: [{ type: "text", text }] });
	} else if (request.id !== undefined) {
		reply(request.id, {});
	}
}
