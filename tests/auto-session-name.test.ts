import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
	findFirstUserMessageText,
	getAutoSessionNameConfig,
	isAutoSessionNameConfigured,
} from "../extensions/session/auto-session-name-core.ts";

describe("auto session name extension", () => {
	test("treats missing title model config as disabled", () => {
		expect(isAutoSessionNameConfigured({})).toBe(false);
		expect(getAutoSessionNameConfig({})).toBeNull();
	});

	test("reads title provider and model from personal config", () => {
		const config = getAutoSessionNameConfig({
			autoSessionName: {
				provider: "openai",
				model: "gpt-5.2-mini",
			},
		});

		expect(config).toEqual({ provider: "openai", model: "gpt-5.2-mini" });
	});

	test("registers input and session_start handlers", async () => {
		const source = await readFile(resolve("extensions/session/auto-session-name.ts"), "utf8");

		expect(source).toContain('pi.on("input"');
		expect(source).toContain('pi.on("session_start"');
		expect(source).toContain('ctx.modelRegistry.find(config.provider, config.model)');
		expect(source).toContain('if (!config) return;');
	});

	test("extracts the first user message from existing session entries", () => {
		expect(
			findFirstUserMessageText([
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我修标题" }] } },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "第二条" }] } },
			]),
		).toBe("帮我修标题");
	});

	test("loads the extension from the default preset", async () => {
		const preset = JSON.parse(
			await readFile(resolve("extensions/entrypoints/default-preset.json"), "utf8"),
		);

		expect(preset.extensions).toContain("../session/auto-session-name.ts");
	});
});
