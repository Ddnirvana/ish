import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IshConfig } from "./config.js";

interface CredentialFile {
	version: 1;
	providers: Record<string, string>;
}

const PROVIDER_VARIABLES: Readonly<Record<string, string>> = {
	anthropic: "ANTHROPIC_API_KEY",
	"ant-ling": "ANT_LING_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	openai: "OPENAI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	google: "GEMINI_API_KEY",
	"amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
	mistral: "MISTRAL_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
	"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	radius: "RADIUS_API_KEY",
	huggingface: "HF_TOKEN",
	fireworks: "FIREWORKS_API_KEY",
	together: "TOGETHER_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	"qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
	"qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
	xiaomi: "XIAOMI_API_KEY",
	"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
};

function emptyCredentials(): CredentialFile {
	return { version: 1, providers: {} };
}

export function defaultCredentialPath(): string {
	const root = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
	return process.env.ISH_CREDENTIALS ?? path.join(root, "ish", "credentials.json");
}

export function credentialVariable(provider: string): string {
	const variable = PROVIDER_VARIABLES[provider];
	if (!variable) {
		throw new Error(
			`ish does not know the API-key variable for provider ${provider}; see https://pi.dev/docs/latest/providers`,
		);
	}
	return variable;
}

export async function readCredentials(file = defaultCredentialPath()): Promise<CredentialFile> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCredentials();
		throw error;
	}
	const parsed = JSON.parse(raw) as Partial<CredentialFile>;
	if (parsed.version !== 1 || !parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
		throw new Error(`invalid ish credential file: ${file}`);
	}
	const providers: Record<string, string> = {};
	for (const [provider, value] of Object.entries(parsed.providers)) {
		if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) {
			throw new Error(`invalid credential entry for provider ${provider}`);
		}
		providers[provider] = value;
	}
	return { version: 1, providers };
}

async function writeCredentials(credentials: CredentialFile, file: string): Promise<void> {
	const directory = path.dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, file);
	await chmod(file, 0o600);
}

export async function updateCredential(
	provider: string,
	value: string | undefined,
	file = defaultCredentialPath(),
): Promise<void> {
	credentialVariable(provider);
	const credentials = await readCredentials(file);
	if (value === undefined) delete credentials.providers[provider];
	else {
		const clean = value.trim();
		if (!clean || /[\r\n\0]/.test(clean)) throw new Error("API key must be one non-empty line");
		credentials.providers[provider] = clean;
	}
	await writeCredentials(credentials, file);
}

export async function credentialStatus(
	provider: string,
	baseEnvironment: NodeJS.ProcessEnv = process.env,
	file = defaultCredentialPath(),
): Promise<{ provider: string; variable: string; source: "environment" | "stored" | "missing" | "pi-managed" }> {
	const variable = PROVIDER_VARIABLES[provider];
	if (!variable) return { provider, variable: "Pi provider authentication", source: "pi-managed" };
	if (baseEnvironment[variable]) return { provider, variable, source: "environment" };
	const credentials = await readCredentials(file);
	return { provider, variable, source: credentials.providers[provider] ? "stored" : "missing" };
}

export async function piEnvironment(
	config: IshConfig,
	baseEnvironment: NodeJS.ProcessEnv = process.env,
	file = defaultCredentialPath(),
): Promise<NodeJS.ProcessEnv> {
	const environment = { ...baseEnvironment };
	if (!config.provider) return environment;
	const variable = PROVIDER_VARIABLES[config.provider];
	if (!variable) return environment;
	if (environment[variable]) return environment;
	const credentials = await readCredentials(file);
	if (credentials.providers[config.provider]) environment[variable] = credentials.providers[config.provider];
	return environment;
}
