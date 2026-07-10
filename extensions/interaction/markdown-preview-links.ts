import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	hasPersonalConfigParseError,
	readPersonalConfig,
	warnInvalidPersonalConfig,
	warnMissingPersonalConfig,
	warnMissingPersonalConfigValue,
} from "../base/personal-config.ts";

function markdownPreviewContext(baseUrl: string) {
	return `## Markdown Preview Links

The user usually interacts with the agent from a browser. When you create or modify a Markdown file, include a clickable preview link so the user can quickly inspect the rendered result.

Preview link format:
\`${baseUrl}?path=/absolute/path/to/file.md\`

Use the absolute path of each created or modified \`.md\` file. Present the URL as a Markdown link when practical.`;
}

export default function markdownPreviewLinks(pi: ExtensionAPI) {
	const config = readPersonalConfig();
	if (!config) {
		if (hasPersonalConfigParseError()) warnInvalidPersonalConfig("Markdown preview links");
		else warnMissingPersonalConfig("Markdown preview links");
		return;
	}

	const baseUrl = config.markdownPreview?.baseUrl;
	if (!baseUrl) {
		warnMissingPersonalConfigValue("Markdown preview links", "markdownPreview.baseUrl");
		return;
	}

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${markdownPreviewContext(baseUrl)}`,
		};
	});
}
