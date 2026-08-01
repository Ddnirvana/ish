#!/usr/bin/env node

const prompt = process.argv.at(-1) ?? "";

console.log(JSON.stringify({ type: "agent_start", prompt, args: process.argv.slice(2) }));
if (prompt.includes("LONG")) {
	await new Promise((resolve) => setTimeout(resolve, 30_000));
}
console.log(JSON.stringify({ type: "agent_end", result: `completed: ${prompt}` }));
