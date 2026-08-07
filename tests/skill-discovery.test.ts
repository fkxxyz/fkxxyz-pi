import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("experience capture skill discovery extension", () => {
	test("agent development prompt skills are part of the default preset", async () => {
		const preset = JSON.parse(await readFile(resolve("extensions/entrypoints/default-preset.json"), "utf8"));

		expect(preset.extensions).toContain("../agent-development/prompt-skills.ts");
	});

	test("discovers experience capture skill", async () => {
		const handlers: Array<() => Promise<{ skillPaths?: string[] }>> = [];
		const { default: experienceCapture } = await import(
			"../extensions/skills/experience-capture.ts"
		);

		experienceCapture({
			on(eventName: string, handler: () => Promise<{ skillPaths?: string[] }>) {
				if (eventName === "resources_discover") handlers.push(handler);
			},
		} as never);

		expect(handlers).toHaveLength(1);
		const result = await handlers[0]!();
		const skillPaths = result.skillPaths ?? [];

		expect(skillPaths).toEqual([resolve("skills/experience-capture")]);
		expect(skillPaths.every((path) => existsSync(path))).toBe(true);
	});

	test("agent development extension loads experience capture skill discovery", async () => {
		const source = await readFile(resolve("extensions/agent-development/prompt-skills.ts"), "utf8");

		expect(source).toContain('await load("../skills/experience-capture.ts");');
	});
});

describe("tool prompt authoring skill discovery extension", () => {
	test("discovers tool prompt authoring skill", async () => {
		const handlers: Array<() => Promise<{ skillPaths?: string[] }>> = [];
		const { default: toolPromptAuthoring } = await import(
			"../extensions/skills/tool-prompt-authoring.ts"
		);

		toolPromptAuthoring({
			on(eventName: string, handler: () => Promise<{ skillPaths?: string[] }>) {
				if (eventName === "resources_discover") handlers.push(handler);
			},
		} as never);

		expect(handlers).toHaveLength(1);
		const result = await handlers[0]!();
		const skillPaths = result.skillPaths ?? [];

		expect(skillPaths).toEqual([resolve("skills/tool-prompt-authoring")]);
		expect(skillPaths.every((path) => existsSync(path))).toBe(true);
	});

	test("agent development extension loads tool prompt authoring skill discovery", async () => {
		const source = await readFile(resolve("extensions/agent-development/prompt-skills.ts"), "utf8");

		expect(source).toContain('await load("../skills/tool-prompt-authoring.ts");');
	});
});

describe("structured delegation skill discovery extension", () => {
	test("discovers structured delegation skill", async () => {
		const handlers: Array<() => Promise<{ skillPaths?: string[] }>> = [];
		const { default: structuredDelegation } = await import(
			"../extensions/code/agents/structured-delegation.ts"
		);

		structuredDelegation({
			on(eventName: string, handler: () => Promise<{ skillPaths?: string[] }>) {
				if (eventName === "resources_discover") handlers.push(handler);
			},
		} as never);

		expect(handlers).toHaveLength(1);
		const result = await handlers[0]!();
		const skillPaths = result.skillPaths ?? [];

		expect(skillPaths).toEqual([resolve("skills/structured-delegation")]);
		expect(skillPaths.every((path) => existsSync(path))).toBe(true);
	});

	test("code extension loads structured delegation skill discovery", async () => {
		const source = await readFile(resolve("extensions/code/agents/agents.ts"), "utf8");

		expect(source).toContain('await load("./structured-delegation.ts");');
	});
});
