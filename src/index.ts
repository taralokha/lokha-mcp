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
import { handleZernioWebhook } from "./zernio-webhook";

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

    // 2a. Real-time Zernio Webhook endpoint for instant social replies (<150ms return)
    if (url.pathname === "/webhook/zernio") {
      return handleZernioWebhook(request, env, ctx);
    }

    // Parse request body for POST endpoints
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

    // 2b. Dynamic Agent Trigger Webhook (/webhook/agent-trigger)
    if (url.pathname === "/webhook/agent-trigger") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const caller = await resolveCallerProfile(request, env, body);
      if (caller.role === "anonymous") {
        return new Response(
          JSON.stringify({
            error: "Registration Required",
            message: "To trigger autonomous agent execution, caller must be a registered author or agent on lokha.today.",
            registrationUrl: "https://lokha.today/login",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }

      // Asynchronous background wake task
      ctx.waitUntil(
        (async () => {
          try {
            console.log(`[Agent Trigger] Activated by @${caller.username} (${caller.role}):`, body?.event || "wake");
            if (env.LETTA_API_KEY && env.LETTA_AGENT_ID) {
              await fetch(`https://api.letta.com/v1/agents/${env.LETTA_AGENT_ID}/messages`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${env.LETTA_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  messages: [
                    {
                      role: "user",
                      content: `[Reactive Agent Trigger] Event: ${body?.event || "wake"} triggered by @${caller.username} (${caller.role}). Payload: ${JSON.stringify(body?.payload || body || {})}`,
                    },
                  ],
                }),
              });
            }
          } catch (e) {
            console.error("[Agent Trigger Error]:", e);
          }
        })()
      );

      return new Response(
        JSON.stringify({
          ok: true,
          triggered: true,
          platform: "agent-trigger",
          event: body?.event || "wake",
          caller: {
            username: caller.username,
            role: caller.role,
            isAgent: caller.isAgent,
          },
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // 2c. External Platform Webhook (/webhook/:platform)
    if (url.pathname.startsWith("/webhook/")) {
      const platform = url.pathname.replace("/webhook/", "").split("/")[0].trim();
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const caller = await resolveCallerProfile(request, env, body);
      const platformSecret = request.headers.get("X-Platform-Secret") || request.headers.get("X-Webhook-Secret");
      const isVerified = caller.role !== "anonymous" || Boolean(platformSecret && env.ZERNIO_WEBHOOK_SECRET && platformSecret === env.ZERNIO_WEBHOOK_SECRET);

      if (!isVerified && caller.role === "anonymous") {
        return new Response(
          JSON.stringify({
            error: "Registration Required",
            message: `Authentication required for platform webhook '${platform}'. Provide Authorization: Bearer lokha_<key> or platform secret.`,
            registrationUrl: "https://lokha.today/login",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }

      // Asynchronous background processing for platform event
      ctx.waitUntil(
        (async () => {
          try {
            console.log(`[Platform Webhook: ${platform}] Event received:`, body?.event || "event");
            if (env.LETTA_API_KEY && env.LETTA_AGENT_ID) {
              await fetch(`https://api.letta.com/v1/agents/${env.LETTA_AGENT_ID}/messages`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${env.LETTA_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  messages: [
                    {
                      role: "user",
                      content: `[Platform Webhook: ${platform}] Inbound event: ${body?.event || "notification"} from ${caller.username || "verified-external"}. Payload: ${JSON.stringify(body || {})}`,
                    },
                  ],
                }),
              });
            }
          } catch (e) {
            console.error(`[Platform Webhook Error - ${platform}]:`, e);
          }
        })()
      );

      return new Response(
        JSON.stringify({
          ok: true,
          received: true,
          platform,
          caller: caller.username || "verified-platform",
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
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

        // Asynchronously sync verified x402 micropayment to Lokha's unified ledger
        const platformUrl = env.LOKHA_API_URL || "https://stage.lokha.today";
        fetch(`${platformUrl}/api/payments/record`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "x402",
            amount: String(tool.priceUSD || "0.05"),
            currency: "USDC",
            transactionType: "micropayment",
            referenceId: reqSpec.nonce,
            payerIdentifier: paymentCheck.payer || "autonomous-agent",
            description: `x402 payment for ${tool.name}`,
            metadata: {
              toolName: tool.name,
              network: reqSpec.network,
              asset: reqSpec.asset,
              payer: paymentCheck.payer,
            },
            agentKey: caller.memberKey,
          }),
        }).catch((err) => console.error("[MCP] Payment sync error:", err));
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

  /**
   * Cloudflare Tail Consumer Handler
   * Intercepts unhandled worker exceptions, runtime limits (exceededCpu, exceededMemory),
   * and 500 error responses from connected workers (such as 'lokha') out-of-band.
   * Pushes deduplicated incident records directly to Turso DB system_incidents with 0ms visitor overhead.
   */
  async tail(events: TraceItem[], env: Env, ctx: ExecutionContext): Promise<void> {
    const tursoUrl = env.TURSO_DATABASE_URL || "https://lokha-db-jith.aws-ap-northeast-1.turso.io";
    const tursoToken = env.TURSO_AUTH_TOKEN;
    if (!tursoToken) return;

    for (const item of events) {
      // Ignore normal operations and intentional client cancellations (tab closed, navigation aborts)
      if (item.outcome === "ok" || item.outcome === "canceled") continue;

      const isOutcomeError = item.outcome === "exception" || item.outcome === "exceededCpu" || item.outcome === "exceededMemory";
      const fetchInfo = item.event && "response" in item.event ? item.event : null;
      const status = fetchInfo?.response?.status || 0;
      const isHttp500 = status >= 500;

      // Only record true unhandled server errors or fatal execution limits
      if (!isOutcomeError && !isHttp500) continue;

      const scriptName = item.scriptName || "lokha";
      let errorName = item.outcome;
      let errorMessage = `Worker execution error: ${item.outcome}`;
      let stackTrace = "";

      if (item.exceptions && item.exceptions.length > 0) {
        const firstEx = item.exceptions[0];
        errorName = firstEx.name || errorName;
        errorMessage = firstEx.message || errorMessage;
      }

      if (item.logs && item.logs.length > 0) {
        const errorLogs = item.logs
          .filter((l) => l.level === "error" || l.level === "warn")
          .map((l) => (typeof l.message === "object" ? JSON.stringify(l.message) : String(l.message)))
          .join("\n");
        if (errorLogs) {
          stackTrace = `${stackTrace}\n${errorLogs}`.trim();
        }
      }

      const requestUrl = fetchInfo?.request?.url || "";
      let endpoint = "";
      try {
        if (requestUrl) {
          endpoint = new URL(requestUrl).pathname;
        }
      } catch {}

      // Deterministic fingerprint calculation
      const rawSeed = `${scriptName}:${errorName}:${endpoint || "worker"}`;
      let hash = 0;
      for (let i = 0; i < rawSeed.length; i++) {
        hash = (hash << 5) - hash + rawSeed.charCodeAt(i);
        hash |= 0;
      }
      const fingerprint = `inc_${Math.abs(hash).toString(16)}_${errorName.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;

      const upsertSql = `
        INSERT INTO system_incidents (
          fingerprint, error_name, message, stack_trace, culprit_file, endpoint, environment, status, occurrences_count, last_occurred_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, 'production', 'new', 1, strftime('%s', 'now'), strftime('%s', 'now'), strftime('%s', 'now')
        )
        ON CONFLICT(fingerprint) DO UPDATE SET
          occurrences_count = system_incidents.occurrences_count + 1,
          last_occurred_at = strftime('%s', 'now'),
          updated_at = strftime('%s', 'now'),
          status = CASE WHEN system_incidents.status = 'resolved' THEN 'new' ELSE system_incidents.status END;
      `;

      ctx.waitUntil(
        (async () => {
          try {
            await fetch(`${tursoUrl}/v2/pipeline`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${tursoToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                requests: [
                  {
                    type: "execute",
                    stmt: {
                      sql: upsertSql,
                      args: [
                        { type: "text", value: fingerprint },
                        { type: "text", value: errorName },
                        { type: "text", value: errorMessage.slice(0, 1000) },
                        { type: "text", value: stackTrace.slice(0, 4000) },
                        { type: "text", value: scriptName },
                        { type: "text", value: endpoint.slice(0, 255) },
                      ],
                    },
                  },
                  { type: "close" },
                ],
              }),
            });
            console.log(`[Tail Incident Logger] Recorded incident ${fingerprint} (${errorName}) for ${scriptName}`);
          } catch (err) {
            console.error("[Tail Incident Logger] Failed to record incident in Turso:", err);
          }
        })()
      );
    }
  },
} satisfies ExportedHandler<Env>;

