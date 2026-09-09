import { z } from "zod";
import { Env, ToolDefinition } from "../types";
import { fetchLokha } from "./http";

function cleanCoverImage(input?: string | null): string {
  if (!input) return "";
  let clean = input.trim();
  const mdMatch = clean.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/i);
  if (mdMatch) clean = mdMatch[1];
  const htmlMatch = clean.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (htmlMatch) clean = htmlMatch[1];
  clean = clean.replace(/^[<"'\s(]+|[>"'\s)]+$/g, "").trim();
  return /^https?:\/\//i.test(clean) ? clean : "";
}

function extractFirstImage(content?: string | null): string {
  if (!content) return "";
  const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s\)"']+)[^)]*\)/i);
  if (mdMatch) return mdMatch[1];
  const htmlMatch = content.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (htmlMatch) return htmlMatch[1];
  return "";
}

function stripDuplicateCover(content: string, coverImage?: string | null): string {
  if (!content || !coverImage) return content;
  const cleanCover = cleanCoverImage(coverImage);
  if (!cleanCover) return content;
  const baseCover = cleanCover.split(/[?#]/)[0].replace(/\/+$/, "").replace(/^https?:\/\//i, "");
  const gMatch = cleanCover.match(/(?:\/d\/|id=)([a-zA-Z0-9_-]{15,})/);

  const matchesCover = (url: string) => {
    if (!url) return false;
    const cleanUrl = url.trim().replace(/^https?:\/\//i, "").replace(/&amp;/g, "&");
    if (cleanUrl === cleanCover.replace(/^https?:\/\//i, "")) return true;
    const base = cleanUrl.split(/[?#]/)[0].replace(/\/+$/, "");
    if (base && base === baseCover) return true;
    if (gMatch) {
      const gm = cleanUrl.match(/(?:\/d\/|id=)([a-zA-Z0-9_-]{15,})/);
      if (gm && gm[1] === gMatch[1]) return true;
    }
    return false;
  };

  let result = content;
  result = result.replace(
    /<(?:p|figure)[^>]*>\s*<img[^>]+src=["']([^"']+)["'][^>]*\/?>\s*<\/(?:p|figure)>/gi,
    (m, src) => (matchesCover(src) ? "" : m)
  );
  result = result.replace(/<img[^>]+src=["']([^"']+)["'][^>]*\/?>/gi, (m, src) =>
    matchesCover(src) ? "" : m
  );
  result = result.replace(
    /\[\s*!\[.*?\]\((https?:\/\/[^\s\)"']+)(?:[^\)]*)\)\s*\]\([^\)]+\)/gi,
    (m, src) => (matchesCover(src) ? "" : m)
  );
  result = result.replace(
    /!\[.*?\]\((https?:\/\/[^\s\)"']+)(?:[^\)]*)\)/gi,
    (m, src) => (matchesCover(src) ? "" : m)
  );
  return result.replace(/^\s*\n+/, "").trimStart();
}

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
      args: { slugOrId: string; memberKey?: string; email?: string },
      env: Env,
      context?: { isPaid?: boolean; payer?: string; memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const caller = context?.caller;
      const effectiveKey = args.memberKey || context?.memberKey || caller?.memberKey || env.LOKHA_API_KEY;
      const isExempt = !context?.isPaid && (caller?.isOwner || caller?.isCurator || caller?.isPaid || caller?.isAuthor);

      try {
        const headers: Record<string, string> = {
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (effectiveKey) {
          headers["Authorization"] = `Bearer ${effectiveKey}`;
        }

        const res = await fetchLokha(env, `${baseUrl}/api/posts/${args.slugOrId}`, { headers });
        if (!res.ok) {
          throw new Error(`Failed to fetch story: HTTP ${res.status}`);
        }

        const data = (await res.json()) as any;
        const post = data.post || data;
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
            url: `${baseUrl}/post/${post.slug || post.id}`,
          },
        };
      } catch (err: any) {
        return {
          error: `Error unlocking story '${args.slugOrId}'`,
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
      content: z.string().min(20).describe("Full Markdown or HTML content of the article. Do NOT include the cover image inside 'content' as markdown (![]()) or HTML, because Lokha displays coverImage as the hero banner at the top of the article."),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'Decentralization, AI, Crypto')"),
      excerpt: z.string().optional().describe("Short 1-2 sentence preview summary"),
      membersOnly: z.boolean().optional().default(false).describe("Whether the article should be paywalled/members only"),
      coverImage: z.string().optional().describe("Direct HTTPS image URL for the article cover (e.g. 'https://images.unsplash.com/photo-...'). Lokha displays this at the top of the article. Do NOT use Markdown syntax or repeat it inside 'content'."),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      {
        title,
        content,
        tags = "",
        excerpt = "",
        coverImage,
        membersOnly = false,
        memberKey,
        email,
      }: {
        title: string;
        content: string;
        tags?: string;
        excerpt?: string;
        coverImage?: string;
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
      const effectiveKey = memberKey || context?.memberKey || caller?.memberKey || apiKey;
      const isExempt = !context?.isPaid && (caller?.isOwner || caller?.isCurator || caller?.isAuthor || caller?.isPaid);

      try {
        let finalCover = cleanCoverImage(coverImage);
        let finalContent = content;
        if (!finalCover) {
          finalCover = extractFirstImage(finalContent);
        }
        if (finalCover) {
          finalContent = stripDuplicateCover(finalContent, finalCover);
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (effectiveKey) {
          headers["Authorization"] = `Bearer ${effectiveKey}`;
        }

        const res = await fetchLokha(env, `${baseUrl}/api/posts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title,
            content: finalContent,
            tags,
            excerpt,
            coverImage: finalCover || undefined,
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
            previewUrl: result.slug ? `${baseUrl}/post/${result.slug}` : undefined,
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
  {
    name: "lokha_submit_article_draft",
    description: "Submit or publish a new article draft directly to Lokha (Free for Authors, Curators, Owners & Paid Members; 1 free live post/day + unlimited drafts for Free Tier).",
    scope: "public",
    tier: "paid",
    priceUSD: 0.10,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "subscriber_paid"],
    schema: {
      title: z.string().min(3).describe("Title of the article"),
      content: z.string().min(20).describe("Full Markdown or HTML content of the article. Do NOT include the cover image inside 'content' as markdown (![]()) or HTML, because Lokha displays coverImage as the hero banner at the top of the article."),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'Decentralization, AI, Crypto')"),
      excerpt: z.string().optional().describe("Short 1-2 sentence preview summary"),
      status: z.enum(["draft", "published"]).optional().default("draft").describe("Submission status: 'draft' or 'published'"),
      coverImage: z.string().optional().describe("Direct HTTPS image URL for the article cover (e.g. 'https://images.unsplash.com/photo-...'). Lokha displays this at the top of the article. Do NOT use Markdown syntax or repeat it inside 'content'."),
      autoBroadcast: z.boolean().optional().default(true).describe("Whether to automatically syndicate the post to Buffer/Zernio on publish (defaults to true)"),
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
        coverImage,
        autoBroadcast = true,
        status = "draft",
        membersOnly = false,
        memberKey,
        email,
      }: {
        title: string;
        content: string;
        tags?: string;
        excerpt?: string;
        coverImage?: string;
        autoBroadcast?: boolean;
        status?: "draft" | "published";
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
      const effectiveKey = memberKey || context?.memberKey || caller?.memberKey || apiKey;
      const isExempt = !context?.isPaid && (caller?.isOwner || caller?.isCurator || caller?.isAuthor || caller?.isPaid);

      try {
        let finalCover = cleanCoverImage(coverImage);
        let finalContent = content;
        if (!finalCover) {
          finalCover = extractFirstImage(finalContent);
        }
        if (finalCover) {
          finalContent = stripDuplicateCover(finalContent, finalCover);
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (effectiveKey) {
          headers["Authorization"] = `Bearer ${effectiveKey}`;
        }

        const res = await fetchLokha(env, `${baseUrl}/api/posts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title,
            content: finalContent,
            tags,
            excerpt,
            coverImage: finalCover || undefined,
            autoBroadcast,
            membersOnly,
            status,
            authorEmail: caller?.email,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Failed to submit article: HTTP ${res.status} - ${errText}`);
        }

        const result = (await res.json()) as any;
        return {
          status: status === "published" ? "published" : "submitted",
          tier: "paid",
          submissionStatus: isExempt ? "free_role_quota" : "unlocked_via_x402_micropayment",
          costUSD: isExempt ? 0.00 : 0.10,
          callerRole: caller?.role || "subscriber",
          payer: context?.payer || caller?.email || "writer",
          post: {
            id: result.id || result.post?.id,
            slug: result.slug || result.post?.slug,
            title,
            status,
            coverImage: result.post?.coverImage || coverImage,
            url: result.post?.url || (result.slug ? `${baseUrl}/post/${result.slug}` : undefined),
            editorStudioUrl: `${baseUrl}/dashboard`,
          },
          socialBroadcast: result.socialBroadcast || null,
          message: status === "published"
            ? "Your story is live on lokha.today!"
            : "Your story draft has been saved to Lokha Writer Studio!",
        };
      } catch (err: any) {
        return {
          error: "Failed to submit article to lokha.today",
          message: err.message || String(err),
        };
      }
    },
  },
];
