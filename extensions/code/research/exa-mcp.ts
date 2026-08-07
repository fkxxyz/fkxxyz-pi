import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  hasPersonalConfigParseError,
  readPersonalConfig,
  warnInvalidPersonalConfig,
  warnMissingPersonalConfig,
  warnMissingPersonalConfigValue,
} from "../../base/personal-config.ts";

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toTypeBoxSchema(schema: unknown) {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as any;
  }
  return Type.Object({});
}

function stringifyMcpContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return String(part);
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.data === "string") return p.data;
      if (typeof p.url === "string") return p.url;
      return JSON.stringify(p, null, 2);
    })
    .join("\n\n");
}

export default async function exaMcpExtension(pi: ExtensionAPI) {
  const config = readPersonalConfig();
  if (!config) {
    if (hasPersonalConfigParseError()) warnInvalidPersonalConfig("Exa MCP");
    else warnMissingPersonalConfig("Exa MCP");
    return;
  }

  const mcpUrl = config.exaMcp?.url;
  if (!mcpUrl) {
    warnMissingPersonalConfigValue("Exa MCP", "exaMcp.url");
    return;
  }

  const client = new Client({ name: "pi-exa", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  await client.connect(transport);

  const toolsResult = await client.listTools();
  const mcpTools = (toolsResult.tools ?? []) as McpTool[];

  for (const mcpTool of mcpTools) {
    const piToolName = sanitizeToolName(mcpTool.name);

    pi.registerTool({
      name: piToolName,
      label: piToolName,
      description: `[Exa MCP] ${mcpTool.description ?? mcpTool.name}`,
      promptSnippet: `Use Exa MCP tool ${piToolName} for web search and content discovery.`,
      promptGuidelines: [
        "Use Exa tools to search the web and gather sources before answering questions that need current or external information.",
        "When using web results, synthesize findings and cite source URLs when available.",
      ],
      parameters: toTypeBoxSchema(mcpTool.inputSchema),
      async execute(_toolCallId, params, signal) {
        if (signal?.aborted) throw new Error("aborted");

        const result = await client.callTool(
          {
            name: mcpTool.name,
            arguments: params as Record<string, unknown>,
          },
          undefined,
          { signal },
        );

        return {
          content: [
            {
              type: "text",
              text: stringifyMcpContent(result.content),
            },
          ],
          details: {
            mcpServer: mcpUrl,
            mcpTool: mcpTool.name,
          },
        };
      },
    });
  }

  pi.on("session_shutdown", async () => {
    await client.close();
  });
}
