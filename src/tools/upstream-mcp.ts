import { z } from "zod";
import { Env, ToolDefinition } from "../types";

/**
 * Helper to call remote MCP JSON-RPC tools over Streamable HTTP / SSE
 */
async function callRemoteMCP(
  serverUrl: string,
  authHeader: string | undefined,
  method: string,
  params: any
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (authHeader) {
    headers["Authorization"] = authHeader.startsWith("Bearer ")
      ? authHeader
      : `Bearer ${authHeader}`;
  }

  const response = await fetch(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Upstream MCP returned ${response.status}: ${errText}`);
  }

  const text = await response.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) {
    const json = JSON.parse(dataLine.replace("data: ", "").trim());
    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }
    return json.result;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }
    return parsed.result;
  } catch {
    return text;
  }
}

export const upstreamMcpTools: ToolDefinition[] = [
  {
    name: "cf_docs",
    description: "Search official Cloudflare documentation (Workers, R2, D1, KV, Queues, AI, Zero Trust, DNS, etc.) via Cloudflare Code Mode MCP (Free Discovery Tool).",
    scope: "public",
    tier: "free",
    requiredRole: "public",
    schema: {
      query: z.string().describe("Cloudflare documentation search query"),
    },
    handler: async ({ query }: { query: string }, env: Env) => {
      const token = env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        return { error: "CLOUDFLARE_API_TOKEN is not configured in environment." };
      }

      try {
        const result = await callRemoteMCP(
          "https://mcp.cloudflare.com/mcp",
          token,
          "tools/call",
          {
            name: "docs",
            arguments: { query },
          }
        );
        return result;
      } catch (err: any) {
        return { error: "Failed to query Cloudflare docs", message: err.message };
      }
    },
  },
  {
    name: "cf_search",
    description: "Search the Cloudflare OpenAPI spec for API endpoints and schemas via Cloudflare Code Mode MCP (Free Discovery Tool).",
    scope: "public",
    tier: "free",
    requiredRole: "public",
    schema: {
      query: z.string().describe("API endpoint or topic to search (e.g. 'workers', 'r2', 'dns')"),
    },
    handler: async ({ query }: { query: string }, env: Env) => {
      const token = env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        return { error: "CLOUDFLARE_API_TOKEN is not configured." };
      }

      try {
        const result = await callRemoteMCP(
          "https://mcp.cloudflare.com/mcp",
          token,
          "tools/call",
          {
            name: "search",
            arguments: { query },
          }
        );
        return result;
      } catch (err: any) {
        return { error: "Failed to search Cloudflare API spec", message: err.message };
      }
    },
  },
  {
    name: "cf_execute",
    description: "Execute JavaScript code against the Cloudflare API via Cloudflare Code Mode MCP sandbox (Platform Owner Tool).",
    scope: "private",
    tier: "free",
    requiredRole: "owner",
    schema: {
      code: z.string().describe("JavaScript code to execute against Cloudflare API"),
    },
    handler: async ({ code }: { code: string }, env: Env) => {
      const token = env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        return { error: "CLOUDFLARE_API_TOKEN is not configured." };
      }

      try {
        const result = await callRemoteMCP(
          "https://mcp.cloudflare.com/mcp",
          token,
          "tools/call",
          {
            name: "execute",
            arguments: { code },
          }
        );
        return result;
      } catch (err: any) {
        return { error: "Failed to execute Cloudflare code", message: err.message };
      }
    },
  },
  {
    name: "upstream_mcp_call",
    description: "Invoke a tool on any remote upstream MCP server (Platform Owner Tool).",
    scope: "private",
    tier: "free",
    requiredRole: "owner",
    schema: {
      serverUrl: z.string().url().describe("The upstream MCP server URL (e.g. 'https://mcp.resend.com/mcp')"),
      toolName: z.string().describe("The name of the tool to invoke on the upstream server"),
      arguments: z.record(z.any()).optional().describe("Arguments dictionary for the upstream tool"),
      authorization: z.string().optional().describe("Optional Bearer token or Authorization header for the upstream server"),
    },
    handler: async (
      {
        serverUrl,
        toolName,
        arguments: toolArgs = {},
        authorization,
      }: {
        serverUrl: string;
        toolName: string;
        arguments?: Record<string, any>;
        authorization?: string;
      },
      _env: Env
    ) => {
      try {
        const result = await callRemoteMCP(
          serverUrl,
          authorization,
          "tools/call",
          {
            name: toolName,
            arguments: toolArgs,
          }
        );
        return result;
      } catch (err: any) {
        return {
          error: `Failed to call upstream tool '${toolName}' on ${serverUrl}`,
          message: err.message,
        };
      }
    },
  },
];
