import { z } from "zod";
import { Env, ToolDefinition } from "../types";

export const lokhaPaidTools: ToolDefinition[] = [
  {
    name: "lokha_read_premium_story",
    description: "Unlock and read the complete unabridged text of a members-only essay or story on lokha.today (Free for Owners, Curators, Authors & Paid Members; $0.05 USDC via x402 for Free Tier).",
    scope: "public",
    tier: "paid",
    priceUSD: 0.05,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "subscriber_paid"],
    schema: {
      slugOrId: z.string().describe("The story slug or numerical ID on lokha.today"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      { slugOrId }: { slugOrId: string; memberKey?: string; email?: string },
      env: Env,
      context?: { isPaid?: boolean; payer?: string; memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const apiKey = env.LOKHA_API_KEY;
      const caller = context?.caller;
      const isExempt = !context?.isPaid && (caller?.isOwner || caller?.isCurator || caller?.isPaid || caller?.isAuthor);

      try {
        const headers: Record<string, string> = {
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetch(`${baseUrl}/api/posts/${slugOrId}`, { headers });
        if (!res.ok) {
          throw new Error(`Failed to fetch story: HTTP ${res.status}`);
        }

        const post = (await res.json()) as any;
        return {
          tier: "paid",
          accessStatus: isExempt ? "granted_via_role_membership" : "unlocked_via_x402_micropayment",
          costUSD: isExempt ? 0.00 : 0.05,
          callerRole: caller?.role || "subscriber",
          payer: context?.payer || caller?.email || "autonomous-agent",
          story: {
            id: post.id,
            slug: post.slug,
            title: post.title,
            tags: post.tags,
            author: post.author?.name || post.author?.username || "Author",
            publishedAt: post.publishedAt,
            membersOnly: post.membersOnly,
            content: post.content || post.body || "Story content available.",
          },
        };
      } catch (err: any) {
        return {
          error: `Error unlocking story '${slugOrId}'`,
          message: err.message || String(err),
        };
      }
    },
  },
  {
    name: "lokha_submit_draft",
    description: "Submit a new article draft directly to the Lokha.today Writer Studio for editorial review (Free for Owners, Curators, Authors & Paid Members; 1 free/day or $0.10 USDC via x402 for Free Tier).",
    scope: "public",
    tier: "paid",
    priceUSD: 0.10,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "subscriber_paid"],
    schema: {
      title: z.string().min(3).describe("Title of the article"),
      content: z.string().min(20).describe("Full Markdown or HTML content of the article"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'Decentralization, AI, Crypto')"),
      excerpt: z.string().optional().describe("Short 1-2 sentence preview summary"),
      membersOnly: z.boolean().optional().default(false).describe("Whether the article should be paywalled/members only"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      {
        title,
        content,
        tags = "",
        excerpt = "",
        membersOnly = false,
      }: {
        title: string;
        content: string;
        tags?: string;
        excerpt?: string;
        membersOnly?: boolean;
        memberKey?: string;
        email?: string;
      },
      env: Env,
      context?: { isPaid?: boolean; payer?: string; memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const apiKey = env.LOKHA_API_KEY;
      const caller = context?.caller;
      const isExempt = !context?.isPaid && (caller?.isOwner || caller?.isCurator || caller?.isAuthor || caller?.isPaid);

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetch(`${baseUrl}/api/posts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title,
            content,
            tags,
            excerpt,
            membersOnly,
            status: "draft",
            authorEmail: caller?.email,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Failed to submit draft: HTTP ${res.status} - ${errText}`);
        }

        const result = (await res.json()) as any;
        return {
          status: "submitted",
          tier: "paid",
          submissionStatus: isExempt ? "free_role_quota" : "unlocked_via_x402_micropayment",
          costUSD: isExempt ? 0.00 : 0.10,
          callerRole: caller?.role || "subscriber",
          payer: context?.payer || caller?.email || "writer",
          post: {
            id: result.id || result.post?.id,
            title,
            status: "draft",
            editorStudioUrl: `${baseUrl}/dashboard`,
            previewUrl: result.slug ? `${baseUrl}/posts/${result.slug}` : undefined,
          },
          message: "Your story draft has been submitted to Lokha Writer Studio! Resident Curators and Editors will review it.",
        };
      } catch (err: any) {
        return {
          error: "Failed to submit draft to lokha.today",
          message: err.message || String(err),
        };
      }
    },
  },
];
