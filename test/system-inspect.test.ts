import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { inspectFileSystem } from "../extensions/system-inspect/index.js";

async function fixture(t: TestContext): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "ish-system-inspect-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("largest_files returns the exact five direct files in byte order", async (t) => {
	const root = await fixture(t);
	for (const [name, size] of [["one.bin", 100], ["two.bin", 200], ["three.bin", 300], ["four.bin", 400], ["five.bin", 500], ["six.bin", 600]] as const) {
		await writeFile(path.join(root, name), Buffer.alloc(size));
	}
	await mkdir(path.join(root, "nested"));
	await writeFile(path.join(root, "nested", "larger.bin"), Buffer.alloc(1_000));

	const result = await inspectFileSystem({ operation: "largest_files", limit: 5 }, { cwd: root, ui: { notify() {} } });
	assert.equal(result.operation, "largest_files");
	assert.equal(result.complete, true);
	assert.equal(result.matchedFiles, 6);
	assert.deepEqual(result.files.map((file) => [file.path, file.sizeBytes]), [
		["six.bin", "600"],
		["five.bin", "500"],
		["four.bin", "400"],
		["three.bin", "300"],
		["two.bin", "200"],
	]);
});

test("recursive inspection never follows symlinked directories", async (t) => {
	const root = await fixture(t);
	const outside = await fixture(t);
	await mkdir(path.join(root, "nested"));
	await writeFile(path.join(root, "nested", "inside.bin"), Buffer.alloc(800));
	await writeFile(path.join(outside, "outside.bin"), Buffer.alloc(2_000));
	await symlink(outside, path.join(root, "escape"));

	const result = await inspectFileSystem(
		{ operation: "largest_files", recursive: true, maxDepth: 4 },
		{ cwd: root, ui: { notify() {} } },
	);
	assert.equal(result.operation, "largest_files");
	assert.equal(result.complete, true);
	assert.deepEqual(result.files.map((file) => file.path), ["nested/inside.bin"]);
	assert.doesNotMatch(JSON.stringify(result), /outside\.bin/);
});

test("bounded scans report incompleteness instead of claiming an exact ranking", async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, "nested"));
	await writeFile(path.join(root, "nested", "inside.bin"), Buffer.alloc(800));

	const depthLimited = await inspectFileSystem(
		{ operation: "largest_files", recursive: true, maxDepth: 0 },
		{ cwd: root, ui: { notify() {} } },
	);
	assert.equal(depthLimited.operation, "largest_files");
	assert.equal(depthLimited.complete, false);
	assert.deepEqual(depthLimited.incompleteReasons, ["max-depth"]);

	await writeFile(path.join(root, "a.bin"), Buffer.alloc(1));
	await writeFile(path.join(root, "b.bin"), Buffer.alloc(2));
	const entryLimited = await inspectFileSystem(
		{ operation: "largest_files", maxEntries: 1 },
		{ cwd: root, ui: { notify() {} } },
	);
	assert.equal(entryLimited.operation, "largest_files");
	assert.equal(entryLimited.complete, false);
	assert.deepEqual(entryLimited.incompleteReasons, ["max-entries"]);
});

test("stat reports exact metadata without dereferencing symlinks", async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, "target.bin"), Buffer.alloc(321));
	await symlink("target.bin", path.join(root, "link.bin"));

	const result = await inspectFileSystem(
		{ operation: "stat", paths: ["target.bin", "link.bin"] },
		{ cwd: root, ui: { notify() {} } },
	);
	assert.equal(result.operation, "stat");
	assert.equal(result.complete, true);
	assert.deepEqual(result.paths.map((entry) => entry.type), ["file", "symlink"]);
	assert.equal(result.paths[0].sizeBytes, "321");
	assert.equal(result.paths[1].linkTarget, "target.bin");
});

test("inspection observes AbortSignal cancellation", async (t) => {
	const root = await fixture(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		inspectFileSystem({ operation: "largest_files" }, { cwd: root, ui: { notify() {} } }, controller.signal),
		(error: Error) => error.name === "AbortError",
	);
});
