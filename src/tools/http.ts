import { z } from "zod";
import { Env, ToolDefinition } from "../types";

export const httpTools: ToolDefinition[] = [
  {
    name: "http_request",
    description: "Make an external HTTP request (GET, POST, PUT, DELETE, PATCH) to any REST API or webhook (Platform Owner Tool).",
    scope: "private",
    tier: "free",
    requiredRole: "owner",
    schema: {
      url: z.string().url().describe("The full URL to send the request to"),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET").describe("HTTP method"),
      headers: z.record(z.string()).optional().describe("Optional request headers"),
      body: z.string().optional().describe("Optional request payload"),
      timeoutMs: z.number().optional().default(15000).describe("Request timeout in milliseconds (max: 30000)"),
    },
    handler: async (
      {
        url,
        method = "GET",
        headers = {},
        body,
        timeoutMs = 15000,
      }: {
        url: string;
        method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
        headers?: Record<string, string>;
        body?: string;
        timeoutMs?: number;
      },
      _env: Env
    ) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 30000));

      try {
        const response = await fetch(url, {
          method,
          headers: {
            "User-Agent": "Lokha-MCP-Gateway/1.0",
            ...headers,
          },
          body: ["GET", "HEAD"].includes(method) ? undefined : body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const contentType = response.headers.get("content-type") || "";
        let responseData: any;

        if (contentType.includes("application/json")) {
          try {
            responseData = await response.json();
          } catch {
            responseData = await response.text();
          }
        } else {
          responseData = await response.text();
        }

        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          data: responseData,
        };
      } catch (err: any) {
        clearTimeout(timeout);
        return {
          error: "HTTP Request failed",
          message: err.message || String(err),
        };
      }
    },
  },
];

/**
 * Universal Lokha fetch helper using Cloudflare Service Bindings for internal worker-to-worker dispatch
 */
export async function fetchLokha(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
  const url = path.startsWith("http") ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

  if (env.LOKHA_SERVICE) {
    try {
      const serviceReq = new Request(url, init);
      const serviceRes = await env.LOKHA_SERVICE.fetch(serviceReq);
      // Return service response if successful or a definitive client error (e.g. 400, 401, 403)
      if (serviceRes.status !== 404 && serviceRes.status !== 522 && serviceRes.status < 500) {
        return serviceRes;
      }
      console.warn(`LOKHA_SERVICE returned ${serviceRes.status}, falling back to public fetch for ${url}`);
    } catch (e) {
      console.warn("LOKHA_SERVICE fetch error, falling back to public fetch:", e);
    }
  }

  let res = await fetch(url, init);

  // If production returns 404 or 5xx for agent endpoints during staging rollout, gracefully fall back to staging
  if ((res.status === 404 || res.status >= 500) && url.includes("/api/agent/")) {
    const stageUrl = url.replace("https://lokha.today", "https://stage.lokha.today");
    try {
      const stageRes = await fetch(stageUrl, init);
      if (stageRes.status < 500) {
        return stageRes;
      }
    } catch (e) {
      console.warn("Staging fallback fetch error:", e);
    }
  }

  return res;
}
