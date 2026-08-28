import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Env, ToolDefinition, CallerProfile } from "../types";
import { r2Tools } from "./r2";
import { httpTools } from "./http";
import { upstreamMcpTools } from "./upstream-mcp";
import { lokhaFreeTools } from "./lokha-free";
import { lokhaPaidTools } from "./lokha-paid";
import { checkToolAccess, isToolPaymentRequired } from "../auth";

export const allTools: ToolDefinition[] = [
  ...lokhaFreeTools,
  ...lokhaPaidTools,
  ...r2Tools,
  ...httpTools,
  ...upstreamMcpTools,
];

/**
 * Registers tools onto the McpServer instance based on caller's role
 */
export function registerAllTools(server: McpServer, env: Env, caller: CallerProfile) {
  // Owners see all tools; non-owners see all non-private tools
  const toolsToRegister = caller.isOwner
    ? allTools
    : allTools.filter((t) => t.scope !== "private");

  for (const tool of toolsToRegister) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema as any,
      async (args: any) => {
        // Enforce role check
        const access = checkToolAccess(tool, caller);
        if (!access.allowed) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: access.reason || `Access denied for tool '${tool.name}'`,
              },
            ],
          };
        }

        try {
          const result = await (tool.handler as any)(args, env, {
            isAdmin: caller.isOwner,
            caller,
            memberKey: caller.memberKey,
            isPaid: isToolPaymentRequired(tool, caller),
          });

          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error executing tool '${tool.name}': ${err.message || String(err)}`,
              },
            ],
          };
        }
      }
    );
  }
}

/**
 * Generates an OpenAPI 3.1.0 schema customized for caller's role
 */
export function generateOpenAPISpec(baseUrl: string, caller: CallerProfile) {
  const paths: Record<string, any> = {};
  const toolsToExpose = caller.isOwner
    ? allTools
    : allTools.filter((t) => t.scope !== "private");

  for (const tool of toolsToExpose) {
    const isPaid = isToolPaymentRequired(tool, caller);
    const priceUSD = tool.priceUSD || 0;
    const isPrivate = tool.scope === "private";

    let badge = "PUBLIC FREE";
    if (caller.isOwner) {
      badge = "OWNER UNLIMITED";
    } else if (caller.isCurator) {
      badge = "CURATOR PRIVILEGED";
    } else if (isPrivate) {
      badge = "OWNER ONLY";
    } else if (isPaid) {
      badge = `PAID: $${priceUSD.toFixed(2)} USDC`;
    }

    paths[`/api/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: `[${badge}] ${tool.description}`,
        description: tool.description,
        requestBody: {
          required: Object.keys(tool.schema).length > 0,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: Object.fromEntries(
                  Object.entries(tool.schema).map(([key, schema]: [string, any]) => [
                    key,
                    {
                      type: schema._def?.typeName?.toLowerCase().replace("zod", "") || "string",
                      description: schema._def?.description || "",
                    },
                  ])
                ),
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Successful execution",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          "401": {
            description: "Unauthorized (Authentication required)",
          },
          "402": {
            description: "Payment Required (x402 Micropayment required for paid tool without membership)",
          },
          "403": {
            description: "Forbidden (Insufficient role privileges)",
          },
          "429": {
            description: "Too Many Requests (Role rate limit exceeded)",
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Lokha.today Role-Based MCP Gateway",
      version: "2.0.0",
      description: `Role-Aware MCP Server for lokha.today. Active caller role: '${caller.role}'.`,
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
  };
}
