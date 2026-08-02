import { lstat, opendir, readlink } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { PiExtensionAPI, PiExtensionContext } from "../../src/pi-types.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const DEFAULT_MAX_ENTRIES = 20_000;
const MAX_ENTRIES = 100_000;
const DEFAULT_MAX_DEPTH = 8;
const MAX_DEPTH = 20;
const SCAN_TIMEOUT_MS = 5_000;
const MAX_ERRORS = 10;

export interface SystemInspectParams extends Record<string, unknown> {
	operation: "largest_files" | "stat";
	path?: string;
	paths?: string[];
	recursive?: boolean;
	limit?: number;
	maxDepth?: number;
	maxEntries?: number;
}

export interface FileMetadata {
	path: string;
	type: "file" | "directory" | "symlink" | "socket" | "fifo" | "block-device" | "character-device" | "other";
	sizeBytes: string;
	sizeHuman: string;
	permissions: string;
	modifiedAt: string;
	linkTarget?: string;
}

interface RankedFile extends FileMetadata {
	sortSize: bigint;
}

export interface LargestFilesResult {
	operation: "largest_files";
	root: string;
	recursive: boolean;
	limit: number;
	maxDepth: number;
	maxEntries: number;
	scannedEntries: number;
	matchedFiles: number;
	complete: boolean;
	incompleteReasons: string[];
	errors: Array<{ path: string; error: string }>;
	files: FileMetadata[];
}

export interface StatResult {
	operation: "stat";
	root: string;
	complete: boolean;
	errors: Array<{ path: string; error: string }>;
	paths: FileMetadata[];
}

export type SystemInspectResult = LargestFilesResult | StatResult;

const SystemInspectParams = Type.Object({
	operation: Type.Union([
		Type.Literal("largest_files"),
		Type.Literal("stat"),
	]),
	path: Type.Optional(Type.String({ description: "Path relative to the current ish directory, or an absolute path" })),
	paths: Type.Optional(Type.Array(Type.String(), { maxItems: 50, description: "Paths to inspect with stat" })),
	recursive: Type.Optional(Type.Boolean({ description: "For largest_files, descend into real directories; default false" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Number of largest files to return; default 5" })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_DEPTH, description: "Maximum recursive directory depth; default 8" })),
	maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ENTRIES, description: "Maximum directory entries to inspect; default 20000" })),
});

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return resolved;
}

function ensureActive(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("filesystem inspection cancelled");
	error.name = "AbortError";
	throw error;
}

function kind(stats: Awaited<ReturnType<typeof lstat>>): FileMetadata["type"] {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isSocket()) return "socket";
	if (stats.isFIFO()) return "fifo";
	if (stats.isBlockDevice()) return "block-device";
	if (stats.isCharacterDevice()) return "character-device";
	return "other";
}

function humanBytes(bytes: bigint): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
	let value = Number(bytes);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function shownPath(root: string, absolute: string): string {
	const relative = path.relative(root, absolute);
	return (relative || ".").split(path.sep).join("/");
}

async function metadata(root: string, absolute: string): Promise<RankedFile> {
	const stats = await lstat(absolute, { bigint: true });
	const sortSize = stats.size;
	const type = kind(stats as unknown as Awaited<ReturnType<typeof lstat>>);
	const result: RankedFile = {
		path: shownPath(root, absolute),
		type,
		sizeBytes: sortSize.toString(),
		sizeHuman: humanBytes(sortSize),
		permissions: `0o${(Number(stats.mode) & 0o7777).toString(8).padStart(4, "0")}`,
		modifiedAt: new Date(Number(stats.mtimeMs)).toISOString(),
		sortSize,
	};
	if (type === "symlink") result.linkTarget = await readlink(absolute);
	return result;
}

