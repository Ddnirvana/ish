#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";
import { piEnvironment } from "./credentials.js";
import { IntentDaemon } from "./daemon.js";
import { defaultSocketPath, defaultStateDir } from "./paths.js";
import { ISH_SYSTEM_PROMPT } from "./ui.js";

interface CliOptions {
	socketPath: string;
	stateDir: string;
	runner: string;
	runnerArgs: string[];
	maxConcurrency: number;
}

function parseArgs(args: string[]): CliOptions {
	const result: CliOptions = {
		socketPath: process.env.INTENTD_SOCKET ?? defaultSocketPath(),
		stateDir: process.env.INTENTD_STATE_DIR ?? defaultStateDir(),
		runner: process.env.INTENTD_PI ?? "pi",
		runnerArgs: [],
		maxConcurrency: 1,
	};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index + 1];
		switch (args[index]) {
			case "--socket":
				result.socketPath = value;
				index += 1;
				break;
			case "--state-dir":
				result.stateDir = value;
				index += 1;
				break;
			case "--runner":
				result.runner = value;
				index += 1;
				break;
			case "--runner-arg":
				result.runnerArgs.push(value);
				index += 1;
				break;
			case "--max-concurrency":
				result.maxConcurrency = Number(value);
				index += 1;
				break;
			case "--help":
				console.log("usage: intentd [--socket PATH] [--state-dir DIR] [--runner PI] [--runner-arg ARG] [--max-concurrency N]");
				process.exit(0);
			default:
				throw new Error(`unknown argument: ${args[index]}`);
		}
	}
	if (!Number.isInteger(result.maxConcurrency) || result.maxConcurrency < 1) {
		throw new Error("--max-concurrency must be a positive integer");
	}
	return result;
}

const options = parseArgs(process.argv.slice(2));
const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "pi-extension.js");
const daemon = new IntentDaemon({
	socketPath: options.socketPath,
	stateDir: options.stateDir,
	runner: {
		command: options.runner,
		args: async () => {
			const config = await readConfig();
			const args = [...options.runnerArgs];
			if (config.provider) args.push("--provider", config.provider);
			if (config.model) args.push("--model", config.model);
			args.push(
				"--session-dir",
				process.env.ISH_PI_SESSION_DIR ?? path.join(defaultStateDir(), "pi-sessions"),
				"--extension",
				extension,
				"--append-system-prompt",
				ISH_SYSTEM_PROMPT,
				"--tools",
				process.env.ISH_PI_TOOLS ?? "read,grep,find,ls,system_inspect",
			);
			return args;
		},
		environment: async () => piEnvironment(await readConfig()),
	},
	maxConcurrency: options.maxConcurrency,
});

await daemon.start();
console.log(`intentd listening on ${options.socketPath}`);

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await daemon.stop();
	process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
