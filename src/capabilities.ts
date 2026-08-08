import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfigPath } from "./config.js";

export const CAPABILITY_CONFIG_VERSION = 1;
export const WEB_PACKAGE = {
	name: "pi-web-access",
	version: "0.18.0",
	integrity: "sha512-UVLWaNBHrbbe2jnpYq+uVJdPgoExz8HevkI7r3VSboZ6AT/S7oxsxpJY/a72mUt9jAy41512ndVxfxh/CIuYqg==",
} as const;
export const MCP_PACKAGE = {
	name: "pi-mcp-adapter",
	version: "2.21.0",
	integrity: "sha512-4oLrU5qTdbMnDNU8ECGADX3H2V50DCtgIjqFf+BWA31c9mw5zvSnCJfplyaf8v55NpfgBvi/Rli7ES4DflckfA==",
} as const;

export const WEB_PROVIDERS = [
	"openai", "brave", "parallel", "tinyfish", "search1api", "searchinfinity",
	"querit", "tavily", "serpdive", "kagi", "ollama", "searxng", "exa",
	"perplexity", "xai", "brightdata", "serpbase",
] as const;

export type WebProvider = typeof WEB_PROVIDERS[number];
export type McpAuthority = "observation" | "effectful";
export type McpApproval = "none" | "always";

export interface WebCapabilityConfig {
	enabled: boolean;
	provider: WebProvider;
}

export interface McpServerConfig {
	command: string;
	args: string[];
	version: string;
	tools: string[];
	authority: McpAuthority;
	approval: McpApproval;
}

export interface CapabilityConfig {
	version: 1;
	web?: WebCapabilityConfig;
	mcp: { servers: Record<string, McpServerConfig> };
}

export function defaultCapabilityConfigPath(): string {
	return process.env.ISH_CAPABILITIES ?? path.join(path.dirname(defaultConfigPath()), "capabilities.json");
}

function emptyConfig(): CapabilityConfig {
	return { version: CAPABILITY_CONFIG_VERSION, mcp: { servers: {} } };
}

function exactIdentifier(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const clean = value.trim();
	if (!clean || clean.length > 160 || /[\s*^~<>=|&;$`]/.test(clean)) {
		throw new Error(`${label} must be an exact identifier without ranges or shell syntax`);
	}
	return clean;
}

function toolName(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) {
		throw new Error(`invalid MCP tool name: ${String(value)}`);
	}
	return value;
}

function parseConfig(value: unknown): CapabilityConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("capability config must be an object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== CAPABILITY_CONFIG_VERSION) throw new Error(`unsupported capability config version: ${String(raw.version)}`);
	const result = emptyConfig();
	if (raw.web !== undefined) {
		if (!raw.web || typeof raw.web !== "object" || Array.isArray(raw.web)) throw new Error("web capability must be an object");
		const web = raw.web as Record<string, unknown>;
		if (typeof web.enabled !== "boolean" || !WEB_PROVIDERS.includes(web.provider as WebProvider)) {
			throw new Error("web capability requires enabled and an approved provider");
		}
		result.web = { enabled: web.enabled, provider: web.provider as WebProvider };
	}
	const mcp = raw.mcp;
	if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) throw new Error("mcp capability must be an object");
	const servers = (mcp as Record<string, unknown>).servers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcp.servers must be an object");
	for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
		if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`MCP server ${name} must be an object`);
		const item = entry as Record<string, unknown>;
		const authority = item.authority;
		const approval = item.approval;
		if (authority !== "observation" && authority !== "effectful") throw new Error(`invalid authority for MCP server ${name}`);
		if (approval !== "none" && approval !== "always") throw new Error(`invalid approval policy for MCP server ${name}`);
		if (authority === "effectful" && approval !== "always") throw new Error(`effectful MCP server ${name} must use always approval`);
		if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === "string" && arg.length <= 2048)) throw new Error(`invalid args for MCP server ${name}`);
		if (!Array.isArray(item.tools) || item.tools.length === 0 || item.tools.length > 64) throw new Error(`MCP server ${name} requires 1-64 allowed tools`);
		result.mcp.servers[name] = {
			command: exactIdentifier(item.command, `command for MCP server ${name}`),
			args: [...item.args] as string[],
			version: exactIdentifier(item.version, `version for MCP server ${name}`),
			tools: [...new Set(item.tools.map(toolName))],
			authority,
			approval,
		};
	}
	return result;
}

export async function readCapabilityConfig(file = defaultCapabilityConfigPath()): Promise<CapabilityConfig> {
	try {
		return parseConfig(JSON.parse(await readFile(file, "utf8")) as unknown);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
		throw error;
	}
}

export function readCapabilityConfigSync(file = defaultCapabilityConfigPath()): CapabilityConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(file, "utf8")) as unknown);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
		throw error;
	}
}

export async function writeCapabilityConfig(config: CapabilityConfig, file = defaultCapabilityConfigPath()): Promise<void> {
	const clean = parseConfig(config);
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${process.pid}`;
	await writeFile(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, file);
}

export async function configureWeb(provider: string, enabled: boolean, file = defaultCapabilityConfigPath()): Promise<CapabilityConfig> {
	if (!WEB_PROVIDERS.includes(provider as WebProvider)) throw new Error(`unsupported web provider: ${provider}; choose ${WEB_PROVIDERS.join(", ")}`);
	const config = await readCapabilityConfig(file);
	config.web = { enabled, provider: provider as WebProvider };
	await writeCapabilityConfig(config, file);
	return config;
}

export async function upsertMcpServer(name: string, server: McpServerConfig, file = defaultCapabilityConfigPath()): Promise<CapabilityConfig> {
	const config = await readCapabilityConfig(file);
	config.mcp.servers[name] = server;
	await writeCapabilityConfig(config, file);
	return readCapabilityConfig(file);
}

export async function removeMcpServer(name: string, file = defaultCapabilityConfigPath()): Promise<boolean> {
	const config = await readCapabilityConfig(file);
	const found = name in config.mcp.servers;
	delete config.mcp.servers[name];
	await writeCapabilityConfig(config, file);
	return found;
}

export function toMcpAdapterConfig(config: CapabilityConfig) {
	const mcpServers: Record<string, Record<string, unknown>> = {};
	for (const [name, server] of Object.entries(config.mcp.servers)) {
		mcpServers[name] = {
			command: server.command,
			args: server.args,
			lifecycle: "lazy",
			directTools: false,
			exposeResources: false,
			includeTools: server.tools,
			approveTools: server.approval === "always",
		};
	}
	return {
		mcpServers,
		settings: {
			hostConfigDiscovery: "off" as const,
			agentPluginPaths: [],
			directTools: false,
			scriptMode: false,
			approveTools: true,
			disableProxyTool: false,
			sampling: false,
			elicitation: false,
			autoAuth: false,
			outputGuard: { maxBytes: 32_768, maxLines: 500, detailsMaxBytes: 8_192 },
		},
	};
}