function publicMetadata(value: RankedFile): FileMetadata {
	const { sortSize: _sortSize, ...result } = value;
	return result;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function recordError(errors: Array<{ path: string; error: string }>, root: string, absolute: string, error: unknown): void {
	if (errors.length < MAX_ERRORS) errors.push({ path: shownPath(root, absolute), error: errorText(error) });
}

function rank(left: RankedFile, right: RankedFile): number {
	if (left.sortSize > right.sortSize) return -1;
	if (left.sortSize < right.sortSize) return 1;
	return left.path.localeCompare(right.path);
}

async function largestFiles(params: SystemInspectParams, ctx: PiExtensionContext, signal?: AbortSignal): Promise<LargestFilesResult> {
	const root = path.resolve(ctx.cwd, params.path ?? ".");
	const limit = integer(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
	const maxDepth = integer(params.maxDepth, DEFAULT_MAX_DEPTH, 0, MAX_DEPTH, "maxDepth");
	const maxEntries = integer(params.maxEntries, DEFAULT_MAX_ENTRIES, 1, MAX_ENTRIES, "maxEntries");
	const recursive = params.recursive ?? false;
	const deadline = Date.now() + SCAN_TIMEOUT_MS;
	const errors: Array<{ path: string; error: string }> = [];
	const incompleteReasons = new Set<string>();
	const files: RankedFile[] = [];
	let scannedEntries = 0;
	let matchedFiles = 0;

	ensureActive(signal);
	const rootMetadata = await metadata(root, root);
	if (rootMetadata.type === "file") {
		return {
			operation: "largest_files",
			root,
			recursive,
			limit,
			maxDepth,
			maxEntries,
			scannedEntries: 1,
			matchedFiles: 1,
			complete: true,
			incompleteReasons: [],
			errors,
			files: [publicMetadata(rootMetadata)],
		};
	}
	if (rootMetadata.type !== "directory") throw new Error(`largest_files path is not a real directory or regular file: ${root}`);

	const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
	scan: while (pending.length > 0) {
		ensureActive(signal);
		if (Date.now() >= deadline) {
			incompleteReasons.add("timeout");
			break;
		}
		const current = pending.pop()!;
		let directory;
		try {
			directory = await opendir(current.directory);
		} catch (error) {
			recordError(errors, root, current.directory, error);
			incompleteReasons.add("entry-errors");
			continue;
		}

		for await (const entry of directory) {
			ensureActive(signal);
			if (scannedEntries >= maxEntries) {
				incompleteReasons.add("max-entries");
				break scan;
			}
			if (Date.now() >= deadline) {
				incompleteReasons.add("timeout");
				break scan;
			}
			scannedEntries += 1;
			const absolute = path.join(current.directory, entry.name);
			let item: RankedFile;
			try {
				item = await metadata(root, absolute);
			} catch (error) {
				recordError(errors, root, absolute, error);
				incompleteReasons.add("entry-errors");
				continue;
			}

			if (item.type === "file") {
				matchedFiles += 1;
				files.push(item);
				files.sort(rank);
				if (files.length > limit) files.pop();
				continue;
			}
			if (item.type !== "directory" || !recursive) continue;
			if (current.depth >= maxDepth) {
				incompleteReasons.add("max-depth");
				continue;
			}
			pending.push({ directory: absolute, depth: current.depth + 1 });
		}
	}

	return {
		operation: "largest_files",
		root,
		recursive,
		limit,
		maxDepth,
		maxEntries,
		scannedEntries,
		matchedFiles,
		complete: incompleteReasons.size === 0,
		incompleteReasons: [...incompleteReasons],
		errors,
		files: files.map(publicMetadata),
	};
}

async function statPaths(params: SystemInspectParams, ctx: PiExtensionContext, signal?: AbortSignal): Promise<StatResult> {
	const root = path.resolve(ctx.cwd);
	const requested = params.paths?.length ? params.paths : [params.path ?? "."];
	if (requested.length > 50) throw new Error("stat accepts at most 50 paths");
	const errors: Array<{ path: string; error: string }> = [];
	const results: FileMetadata[] = [];
	for (const requestedPath of requested) {
		ensureActive(signal);
		const absolute = path.resolve(ctx.cwd, requestedPath);
		try {
			results.push(publicMetadata(await metadata(root, absolute)));
		} catch (error) {
			recordError(errors, root, absolute, error);
		}
	}
	return { operation: "stat", root, complete: errors.length === 0, errors, paths: results };
}

export async function inspectFileSystem(
	params: SystemInspectParams,
	ctx: PiExtensionContext,
	signal?: AbortSignal,
): Promise<SystemInspectResult> {
	if (params.operation === "largest_files") return largestFiles(params, ctx, signal);
	if (params.operation === "stat") return statPaths(params, ctx, signal);
	throw new Error(`unsupported system_inspect operation: ${String(params.operation)}`);
}

export function registerSystemInspect(pi: PiExtensionAPI): void {
	pi.registerTool<SystemInspectParams>({
		name: "system_inspect",
		label: "System Inspect",
		description:
			"Read exact local filesystem metadata without running commands or following symlinked directories. Use largest_files before answering which files are largest; use stat for exact sizes, types, permissions, and timestamps. Never guess when this tool can measure.",
		parameters: SystemInspectParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await inspectFileSystem(params, ctx, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
