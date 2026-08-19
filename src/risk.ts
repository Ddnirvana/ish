export type RiskLevel = "safe" | "caution" | "danger" | "critical";

export interface RiskAssessment {
	level: RiskLevel;
	rule: string;
	reason: string;
}

interface RiskRule extends RiskAssessment {
	pattern: RegExp;
}

const RULES: RiskRule[] = [
	{
		level: "critical",
		rule: "destructive-root",
		reason: "recursive deletion targets a root, home, or system path",
		pattern: /\brm\s+[^\n]*(?:-[^\s]*[rR][^\s]*|--recursive)[^\n]*(?:\s\/\s*(?:['"]|$)|\s\/(?:etc|usr|var|home|boot)(?:\/|\s|['"]|$)|\s~(?:\/|\s|['"]|$)|\$HOME)/i,
	},
	{
		level: "critical",
		rule: "raw-device",
		reason: "command can overwrite or reformat a block device",
		pattern: /(?:^|\s)(?:mkfs(?:\.[a-z0-9]+)?|wipefs|fdisk|cfdisk|sfdisk|parted)\b|\bdd\b[^\n]*\bof=\/dev\//i,
	},
	{
		level: "critical",
		rule: "remote-code-pipe",
		reason: "downloaded content is piped directly into a command interpreter",
		pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python(?:3)?|node)\b/i,
	},
	{
		level: "danger",
		rule: "recursive-delete",
		reason: "recursive deletion can remove an entire directory tree",
		pattern: /\brm\s+[^\n]*(?:-[^\s]*[rR][^\s]*|--recursive)\b/i,
	},
	{
		level: "danger",
		rule: "privileged-operation",
		reason: "sudo grants the command elevated operating-system authority",
		pattern: /\bsudo(?:\s+-[^\s]+)*\s+/i,
	},
	{
		level: "danger",
		rule: "system-power",
		reason: "command can stop or restart the host",
		pattern: /(?:^|\s)(?:shutdown|reboot|poweroff|halt)\b/i,
	},
	{
		level: "danger",
		rule: "history-or-worktree-loss",
		reason: "Git operation can discard uncommitted work or untracked files",
		pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*[fdx]|checkout\s+--\s|restore\s+[^\n]*--worktree)/i,
	},
	{
		level: "danger",
		rule: "resource-destroy",
		reason: "command requests destructive removal of managed resources",
		pattern: /\b(?:docker\s+system\s+prune|kubectl\s+delete|terraform\s+destroy|DROP\s+(?:DATABASE|SCHEMA|TABLE))\b/i,
	},
	{
		level: "danger",
		rule: "recursive-permissions",
		reason: "recursive ownership or permission changes can make a tree unusable",
		pattern: /(?:^|\s)(?:chmod|chown)\s+[^\n]*(?:-[^\s]*R|--recursive)\b/i,
	},
	{
		level: "danger",
		rule: "ish-effectful-control",
		reason: "ish control command explicitly dispatches effects to one or more shells",
		pattern: /^\/(?:apply|broadcast)\b[^\n]*--execute\b/i,
	},
	{
		level: "caution",
		rule: "single-delete",
		reason: "removal is irreversible without an external recovery mechanism",
		pattern: /\brm\s+/i,
	},
];

export function assessRisk(command: string): RiskAssessment {
	const normalized = command.trim();
	if (!normalized) return { level: "safe", rule: "empty", reason: "empty input has no effect" };
	for (const rule of RULES) {
		if (rule.pattern.test(normalized)) {
			return { level: rule.level, rule: rule.rule, reason: rule.reason };
		}
	}
	return { level: "safe", rule: "none", reason: "no high-risk operation matched" };
}
