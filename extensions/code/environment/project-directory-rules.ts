import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	hasPersonalConfigParseError,
	readPersonalConfig,
	warnInvalidPersonalConfig,
	warnMissingPersonalConfig,
	warnMissingPersonalConfigValue,
} from "../../../base/personal-config.ts";

function projectDirectoryContext(options: {
	thirdPartyRepos: string;
	thirdPartyRepoExample?: string;
	personalProjects: string;
	personalProjectExample?: string;
}) {
	const thirdPartyExample = options.thirdPartyRepoExample
		? `\n  - Example: \`${options.thirdPartyRepoExample}\``
		: "";
	const personalExample = options.personalProjectExample
		? `\n  - Example: \`${options.personalProjectExample}\``
		: "";

	return `## Personal Project Directory Rules

Use these directory rules when creating or cloning projects so agent behavior matches the user's own organization habits and does not clutter the home directory or arbitrary temporary locations.

- Third-party repositories belong under \`${options.thirdPartyRepos}\`.${thirdPartyExample}
- Personal projects belong under \`${options.personalProjects}\`.${personalExample}

Do not invent a new project location when one of these categories applies. If the category is unclear, ask before creating or cloning.`;
}

export default function projectDirectoryRules(pi: ExtensionAPI) {
	const config = readPersonalConfig();
	if (!config) {
		if (hasPersonalConfigParseError()) warnInvalidPersonalConfig("Personal project directory rules");
		else warnMissingPersonalConfig("Personal project directory rules");
		return;
	}

	const projectDirectories = config.projectDirectories;
	if (!projectDirectories?.thirdPartyRepos) {
		warnMissingPersonalConfigValue("Personal project directory rules", "projectDirectories.thirdPartyRepos");
		return;
	}
	if (!projectDirectories.personalProjects) {
		warnMissingPersonalConfigValue("Personal project directory rules", "projectDirectories.personalProjects");
		return;
	}

	const context = projectDirectoryContext({
		thirdPartyRepos: projectDirectories.thirdPartyRepos,
		thirdPartyRepoExample: projectDirectories.thirdPartyRepoExample,
		personalProjects: projectDirectories.personalProjects,
		personalProjectExample: projectDirectories.personalProjectExample,
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${context}`,
		};
	});
}
