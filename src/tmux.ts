import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TmuxPane {
	id: string;
	session: string;
	windowId: string;
	windowIndex: string;
	windowName: string;
	command: string;
	path: string;
	inMode: boolean;
}

export interface TmuxExecutor {
	run(args: string[]): Promise<{ stdout: string }>;
}

export interface BroadcastPlan {
	selector: string;
	command: string;
	targets: TmuxPane[];
	excluded: Array<{ pane: TmuxPane; reason: string }>;
}

const SHELL_PROCESSES = new Set(["bash", "dash", "fish", "ish", "ksh", "sh", "zsh"]);
const FORMAT = [
	"#{pane_id}",
	"#{session_name}",
	"#{window_id}",
	"#{window_index}",
	"#{window_name}",
	"#{pane_current_command}",
	"#{pane_current_path}",
	"#{pane_in_mode}",
].join("\t");

export class SystemTmuxExecutor implements TmuxExecutor {
	constructor(private readonly socketName?: string) {}

	async run(args: string[]): Promise<{ stdout: string }> {
		const prefix = this.socketName ? ["-L", this.socketName] : [];
		const result = await execFileAsync("tmux", [...prefix, ...args], { encoding: "utf8" });
		return { stdout: result.stdout };
	}
}

export class TmuxTopology {
	constructor(private readonly executor: TmuxExecutor = new SystemTmuxExecutor()) {}

	async discover(): Promise<TmuxPane[]> {
		const { stdout } = await this.executor.run(["list-panes", "-a", "-F", FORMAT]);
		return stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [id, session, windowId, windowIndex, windowName, command, panePath, inMode] = line.split("\t");
				return {
					id,
					session,
					windowId,
					windowIndex,
					windowName,
					command,
					path: panePath,
					inMode: inMode === "1",
				};
			});
	}

	planBroadcast(panes: TmuxPane[], selector: string, command: string): BroadcastPlan {
		if (!command.trim()) throw new Error("broadcast command is required");
		const selected = panes.filter((pane) => this.matches(pane, selector));
		if (selected.length === 0) throw new Error(`selector matched no panes: ${selector}`);

		const targets: TmuxPane[] = [];
		const excluded: Array<{ pane: TmuxPane; reason: string }> = [];
		for (const pane of selected) {
			if (pane.inMode) {
				excluded.push({ pane, reason: "pane is in copy or control mode" });
			} else if (!SHELL_PROCESSES.has(pane.command)) {
				excluded.push({ pane, reason: `foreground process is ${pane.command}, not a shell` });
			} else {
				targets.push(pane);
			}
		}
		if (targets.length === 0) throw new Error(`selector matched panes, but none are safe shell targets: ${selector}`);
		return { selector, command, targets, excluded };
	}

	async executeBroadcast(plan: BroadcastPlan): Promise<void> {
		for (const pane of plan.targets) {
			await this.executor.run(["send-keys", "-t", pane.id, "-l", "--", plan.command]);
			await this.executor.run(["send-keys", "-t", pane.id, "Enter"]);
		}
	}

	private matches(pane: TmuxPane, selector: string): boolean {
		if (selector === "all") return true;
		if (selector.startsWith("pane:")) return pane.id === selector.slice("pane:".length);
		if (selector.startsWith("session:")) return pane.session === selector.slice("session:".length);
		if (selector.startsWith("window:")) {
			const value = selector.slice("window:".length);
			return value === `${pane.session}:${pane.windowIndex}` || value === `${pane.session}:${pane.windowName}`;
		}
		throw new Error(`unsupported selector: ${selector}`);
	}
}
