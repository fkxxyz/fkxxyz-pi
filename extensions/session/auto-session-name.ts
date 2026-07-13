import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPersonalConfig } from "../base/personal-config.ts";
import { buildTitlePrompt, extractTitle, findFirstUserMessageText, getAutoSessionNameConfig } from "./auto-session-name-core.ts";

async function generateAndSetSessionName(pi: ExtensionAPI, ctx: ExtensionContext, firstUserMessage: string, sessionFile: string | undefined) {
	const config = getAutoSessionNameConfig(readPersonalConfig());
	if (!config) return;

	const model = ctx.modelRegistry.find(config.provider, config.model);
	if (!model) return;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return;

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildTitlePrompt(firstUserMessage) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			reasoningEffort: "low",
		},
	);

	const title = extractTitle(response.content);
	if (!title) return;
	if (ctx.sessionManager.getSessionFile() !== sessionFile) return;
	if (pi.getSessionName()) return;

	pi.setSessionName(title);
}

export default function autoSessionName(pi: ExtensionAPI) {
	let started = false;

	function schedule(ctx: ExtensionContext, firstUserMessage: string) {
		if (started) return;
		if (pi.getSessionName()) return;

		const text = firstUserMessage.trim();
		if (!text || text.startsWith("/")) return;

		started = true;
		const sessionFile = ctx.sessionManager.getSessionFile();

		void generateAndSetSessionName(pi, ctx, text, sessionFile).catch(() => {
			// Session naming is opportunistic. Fail silently so it never affects chat flow.
		});
	}

	pi.on("session_start", (_event, ctx) => {
		const firstUserMessage = findFirstUserMessageText(ctx.sessionManager.getEntries());
		if (!firstUserMessage) return;

		schedule(ctx, firstUserMessage);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		if (event.streamingBehavior) return;

		schedule(ctx, event.text);
	});
}
