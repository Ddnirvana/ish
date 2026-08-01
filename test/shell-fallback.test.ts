import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const shellPath = fileURLToPath(new URL("../../shell/ish.zsh", import.meta.url));

test("native zsh routing works when intentd and Pi are absent", () => {
	const result = spawnSync(
		"zsh",
		["-dfc", `source ${JSON.stringify(shellPath)}; _ish_native_fast_path 'ls'; printf ':%s\\n' $?`],
		{
			encoding: "utf8",
			env: {
				...process.env,
				INTENTD_SOCKET: "/definitely/not/a/socket",
				ISH_PI: "/definitely/not/pi",
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /:0/);
});
