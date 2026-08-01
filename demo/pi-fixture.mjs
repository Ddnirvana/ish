#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes("--version")) {
	console.log("pi 0.83.0 (demo fixture)");
	process.exit(0);
}

await new Promise((resolve) => setTimeout(resolve, 700));
console.log("\u001b[38;5;39mish is the intent shell.\u001b[0m");
console.log("  \u001b[38;5;42mzsh\u001b[0m     runs known commands immediately");
console.log("  \u001b[38;5;213mPi\u001b[0m      handles explicit ? requests");
console.log("  \u001b[38;5;220mintentd\u001b[0m keeps context and work across shell sessions");
