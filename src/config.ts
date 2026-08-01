import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface IshConfig {
	provider?: string;
	model?: string;
}

export type IshConfigKey = keyof IshConfig;

export function defaultConfigPath(): string {
	const root = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
	return process.env.ISH_CONFIG ?? path.join(root, "ish", "config.json");
}

function validateValue(key: IshConfigKey, value: string): string {
	const clean = value.trim();
	if (!clean || !/^[A-Za-z0-9._:/+-]+$/.test(clean)) {
		throw new Error(`${key} must contain only provider/model identifier characters`);
	}
	return clean;
}

export async function readConfig(file = defaultConfigPath()): Promise<IshConfig> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const config: IshConfig = {};
	for (const key of ["provider", "model"] as const) {
		if (parsed[key] !== undefined) {
			if (typeof parsed[key] !== "string") throw new Error(`invalid ish config field: ${key}`);
			config[key] = validateValue(key, parsed[key]);
		}
	}
	return config;
}

export async function updateConfig(key: IshConfigKey, value: string | undefined, file = defaultConfigPath()): Promise<IshConfig> {
	const config = await readConfig(file);
	if (value === undefined) delete config[key];
	else config[key] = validateValue(key, value);
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${process.pid}`;
	await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, file);
	return config;
}
