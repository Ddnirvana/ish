import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("README links a minimal user-only documentation set", async () => {
	const expected = ["commands.md", "configuration.md", "getting-started.md", "troubleshooting.md"];
	assert.deepEqual((await readdir(path.join(root, "docs"))).sort(), expected);
	const readme = await readFile(path.join(root, "README.md"), "utf8");
	for (const link of readme.matchAll(/\]\((docs\/[^)#]+\.md)\)/g)) {
		await access(path.join(root, link[1]));
	}
	assert.doesNotMatch(readme, /Engineering readiness does not establish|Never place a credential|research novelty/i);
	const docs = await Promise.all(expected.map((name) => readFile(path.join(root, "docs", name), "utf8")));
	const combined = docs.join("\n");
	assert.doesNotMatch(combined, /work contract|progress report|funding strategy|50,?000|research proposal|evaluation artifact/i);
	assert.match(combined, /ish doctor/);
	assert.match(combined, /ish config set key/);
	assert.match(combined, /ish service restart/);
	assert.match(combined, /ish default-shell/);
	assert.match(combined, /scripts\/uninstall\.sh/);
});
