import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntentRecord } from "./types.js";

interface StoreFile {
	version: 1;
	intents: IntentRecord[];
}

export class IntentStore {
	private readonly records = new Map<string, IntentRecord>();
	private persistChain: Promise<void> = Promise.resolve();

	constructor(readonly stateDir: string) {}

	get statePath(): string {
		return path.join(this.stateDir, "intents.json");
	}

	async initialize(): Promise<void> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		try {
			const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as StoreFile;
			if (parsed.version !== 1 || !Array.isArray(parsed.intents)) {
				throw new Error("unsupported intent store format");
			}
			for (const record of parsed.intents) this.records.set(record.id, record);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	list(): IntentRecord[] {
		return [...this.records.values()]
			.map((record) => structuredClone(record))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	get(id: string): IntentRecord | undefined {
		const record = this.records.get(id);
		return record ? structuredClone(record) : undefined;
	}

	async set(record: IntentRecord): Promise<void> {
		this.records.set(record.id, structuredClone(record));
		const snapshot: StoreFile = { version: 1, intents: this.list() };
		this.persistChain = this.persistChain.then(async () => {
			const tempPath = `${this.statePath}.${process.pid}.tmp`;
			await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
			await rename(tempPath, this.statePath);
		});
		await this.persistChain;
	}
}
