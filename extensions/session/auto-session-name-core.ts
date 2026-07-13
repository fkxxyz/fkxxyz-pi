import type { PersonalConfig } from "../base/personal-config.ts";

export type AutoSessionNameConfig = {
	provider: string;
	model: string;
};

export type TextContent = {
	type: "text";
	text: string;
};

type SessionEntry = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

export function getAutoSessionNameConfig(config: PersonalConfig | null): AutoSessionNameConfig | null {
	const provider = config?.autoSessionName?.provider?.trim();
	const model = config?.autoSessionName?.model?.trim();

	if (!provider || !model) return null;

	return { provider, model };
}

export function isAutoSessionNameConfigured(config: PersonalConfig | null): boolean {
	return getAutoSessionNameConfig(config) !== null;
}

export function buildTitlePrompt(firstUserMessage: string): string {
	return [
		"Generate a concise display title for this coding-agent session.",
		"The title should help the user identify the session later in a session picker.",
		"Requirements:",
		"- 3 to 8 words",
		"- no quotes",
		"- no ending punctuation",
		"- use the same language as the user when practical",
		"- return only the title",
		"",
		"<first_user_message>",
		firstUserMessage,
		"</first_user_message>",
	].join("\n");
}

export function extractTitle(content: unknown): string {
	if (!Array.isArray(content)) return "";

	return extractTextContent(content)
		.join("\n")
		.trim()
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.replace(/[.!?。！？]+$/g, "")
		.slice(0, 80)
		.trim();
}

export function extractTextContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	return content
		.filter((part): part is TextContent => {
			return Boolean(part) && typeof part === "object" && (part as TextContent).type === "text" && typeof (part as TextContent).text === "string";
		})
		.map((part) => part.text);
}

export function findFirstUserMessageText(entries: SessionEntry[]): string | null {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;

		const text = extractTextContent(entry.message.content).join("\n").trim();
		if (text) return text;
	}

	return null;
}
