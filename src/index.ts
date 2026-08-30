import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler } from "agents/mcp";
import { Env, CallerProfile } from "./types";
import {
  resolveCallerProfile,
  enforceRateLimit,
  checkToolAccess,
  isToolPaymentRequired,
  ROLE_QUOTAS,
} from "./auth";
import { allTools, registerAllTools, generateOpenAPISpec } from "./tools";
import { createPaymentRequirement, verifyPayment } from "./x402-config";

function createServer(env: Env, caller: CallerProfile) {
  const server = new McpServer({
    name: "lokha-mcp-gateway",
    version: "2.0.0",
  });
  registerAllTools(server, env, caller);
  return server;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, X-API-Key, Accept, mcp-session-id, x-payment, x-payment-authorization, payment-authorization, X-Lokha-Member-Key, X-Lokha-Key, X-Lokha-Email",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, X-402-REQUIREMENT, X-RateLimit-Limit, X-RateLimit-Remaining",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // 2. Resolve caller profile
    let body: any = null;
    if (request.method === "POST" && !url.pathname.startsWith("/sse") && !url.pathname.startsWith("/mcp")) {
      try {
        const text = await request.text();
        if (text && text.trim().length > 0) {
          body = JSON.parse(text);
        }
      } catch {
        body = null;
      }
    }

    // 2. Favicon & Brand Asset Routing
    if (url.pathname === "/favicon.ico" || url.pathname === "/logo.png" || url.pathname === "/icon.png") {
      return Response.redirect("https://lokha.today/logo-2.png", 302);
    }

    const caller = await resolveCallerProfile(request, env, body);
    const roleInfo = ROLE_QUOTAS[caller.role] || ROLE_QUOTAS.anonymous;

    // 3. Public Health & Dynamic Role Dashboard (/)
    if (url.pathname === "/" || url.pathname === "/health") {
      const allowedTools = caller.isOwner
        ? allTools
        : allTools.filter((t) => t.scope !== "private");

      const freeTools = allowedTools
        .filter((t) => !isToolPaymentRequired(t, caller))
        .map((t) => t.name);

      const paidTools = allowedTools
        .filter((t) => isToolPaymentRequired(t, caller))
        .map((t) => ({
          name: t.name,
          priceUSD: t.priceUSD,
        }));

      return new Response(
        JSON.stringify(
          {
            status: "active",
            name: "lokha-mcp-gateway",
            version: "2.0.0",
            icon: "https://lokha.today/logo-2.png",
            icons: [
              {
                src: "https://lokha.today/logo-2.png",
                sizes: "512x512",
                type: "image/png",
              },
              {
                src: "https://lokha.today/logo.png",
                sizes: "110x110",
                type: "image/png",
              },
            ],
            website: "https://lokha.today",
            docs: "https://lokha.today/docs",
            caller: {
              id: caller.id,
              email: caller.email || "anonymous",
              username: caller.username || "guest",
              name: caller.name || "Guest Reader",
              role: caller.role,
              positionTitle: roleInfo.title,
              isPaidMember: caller.isPaid,
              isAgent: caller.isAgent,
            },
            privileges: {
              roleDescription: roleInfo.description,
              isOwner: caller.isOwner,
              isCurator: caller.isCurator,
              isAuthor: caller.isAuthor,
              freeStoryUnlocks: caller.isPaid || caller.isCurator || caller.isOwner,
              freeDraftSubmissions: caller.isAuthor || caller.isCurator || caller.isOwner || caller.isPaid,
              infrastructureToolsAccess: caller.isOwner,
            },
            quotas: {
              dailyLimit: caller.dailyLimit,
              usedToday: caller.usedToday,
              remainingToday: Math.max(0, caller.dailyLimit - caller.usedToday),
              hourlyLimit: caller.hourlyLimit,
              usedThisHour: caller.usedThisHour,
              remainingThisHour: Math.max(0, caller.hourlyLimit - caller.usedThisHour),
            },
            monetization: {
              protocol: "x402",
              network: env.X402_NETWORK || "eip155:84532 (Base Sepolia)",
              facilitator: env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
              recipient: env.PAYMENT_RECIPIENT_ADDRESS || "0x644627d3E63e1fD567634f19e7195f269a941E55",
            },
            toolsSummary: {
              totalAvailable: allowedTools.length,
              freeForYourRole: freeTools,
              paidForYourRole: paidTools,
            },
            endpoints: {
              mcp: `${url.origin}/mcp`,
              sse: `${url.origin}/sse`,
              openapi: `${url.origin}/openapi.json`,
              restApi: `${url.origin}/api/tools/:tool_name`,
            },
          },
          null,
          2
        ),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // 4. OpenAPI 3.1 Spec Endpoint (/openapi.json)
    if (url.pathname === "/openapi.json") {
      const spec = generateOpenAPISpec(url.origin, caller);
      return new Response(JSON.stringify(spec, null, 2), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    // 5. REST API Execution Bridge (/api/tools/:name)
    if (url.pathname.startsWith("/api/tools/")) {
      const toolName = url.pathname.replace("/api/tools/", "").trim();
      const tool = allTools.find((t) => t.name === toolName);

      if (!tool) {
        return new Response(
          JSON.stringify({ error: `Tool '${toolName}' not found` }),
          {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }

      // 5a. Check Role Authorization
      const access = checkToolAccess(tool, caller);
      if (!access.allowed) {
        const isAuthError = tool.requiredRole === "member" && caller.role === "anonymous";
        return new Response(
          JSON.stringify({
            error: isAuthError ? "Authentication Required" : "Forbidden",
            message: access.reason,
            currentRole: caller.role,
            requiredRole: tool.requiredRole || (tool.scope === "private" ? "owner" : "member"),
            registrationUrl: "https://lokha.today/login",
          }),
          {
            status: isAuthError ? 401 : 403,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }

      // 5b. Enforce Rate Limit
      const rateCheck = enforceRateLimit(caller);
      if (!rateCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: "Rate Limit Exceeded",
            message: rateCheck.reason,
            currentRole: caller.role,
            dailyLimit: caller.dailyLimit,
            hourlyLimit: caller.hourlyLimit,
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Limit": String(caller.dailyLimit),
              "X-RateLimit-Remaining": "0",
              ...corsHeaders,
            },
          }
        );
      }

      // 5c. Check x402 Micropayment Requirement
      const paymentRequired = isToolPaymentRequired(tool, caller);
      if (paymentRequired) {
        const reqSpec = createPaymentRequirement(tool.name, tool.priceUSD || 0.05, env);
        const paymentCheck = await verifyPayment(request, reqSpec, env);

        if (!paymentCheck.valid) {
          return new Response(
            JSON.stringify(
              {
                error: "Payment Required",
                message: `This tool (${tool.name}) requires payment of $${tool.priceUSD?.toFixed(2)} USDC via x402 protocol, or upgrade your account on lokha.today.`,
                requirement: reqSpec,
                callerRole: caller.role,
                howToExempt: "Paid subscribers, Resident Authors, Resident Curators, and Owners receive free access.",
              },
              null,
              2
            ),
            {
              status: 402,
              headers: {
                "Content-Type": "application/json",
                "PAYMENT-REQUIRED": JSON.stringify(reqSpec),
                "X-402-REQUIREMENT": JSON.stringify(reqSpec),
                ...corsHeaders,
              },
            }
          );
        }
      }

      // 5d. Execute Tool Handler
      try {
        const result = await tool.handler(body || {}, env, {
          isPaid: paymentRequired,
          isAdmin: caller.isOwner,
          memberKey: caller.memberKey,
          caller,
        });

        return new Response(JSON.stringify(result, null, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(caller.dailyLimit),
            "X-RateLimit-Remaining": String(rateCheck.remainingDaily),
            ...corsHeaders,
          },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err.message || String(err) }),
          {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }
    }

    // 6. MCP Protocol Handler (/mcp, /sse)
    const mcpServer = createServer(env, caller);
    const handler = createLegacyMcpHandler(mcpServer, {
      route: url.pathname.startsWith("/sse") ? "/sse" : "/mcp",
    });

    const response = await handler(request, env as any, ctx);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
