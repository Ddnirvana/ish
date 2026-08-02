#!/usr/bin/env node

const prompt = process.argv.at(-1) ?? "";
const credentialVariable = [
	"DEEPSEEK_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
].find((variable) => process.env[variable]);

console.log(JSON.stringify({ type: "agent_start", prompt, args: process.argv.slice(2), credentialVariable }));
if (prompt.includes("LONG")) {
	await new Promise((resolve) => setTimeout(resolve, 30_000));
}
console.log(JSON.stringify({ type: "agent_end", result: `completed: ${prompt}` }));
