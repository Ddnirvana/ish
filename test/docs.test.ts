import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("README links a minimal user-only documentation set", async () => {
	const expected = ["commands.md", "configuration.md", "external-capabilities.md", "getting-started.md", "troubleshooting.md"];
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

test("VHS demos are maintained, linked, and backed by rendered assets", async () => {
	const expected = ["README.md", "capabilities.tape", "diagnostics.tape", "ish.tape", "launch.sh", "pi-fixture.mjs"];
	assert.deepEqual((await readdir(path.join(root, "demo"))).sort(), expected);
	const readme = await readFile(path.join(root, "README.md"), "utf8");
	assert.match(readme, /\]\(demo\/README\.md\)/);
	assert.match(await readFile(path.join(root, "demo", "pi-fixture.mjs"), "utf8"), /pi 0\.84\.1/);
	for (const tapeName of expected.filter((name) => name.endsWith(".tape"))) {
		const tape = await readFile(path.join(root, "demo", tapeName), "utf8");
		const output = /^Output (assets\/[A-Za-z0-9-]+\.gif)$/m.exec(tape)?.[1];
		assert.ok(output, `${tapeName} must declare a repository asset`);
		assert.ok((await stat(path.join(root, output))).size > 50_000, `${output} must contain a rendered demo`);
	}
});
