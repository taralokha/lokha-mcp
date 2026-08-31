import { z } from "zod";
import { Env, ToolDefinition } from "../types";
import { fetchLokha } from "./http";

export const lokhaSocialTools: ToolDefinition[] = [
  {
    name: "lokha_get_social_providers",
    description:
      "Inspect connected social syndication providers (Buffer & Zernio) and view active social channels/accounts for the authenticated user or agent (Free for Authors, Curators, Owners).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      memberKey: z
        .string()
        .optional()
        .describe("Your Lokha Member API Key (or pass in Authorization header)"),
    },
    handler: async (
      args: { memberKey?: string },
      env: Env,
      context?: { caller?: any; memberKey?: string }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const caller = context?.caller;
      const effectiveKey = args?.memberKey || context?.memberKey || caller?.memberKey || env.LOKHA_API_KEY;

      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "Lokha-MCP-Gateway/1.0",
      };
      if (effectiveKey) {
        headers["Authorization"] = `Bearer ${effectiveKey}`;
      }

      try {
        const res = await fetchLokha(env, `${baseUrl}/api/social/providers`, {
          method: "GET",
          headers,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Failed to fetch social providers (${res.status}): ${errText}`);
        }

        const data = await res.json();
        return data;
      } catch (err: any) {
        return {
          ok: false,
          error: err.message || "Failed to inspect social providers",
        };
      }
    },
  },
  {
    name: "lokha_connect_social_provider",
    description:
      "Connect, test, or update a social syndication provider credential (Buffer Access Token or Zernio API Key) for your Lokha account.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      provider: z
        .enum(["buffer", "zernio"])
        .describe("Provider to connect: 'buffer' (Buffer Access Token) or 'zernio' (Zernio API Key)"),
      token: z
        .string()
        .describe("The secret API key or access token from the provider"),
      memberKey: z
        .string()
        .optional()
        .describe("Your Lokha Member API Key (or pass in Authorization header)"),
    },
    handler: async (
      { provider, token, memberKey }: { provider: "buffer" | "zernio"; token: string; memberKey?: string },
      env: Env,
      context?: { caller?: any; memberKey?: string }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const caller = context?.caller;
      const effectiveKey = memberKey || context?.memberKey || caller?.memberKey || env.LOKHA_API_KEY;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Lokha-MCP-Gateway/1.0",
      };
      if (effectiveKey) {
        headers["Authorization"] = `Bearer ${effectiveKey}`;
      }

      try {
        const res = await fetchLokha(env, `${baseUrl}/api/social/providers`, {
          method: "POST",
          headers,
          body: JSON.stringify({ provider, token }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data?.error || `Failed to connect ${provider}`);
        }

        return data;
      } catch (err: any) {
        return {
          ok: false,
          error: err.message || `Failed to connect ${provider}`,
        };
      }
    },
  },
  {
    name: "lokha_broadcast_to_socials",
    description:
      "Autonomously syndicate a published Lokha article or announcement across connected Buffer channels and the Zernio 16+ multi-network social graph.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      slugOrId: z
        .string()
        .describe("The slug or numerical ID of the published Lokha post to syndicate"),
      customText: z
        .string()
        .optional()
        .describe("Optional custom viral text/hook to broadcast instead of auto-generated excerpt"),
      providers: z
        .array(z.enum(["buffer", "zernio"]))
        .optional()
        .describe("Optional list of specific providers to broadcast to (defaults to all connected)"),
      memberKey: z
        .string()
        .optional()
        .describe("Your Lokha Member API Key (or pass in Authorization header)"),
    },
    handler: async (
      {
        slugOrId,
        customText,
        providers,
        memberKey,
      }: {
        slugOrId: string;
        customText?: string;
        providers?: ("buffer" | "zernio")[];
        memberKey?: string;
      },
      env: Env,
      context?: { caller?: any; memberKey?: string }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const caller = context?.caller;
      const effectiveKey = memberKey || context?.memberKey || caller?.memberKey || env.LOKHA_API_KEY;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Lokha-MCP-Gateway/1.0",
      };
      if (effectiveKey) {
        headers["Authorization"] = `Bearer ${effectiveKey}`;
      }

      const isNumeric = /^\d+$/.test(slugOrId);
      const payload: Record<string, any> = {
        customText,
        providers,
      };
      if (isNumeric) payload.postId = parseInt(slugOrId, 10);
      else payload.slug = slugOrId;

      try {
        const res = await fetchLokha(env, `${baseUrl}/api/social/broadcast`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data?.error || "Failed to broadcast to socials");
        }

        return data;
      } catch (err: any) {
        return {
          ok: false,
          error: err.message || "Failed to broadcast to socials",
        };
      }
    },
  },
];
