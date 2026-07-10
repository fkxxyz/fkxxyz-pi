import { formatSkillsForPrompt, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_TOOL_NAMES = new Set(["image_gen", "imagegen"]);

function disableImageGenerationTools(pi: ExtensionAPI): void {
	const activeTools = pi.getActiveTools();
	const filteredTools = activeTools.filter((name) => !DISABLED_TOOL_NAMES.has(name));

	if (filteredTools.length !== activeTools.length) {
		pi.setActiveTools(filteredTools);
	}
}

export default function simplifySystemPrompt(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		disableImageGenerationTools(pi);
	});

	pi.on("tool_call", async (event) => {
		if (DISABLED_TOOL_NAMES.has(event.toolName)) {
			return { block: true, reason: "Image generation is disabled globally." };
		}
	});

	pi.on("before_agent_start", async (event) => {
		disableImageGenerationTools(pi);

		const cwd = event.systemPromptOptions.cwd;
		const append = event.systemPromptOptions.appendSystemPrompt?.trim();
		let systemPrompt = `This conversation is taking place inside pi, a local agent harness, with the current working directory set to ${cwd}.`;

		const skillsPrompt = formatSkillsForPrompt(event.systemPromptOptions.skills ?? []);
		if (skillsPrompt) {
			systemPrompt += skillsPrompt;
		}

		if (append) {
			systemPrompt += `\n\n${append}`;
		}

		return { systemPrompt };
	});
}
