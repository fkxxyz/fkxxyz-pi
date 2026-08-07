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

export default async function markitdownMcpExtension(pi: ExtensionAPI) {
  const config = readPersonalConfig();
  if (!config) {
    if (hasPersonalConfigParseError()) warnInvalidPersonalConfig("MarkItDown MCP");
    else warnMissingPersonalConfig("MarkItDown MCP");
    return;
  }

  const mcpUrl = config.markitdownMcp?.url;
  if (!mcpUrl) {
    warnMissingPersonalConfigValue("MarkItDown MCP", "markitdownMcp.url");
    return;
  }

  const client = new Client({ name: "pi-markitdown", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  await client.connect(transport);

  const toolsResult = await client.listTools();
  const mcpTools = (toolsResult.tools ?? []) as McpTool[];

  for (const mcpTool of mcpTools) {
    const piToolName = sanitizeToolName(mcpTool.name);

    pi.registerTool({
      name: piToolName,
      label: piToolName,
      description: `[MarkItDown MCP] ${mcpTool.description ?? mcpTool.name}`,
      promptSnippet: `Use MarkItDown MCP tool ${piToolName} to convert files, URLs, PDFs, Office documents, and other supported content to Markdown or plain text.`,
      promptGuidelines: [
        "Use MarkItDown MCP when the user needs content extracted or converted from an existing file, URL, or document-like source.",
        "Do not use MarkItDown MCP for web search, source discovery, or browsing tasks; use search/browser tools instead.",
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
