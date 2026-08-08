#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes("--version")) {
	console.log("pi 0.84.1 (demo fixture)");
	process.exit(0);
}

const prompt = args.at(-1) ?? "";
await new Promise((resolve) => setTimeout(resolve, 700));
if (prompt.includes("thermal throttle sentinel")) {
	console.log("\u001b[38;5;220mFinding\u001b[0m  the prior native output contains a thermal throttle warning");
	console.log("\u001b[38;5;42mEvidence\u001b[0m native command exited 0; visible log says CPU0 crossed 92 C");
	console.log("\u001b[38;5;39mNext\u001b[0m     inspect cooling and correlate with load; this is not a kernel crash");
	process.exit(0);
}
console.log("\u001b[38;5;39mish is the intent shell.\u001b[0m");
console.log("  \u001b[38;5;42mzsh\u001b[0m     runs known commands immediately");
console.log("  \u001b[38;5;213mPi\u001b[0m      handles explicit ? requests");
console.log("  \u001b[38;5;220mintentd\u001b[0m keeps context and work across shell sessions");
