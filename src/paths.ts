import os from "node:os";
import path from "node:path";

export function defaultSocketPath(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const runtime = process.env.XDG_RUNTIME_DIR;
	return runtime
		? path.join(runtime, "intentd-ish", "intentd.sock")
		: path.join(os.tmpdir(), `intentd-${uid}.sock`);
}

export function defaultStateDir(): string {
	const root = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
	return path.join(root, "intentd-ish");
}
