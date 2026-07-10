import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: { patchText: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

let cwd: string;
let tool: RegisteredTool;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "pi-apply-patch-test-"));
	let registered: RegisteredTool | undefined;
	mock.module("typebox", () => ({
		Type: {
			Object: (schema: unknown) => schema,
			String: (schema: unknown) => schema,
		},
	}));
	const { default: applyPatchExtension } = await import("../extensions/code/apply-patch.ts");
	applyPatchExtension({
		registerTool(definition: RegisteredTool) {
			registered = definition;
		},
	} as never);
	if (!registered) throw new Error("apply_patch tool was not registered");
	tool = registered;
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

async function apply(patchText: string) {
	return tool.execute("test-call", { patchText }, undefined, undefined, { cwd });
}

async function text(relativePath: string) {
	return readFile(join(cwd, relativePath), "utf8");
}

function exists(relativePath: string) {
	return existsSync(join(cwd, relativePath));
}

async function expectRejectsWith(patchText: string, messagePart: string) {
	await expect(apply(patchText)).rejects.toThrow(messagePart);
}

describe("apply_patch tool", () => {
	test("adds a new file", async () => {
		const result = await apply(`*** Begin Patch
*** Add File: hello.txt
+hello
+world
*** End Patch`);

		expect(await text("hello.txt")).toBe("hello\nworld\n");
		expect(result.content[0].text).toContain("A hello.txt");
	});

	test("adds a file and creates missing parent directories", async () => {
		await apply(`*** Begin Patch
*** Add File: nested/deep/file.txt
+deep
*** End Patch`);

		expect(await text("nested/deep/file.txt")).toBe("deep\n");
	});

	test("updates an existing file", async () => {
		await writeFile(join(cwd, "existing.txt"), "line one\nline two\nline three\n");

		await apply(`*** Begin Patch
*** Update File: existing.txt
@@
-line two
+LINE TWO
*** End Patch`);

		expect(await text("existing.txt")).toBe("line one\nLINE TWO\nline three\n");
	});

	test("applies multiple hunks inside one update section", async () => {
		await writeFile(join(cwd, "code.js"), `function a() {
  return 1;
}

function b() {
  return 2;
}

function c() {
  return 3;
}
`);

		await apply(`*** Begin Patch
*** Update File: code.js
@@ function a() {
-  return 1;
+  return 10;
@@ function c() {
-  return 3;
+  return 30;
*** End Patch`);

		expect(await text("code.js")).toBe(`function a() {
  return 10;
}

function b() {
  return 2;
}

function c() {
  return 30;
}
`);
	});

	test("supports pure insertion and pure deletion hunks", async () => {
		await writeFile(join(cwd, "repeat.txt"), "start\nSAME\nmiddle\nSECOND\nend\n");

		await apply(`*** Begin Patch
*** Update File: repeat.txt
@@
 start
+inserted after start
 SAME
@@
-SECOND
*** End Patch`);

		expect(await text("repeat.txt")).toBe("start\ninserted after start\nSAME\nmiddle\nend\n");
	});

	test("deletes a file", async () => {
		await writeFile(join(cwd, "delete-me.txt"), "bye\n");

		const result = await apply(`*** Begin Patch
*** Delete File: delete-me.txt
*** End Patch`);

		expect(exists("delete-me.txt")).toBe(false);
		expect(result.content[0].text).toContain("D delete-me.txt");
	});

	test("moves and updates a file", async () => {
		await writeFile(join(cwd, "old.txt"), "alpha\nbeta\ngamma\n");

		const result = await apply(`*** Begin Patch
*** Update File: old.txt
*** Move to: dir/new.txt
@@
-alpha
+ALPHA
*** End Patch`);

		expect(exists("old.txt")).toBe(false);
		expect(await text("dir/new.txt")).toBe("ALPHA\nbeta\ngamma\n");
		expect(result.content[0].text).toContain("M dir/new.txt");
	});

	test("move creates missing parent directories", async () => {
		await writeFile(join(cwd, "move2.txt"), "x\n");

		await apply(`*** Begin Patch
*** Update File: move2.txt
*** Move to: deepmove/path/file.txt
@@
-x
+y
*** End Patch`);

		expect(exists("move2.txt")).toBe(false);
		expect(await text("deepmove/path/file.txt")).toBe("y\n");
	});

	test("supports paths with spaces", async () => {
		await apply(`*** Begin Patch
*** Add File: space name.txt
+space ok
*** End Patch`);

		expect(await text("space name.txt")).toBe("space ok\n");
	});

	test("rejects missing begin marker", async () => {
		await expectRejectsWith(`*** Add File: bad.txt
+bad
*** End Patch`, "missing Begin/End markers");
	});

	test("rejects missing end marker", async () => {
		await expectRejectsWith(`*** Begin Patch
*** Add File: bad.txt
+bad`, "missing Begin/End markers");
	});

	test("rejects deleting a missing file", async () => {
		await expectRejectsWith(`*** Begin Patch
*** Delete File: missing.txt
*** End Patch`, "File does not exist");
	});

	test("rejects updating a missing file", async () => {
		await expectRejectsWith(`*** Begin Patch
*** Update File: missing.txt
@@
-a
+b
*** End Patch`, "Failed to read file to update");
	});

	test("rejects absolute paths", async () => {
		await expectRejectsWith(`*** Begin Patch
*** Add File: ${join(cwd, "abs.txt")}
+abs
*** End Patch`, "absolute paths are not allowed");
	});

	test("rejects paths escaping the workspace", async () => {
		await expectRejectsWith(`*** Begin Patch
*** Add File: ../escape.txt
+escape
*** End Patch`, "path escapes workspace");
	});

	test("rejects empty patches", async () => {
		await expectRejectsWith(`*** Begin Patch
*** End Patch`, "empty patch");
	});

	test("does not partially apply a patch when a later hunk fails", async () => {
		await writeFile(join(cwd, "atomic.txt"), "keep\nchange\n");

		await expectRejectsWith(`*** Begin Patch
*** Update File: atomic.txt
@@
-change
+CHANGED
*** Update File: no-such-atomic.txt
@@
-a
+b
*** End Patch`, "Failed to read file to update");

		expect(await text("atomic.txt")).toBe("keep\nchange\n");
	});

	test("rejects add when the target file already exists", async () => {
		await writeFile(join(cwd, "existing.txt"), "original\n");

		await expectRejectsWith(`*** Begin Patch
*** Add File: existing.txt
+overwrite?
*** End Patch`, "File already exists");

		expect(await text("existing.txt")).toBe("original\n");
	});

	test("rejects move when the target file already exists", async () => {
		await writeFile(join(cwd, "source.txt"), "source\n");
		await writeFile(join(cwd, "target.txt"), "target\n");

		await expectRejectsWith(`*** Begin Patch
*** Update File: source.txt
*** Move to: target.txt
@@
-source
+moved
*** End Patch`, "Move target already exists");

		expect(exists("source.txt")).toBe(true);
		expect(await text("target.txt")).toBe("target\n");
	});

	test("applies multiple update sections for one file cumulatively", async () => {
		await writeFile(join(cwd, "samefile.txt"), "a\nb\nc\n");

		await apply(`*** Begin Patch
*** Update File: samefile.txt
@@
-a
+A
*** Update File: samefile.txt
@@
-c
+C
*** End Patch`);

		expect(await text("samefile.txt")).toBe("A\nb\nC\n");
	});

	test("rejects ambiguous repeated lines without enough context", async () => {
		await writeFile(join(cwd, "repeat.txt"), "start\nsame\nmiddle\nsame\nend\n");

		await expectRejectsWith(`*** Begin Patch
*** Update File: repeat.txt
@@
-same
+SAME
*** End Patch`, "Ambiguous match");

		expect(await text("repeat.txt")).toBe("start\nsame\nmiddle\nsame\nend\n");
	});

	test("uses context to update a later repeated match", async () => {
		await writeFile(join(cwd, "repeat.txt"), "start\nsame\nmiddle\nsame\nend\n");

		await apply(`*** Begin Patch
*** Update File: repeat.txt
@@
 middle
-same
+SECOND
 end
*** End Patch`);

		expect(await text("repeat.txt")).toBe("start\nsame\nmiddle\nSECOND\nend\n");
	});

	test("rejects add-file lines without plus prefixes", async () => {
		await expectRejectsWith(`*** Begin Patch
*** Add File: bad.txt
bad
*** End Patch`, "Invalid add file line");

		expect(exists("bad.txt")).toBe(false);
	});

	test("rejects unprefixed update lines", async () => {
		await writeFile(join(cwd, "format.txt"), "one\ntwo\nthree\n");

		await expectRejectsWith(`*** Begin Patch
*** Update File: format.txt
@@
one
-two
+TWO
 three
*** End Patch`, "Invalid update line");

		expect(await text("format.txt")).toBe("one\ntwo\nthree\n");
	});

	test("preserves missing final newline", async () => {
		await writeFile(join(cwd, "nonewline.txt"), "no-newline");

		await apply(`*** Begin Patch
*** Update File: nonewline.txt
@@
-no-newline
+has-newline
*** End Patch`);

		expect(await text("nonewline.txt")).toBe("has-newline");
	});

	test("preserves CRLF newline style", async () => {
		await writeFile(join(cwd, "crlf.txt"), "foo\r\nbar\r\n");

		await apply(`*** Begin Patch
*** Update File: crlf.txt
@@
-foo
+FOO
*** End Patch`);

		const bytes = await readFile(join(cwd, "crlf.txt"));
		expect(bytes.toString("utf8")).toBe("FOO\r\nbar\r\n");
	});

	test("rejects binary-ish files when expected text lines cannot be found", async () => {
		await writeFile(join(cwd, "bin.dat"), Buffer.from([0, 1, 97, 98, 99, 10]));

		await expectRejectsWith(`*** Begin Patch
*** Update File: bin.dat
@@
-abc
+ABC
*** End Patch`, "Failed to find expected lines");
	});
});
