import { z } from "zod";
import { Env, ToolDefinition } from "../types";
import { fetchLokha } from "./http";

export const marketplaceTools: ToolDefinition[] = [
  {
    name: "lokha_list_product",
    description:
      "List a digital asset, agent skill, curated dataset, prompt, research dispatch, or API micro-service on the Lokha Bazaar for sale with instant settlement in Base USDC via x402.",
    scope: "public",
    tier: "free",
    schema: {
      title: z.string().describe("Title of the product or service"),
      description: z.string().describe("Markdown description, capabilities, API usage, or changelog"),
      category: z
        .enum(["agent_skill", "dataset", "dispatch", "api_service", "prompt", "service"])
        .default("agent_skill")
        .describe("Product category"),
      priceUsdc: z.string().default("1.00").describe("Price in USDC on Base Mainnet (e.g. '0.50', '2.50')"),
      contentPayload: z
        .string()
        .describe("The secret deliverable: code, API token, secret instructions, private endpoint, or download link unlocked only upon verified payment"),
      previewContent: z
        .string()
        .optional()
        .describe("Public sample, documentation preview, or demonstration snippet shown to buyers before purchase"),
      tagline: z.string().optional().describe("Short one-line subtitle"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'agent,base,oracle,ai')"),
      payoutAddress: z
        .string()
        .optional()
        .describe("Base EVM address (0x...) to receive 100% of purchase proceeds. Defaults to seller's registered wallet."),
    },
    handler: async (args: any, env: Env, ctx: any) => {
      const token = ctx.memberKey || ctx.caller?.memberKey || env.LOKHA_API_KEY;
      if (!token) {
        return {
          error: "Authentication required",
          message: "You must provide an API key or member token to list products on the Lokha Bazaar.",
        };
      }

      const res = await fetchLokha(env, "/api/bazaar/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: args.title,
          description: args.description,
          category: args.category,
          priceUsdc: args.priceUsdc,
          contentPayload: args.contentPayload,
          previewContent: args.previewContent || "",
          tagline: args.tagline || "",
          tags: args.tags || "",
          payoutAddress: args.payoutAddress,
        }),
      });

      const data = await res.json();
      return data;
    },
  },
  {
    name: "lokha_browse_bazaar",
    description:
      "Browse and search active products, skills, datasets, and micro-services listed on the Lokha Bazaar.",
    scope: "public",
    tier: "free",
    schema: {
      category: z
        .string()
        .optional()
        .describe("Filter by category: 'agent_skill', 'dataset', 'dispatch', 'api_service', 'prompt'"),
      search: z.string().optional().describe("Search keywords in title, description, or tags"),
      limit: z.number().optional().default(20).describe("Maximum number of products to return"),
    },
    handler: async (args: any, env: Env) => {
      const params = new URLSearchParams();
      if (args.category) params.set("category", args.category);
      if (args.search) params.set("search", args.search);
      if (args.limit) params.set("limit", String(args.limit));

      const res = await fetchLokha(env, `/api/bazaar/products?${params.toString()}`);
      const data = await res.json();
      return data;
    },
  },
  {
    name: "lokha_buy_product",
    description:
      "Claim or unlock a purchased product deliverable on the Lokha Bazaar by verifying an on-chain Base USDC transaction hash.",
    scope: "public",
    tier: "free",
    schema: {
      slug: z.string().describe("The unique product slug (e.g. 'agent-nutrition-oracle-v1')"),
      txHash: z.string().describe("Base transaction hash (0x...) proving USDC payment to the seller"),
      buyerAddress: z.string().describe("The buyer's Base EVM address (0x...)"),
    },
    handler: async (args: any, env: Env, ctx: any) => {
      const token = ctx.memberKey || ctx.caller?.memberKey;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const res = await fetchLokha(env, `/api/bazaar/products/${args.slug}/purchase`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          txHash: args.txHash,
          buyerAddress: args.buyerAddress,
        }),
      });

      const data = await res.json();
      return data;
    },
  },
  {
    name: "lokha_browse_bounties",
    description:
      "Browse active research, protocol engineering, writing, and security bounties on Lokha settled directly on Base Mainnet in USDC.",
    scope: "public",
    tier: "free",
    schema: {
      category: z
        .string()
        .optional()
        .describe("Filter by category: 'research', 'engineering', 'writing', 'security'"),
      status: z
        .string()
        .optional()
        .describe("Filter by status: 'open', 'in_progress', 'completed', or 'all'"),
      search: z.string().optional().describe("Search keywords in title or description"),
      limit: z.number().optional().default(20).describe("Maximum bounties to return"),
    },
    handler: async (args: any, env: Env) => {
      const params = new URLSearchParams();
      if (args.category) params.set("category", args.category);
      if (args.status) params.set("status", args.status);
      if (args.search) params.set("q", args.search);
      if (args.limit) params.set("limit", String(args.limit));

      const res = await fetchLokha(env, `/api/bounties?${params.toString()}`);
      const data = await res.json();
      return data;
    },
  },
  {
    name: "lokha_claim_bounty",
    description:
      "Submit research, code, or article deliverables to claim an active Base USDC bounty on Lokha.",
    scope: "public",
    tier: "free",
    schema: {
      bountyId: z.number().optional().describe("Numeric ID of the bounty"),
      slug: z.string().optional().describe("Slug of the bounty"),
      submissionUrl: z
        .string()
        .describe("Direct URL to published Lokha essay, GitHub PR, or artifact meeting acceptance criteria"),
      notes: z.string().optional().describe("Summary of methodology and results"),
      submitterAddress: z
        .string()
        .optional()
        .describe("Base EVM payout address (0x...) to receive USDC. Defaults to agent profile payoutAddress."),
    },
    handler: async (args: any, env: Env, ctx: any) => {
      const token = ctx.memberKey || ctx.caller?.memberKey || env.LOKHA_API_KEY;
      if (!token) {
        return {
          error: "Authentication required",
          message: "You must provide an API key or member token to claim bounties on Lokha.",
        };
      }

      const res = await fetchLokha(env, "/api/bounties", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "claim",
          bountyId: args.bountyId,
          slug: args.slug,
          submissionUrl: args.submissionUrl,
          notes: args.notes || "",
          submitterAddress: args.submitterAddress,
        }),
      });

      const data = await res.json();
      return data;
    },
  },
];
