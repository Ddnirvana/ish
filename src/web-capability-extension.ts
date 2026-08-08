import piWebAccess from "../../vendor/pi-web-access-loader.mjs";
import { Type } from "typebox";
import { readCapabilityConfigSync } from "./capabilities.js";

const ALLOWED_TOOLS = new Set(["web_search", "source_check", "fetch_content"]);
const MAX_TEXT_CHARS = 32_768;
const BLOCKED_HOSTS = new Set(["github.com", "www.github.com", "youtube.com", "www.youtube.com", "youtu.be"]);
const BLOCKED_EXTENSIONS = /\.(?:mp4|mov|webm|avi|mpeg|mpg|wmv|flv|3gp|3gpp)(?:$|[?#])/i;
const Recency = Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")]));
const TOOL_SURFACE: Record<string, { label: string; description: string; parameters: unknown; promptSnippet: string }> = {
	web_search: {
		label: "Web Search",
		description: "Search the current web with one configured provider and return bounded results with source URLs.",
		promptSnippet: "Use for current information; cite the returned source URLs.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ maxLength: 1000 })),
			queries: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { minItems: 1, maxItems: 4 })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
			recencyFilter: Recency,
			domainFilter: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 16 })),
		}),
	},
	source_check: {
		label: "Source Check",
		description: "Check one claim against current web results and return bounded source evidence.",
		promptSnippet: "Use to verify a claim and preserve source URLs in the answer.",
		parameters: Type.Object({
			claim: Type.String({ minLength: 1, maxLength: 2000 }),
			queries: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { minItems: 1, maxItems: 4 })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
			recencyFilter: Recency,
			domainFilter: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 16 })),
		}),
	},
	fetch_content: {
		label: "Fetch Web Content",
		description: "Fetch up to four public HTTP(S) pages as readable text. Repository, video, and local handlers are rejected.",
		promptSnippet: "Use to read a known public HTTP(S) source; cite its URL.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ maxLength: 4096 })),
			urls: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 4 })),
		}),
	},
};

interface ToolDefinition {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
	[key: string]: unknown;
}

interface ExtensionApi {
	registerTool(tool: ToolDefinition): void;
	[key: string]: unknown;
}

function allowedUrl(raw: string): string {
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error(`web fetch requires an absolute HTTP(S) URL: ${raw}`); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`web fetch rejects URL scheme ${url.protocol}`);
	if (BLOCKED_HOSTS.has(url.hostname.toLowerCase()) || BLOCKED_EXTENSIONS.test(url.pathname)) {
		throw new Error(`web fetch rejects repository and video handlers: ${url.hostname}${url.pathname}`);
	}
	return url.toString();
}

function guardedParams(name: string, value: unknown, provider: string): Record<string, unknown> {
	const params = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	if (name === "web_search") {
		return {
			...(typeof params.query === "string" ? { query: params.query.slice(0, 1000) } : {}),
			...(Array.isArray(params.queries) ? { queries: params.queries.filter((item): item is string => typeof item === "string").slice(0, 4).map((item) => item.slice(0, 1000)) } : {}),
			...(typeof params.numResults === "number" ? { numResults: Math.max(1, Math.min(10, Math.floor(params.numResults))) } : {}),
			...(params.recencyFilter ? { recencyFilter: params.recencyFilter } : {}),
			...(Array.isArray(params.domainFilter) ? { domainFilter: params.domainFilter.slice(0, 16) } : {}),
			provider,
			workflow: "none",
			includeContent: false,
		};
	}
	if (name === "source_check") {
		return {
			claim: typeof params.claim === "string" ? params.claim.slice(0, 2000) : "",
			...(Array.isArray(params.queries) ? { queries: params.queries.filter((item): item is string => typeof item === "string").slice(0, 4).map((item) => item.slice(0, 1000)) } : {}),
			...(typeof params.numResults === "number" ? { numResults: Math.max(1, Math.min(10, Math.floor(params.numResults))) } : {}),
			...(params.recencyFilter ? { recencyFilter: params.recencyFilter } : {}),
			...(Array.isArray(params.domainFilter) ? { domainFilter: params.domainFilter.slice(0, 16) } : {}),
			provider,
			fetchContent: false,
		};
	}
	const rawUrls = Array.isArray(params.urls) ? params.urls : params.url === undefined ? [] : [params.url];
	const urls = rawUrls.filter((item): item is string => typeof item === "string").slice(0, 4).map(allowedUrl);
	if (urls.length === 0) throw new Error("web fetch requires url or urls");
	return urls.length === 1 ? { url: urls[0], mode: "readable" } : { urls, mode: "readable" };
}

export function capWebResult(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const result = value as Record<string, unknown>;
	const content = Array.isArray(result.content) ? result.content.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const part = item as Record<string, unknown>;
		if (part.type !== "text" || typeof part.text !== "string" || part.text.length <= MAX_TEXT_CHARS) return part;
		return { ...part, text: `${part.text.slice(0, MAX_TEXT_CHARS)}\n[ish: web output truncated at ${MAX_TEXT_CHARS} characters]` };
	}) : result.content;
	return { ...result, content, details: { ishGuard: "read-only-web", maxTextChars: MAX_TEXT_CHARS } };
}

export default function ishWebCapability(pi: ExtensionApi): void {
	const config = readCapabilityConfigSync();
	if (!config.web?.enabled) return;
	const provider = config.web.provider;
	const proxy = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolDefinition) => {
					if (!ALLOWED_TOOLS.has(tool.name)) return;
					const surface = TOOL_SURFACE[tool.name];
					const execute = tool.execute.bind(tool);
					target.registerTool({
						...tool,
						...surface,
						description: `${surface.description} Provider: ${provider}.`,
						async execute(...args: unknown[]) {
							args[1] = guardedParams(tool.name, args[1], provider);
							return capWebResult(await execute(...args));
						},
					});
				};
			}
			if (property === "registerCommand" || property === "registerShortcut" || property === "registerFlag") return () => undefined;
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	piWebAccess(proxy as never);
}
