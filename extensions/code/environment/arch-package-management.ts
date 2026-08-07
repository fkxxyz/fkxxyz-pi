import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SYSTEM_PACKAGE_MANAGER_CONTEXT = `## Local System Package Management

This environment is Arch Linux. When a task requires installing missing system packages or development dependencies, prefer the native Arch tooling: \`pacman\` for repository packages and \`yay\` for AUR packages.

Passwordless sudo is available for package installation. Treat that as support for dependency setup, not as blanket permission to make unrelated system-level changes.`;

export default function archPackageManagement(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PACKAGE_MANAGER_CONTEXT}`,
		};
	});
}
