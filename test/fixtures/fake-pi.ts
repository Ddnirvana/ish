#!/usr/bin/env node

import { appendFile } from "node:fs/promises";

const prompt = process.argv.at(-1) ?? "";
const credentialVariable = [
	"DEEPSEEK_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
].find((variable) => process.env[variable]);

if (prompt.includes("LONG")) {
	await new Promise((resolve) => setTimeout(resolve, Number(process.env.ISH_FAKE_PI_DELAY_MS ?? 30_000)));
}
console.log(JSON.stringify({ type: "agent_start", prompt, args: process.argv.slice(2), credentialVariable }));
if (process.env.ISH_TEST_LOG) await appendFile(process.env.ISH_TEST_LOG, `${prompt}\n`);
console.log(JSON.stringify({ type: "agent_end", result: `completed: ${prompt}` }));
