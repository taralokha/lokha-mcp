import { z } from "zod";
import { Env, ToolDefinition } from "../types";
import { fetchLokha } from "./http";

// ============================================================================
// Credential Resolution Helpers
// ============================================================================

async function resolveZernioApiKey(
  args: any,
  env: Env,
  context?: { caller?: any; memberKey?: string }
): Promise<string> {
  // 1. Explicit argument
  if (args?.apiKey || args?.zernioApiKey) {
    return String(args.apiKey || args.zernioApiKey).trim();
  }

  // 2. Environment fallback
  if (env.ZERNIO_API_KEY) {
    return env.ZERNIO_API_KEY.trim();
  }

  // 3. User account stored credentials via Lokha API
  const effectiveKey = args?.memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;
  if (effectiveKey) {
    try {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const res = await fetchLokha(env, `${baseUrl}/api/social/providers`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${effectiveKey}`,
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        },
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.providers?.zernio?.apiKey) {
          return data.providers.zernio.apiKey.trim();
        }
      }
    } catch {}
  }

  return "";
}

async function resolveBufferToken(
  args: any,
  env: Env,
  context?: { caller?: any; memberKey?: string }
): Promise<string> {
  // 1. Explicit argument
  if (args?.token || args?.bufferToken) {
    return String(args.token || args.bufferToken).trim();
  }

  // 2. Environment fallback
  if (env.BUFFER_ACCESS_TOKEN) {
    return env.BUFFER_ACCESS_TOKEN.trim();
  }

  // Default Lokha platform Buffer token fallback
  return "ctArTU_ZC3of9PwGzKffVvbdZ9u7hlimsjAdIWH1_4p";
}

// ============================================================================
// Direct Zernio API Helpers (https://zernio.com/api/v1 & api.zernio.com/v1)
// ============================================================================

async function callZernio(
  path: string,
  options: {
    method?: string;
    body?: any;
    query?: Record<string, string>;
    apiKey: string;
  }
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      error: "No Zernio API key provided. Pass 'apiKey' argument or connect your Zernio account via 'lokha_connect_social_provider'.",
    };
  }

  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const endpoints = [
    `https://zernio.com/api/v1/${cleanPath}`,
    `https://api.zernio.com/v1/${cleanPath}`,
  ];

  let lastError = "";
  let lastStatus = 500;

  for (const baseUrl of endpoints) {
    try {
      const url = new URL(baseUrl);
      if (options.query) {
        for (const [k, v] of Object.entries(options.query)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "Lokha-MCP-Gateway/1.0",
      };

      let bodyData: string | undefined;
      if (options.body && ["POST", "PUT", "PATCH"].includes(options.method || "POST")) {
        headers["Content-Type"] = "application/json";
        bodyData = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      }

      const res = await fetch(url.toString(), {
        method: options.method || "GET",
        headers,
        body: bodyData,
      });

      lastStatus = res.status;

      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        return { ok: true, status: res.status, data: json };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: res.status,
          error: "Authentication failed. Invalid Zernio API key or insufficient permissions.",
        };
      }

      const errText = await res.text();
      lastError = `Zernio returned HTTP ${res.status}: ${errText}`;
    } catch (err: any) {
      lastError = err.message || String(err);
    }
  }

  return { ok: false, status: lastStatus, error: lastError || "Failed to communicate with Zernio API." };
}

// ============================================================================
// Direct Buffer GraphQL API Helpers (https://api.buffer.com/graphql)
// ============================================================================

async function callBufferGraphQL(
  query: string,
  variables: Record<string, any> = {},
  token: string
): Promise<any> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new Error("No Buffer Access Token provided. Pass 'token' argument or configure BUFFER_ACCESS_TOKEN.");
  }

  const res = await fetch("https://api.buffer.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      "Content-Type": "application/json",
      "User-Agent": "Lokha-MCP-Gateway/1.0",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Buffer GraphQL HTTP error ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as any;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Buffer GraphQL Error: ${json.errors.map((e: any) => e.message).join("; ")}`);
  }

  return json.data;
}

// ============================================================================
// Exported MCP Tool Definitions
// ============================================================================

export const lokhaSocialTools: ToolDefinition[] = [
  // --------------------------------------------------------------------------
  // 1. Zernio: List Connected Accounts
  // --------------------------------------------------------------------------
  {
    name: "zernio_list_accounts",
    description:
      "Fetch all connected social media accounts across 16+ platforms (X/Twitter, LinkedIn, Threads, Bluesky, Instagram, TikTok, Reddit, Facebook, YouTube, etc.) managed in Zernio.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      apiKey: z
        .string()
        .optional()
        .describe("Optional Zernio API Key (uses connected or env key if omitted)"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (args: { apiKey?: string; memberKey?: string }, env: Env, context?: any) => {
      const apiKey = await resolveZernioApiKey(args, env, context);
      const res = await callZernio("accounts", { method: "GET", apiKey });

      if (!res.ok) {
        return { ok: false, error: res.error, status: res.status };
      }

      const raw = Array.isArray(res.data) ? res.data : res.data?.accounts || res.data?.data || [];
      const accounts = raw.map((acc: any) => ({
        id: String(acc.id || acc._id || acc.platformId || ""),
        platform: String(acc.platform || acc.network || acc.provider || "social").toLowerCase(),
        username: acc.username || acc.handle || acc.screen_name || null,
        displayName: acc.displayName || acc.name || null,
        avatarUrl: acc.avatarUrl || acc.profile_image_url || null,
        status: acc.status || "active",
      }));

      return {
        ok: true,
        count: accounts.length,
        accounts,
        supportedPlatforms: [
          "twitter",
          "linkedin",
          "threads",
          "bluesky",
          "instagram",
          "tiktok",
          "reddit",
          "facebook",
          "youtube",
          "pinterest",
          "mastodon",
        ],
      };
    },
  },

  // --------------------------------------------------------------------------
  // 2. Zernio: Publish, Schedule, or Draft a Post
  // --------------------------------------------------------------------------
  {
    name: "zernio_publish_post",
    description:
      "Publish, schedule, or draft a post across any connected Zernio social networks with support for platform targeting, media URLs, links, and scheduled times.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      content: z.string().describe("The post copy/text to publish"),
      platforms: z
        .array(z.string())
        .optional()
        .describe("Target platforms (e.g. ['twitter', 'linkedin', 'threads', 'bluesky']) or specific account IDs"),
      mediaUrls: z
        .array(z.string().url())
        .optional()
        .describe("Array of image or video URLs to attach"),
      linkUrl: z
        .string()
        .url()
        .optional()
        .describe("Web link to attach / preview in the post"),
      title: z
        .string()
        .optional()
        .describe("Optional title (required for platforms like Reddit or YouTube)"),
      scheduledFor: z
        .string()
        .optional()
        .describe("Optional ISO 8601 date-time string to schedule for later (e.g. '2026-09-10T14:30:00Z')"),
      publishNow: z
        .boolean()
        .optional()
        .default(true)
        .describe("Set to true to publish immediately (ignored if scheduledFor is provided)"),
      isDraft: z
        .boolean()
        .optional()
        .default(false)
        .describe("Save as draft instead of publishing or scheduling"),
      apiKey: z
        .string()
        .optional()
        .describe("Optional Zernio API Key"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: {
        content: string;
        platforms?: string[];
        mediaUrls?: string[];
        linkUrl?: string;
        title?: string;
        scheduledFor?: string;
        publishNow?: boolean;
        isDraft?: boolean;
        apiKey?: string;
        memberKey?: string;
      },
      env: Env,
      context?: any
    ) => {
      const apiKey = await resolveZernioApiKey(args, env, context);

      const payload: Record<string, any> = {
        content: args.content,
      };

      if (args.platforms && args.platforms.length > 0) {
        payload.platforms = args.platforms;
      }
      if (args.mediaUrls && args.mediaUrls.length > 0) {
        payload.media = args.mediaUrls;
        payload.mediaUrls = args.mediaUrls;
      }
      if (args.linkUrl) {
        payload.link = args.linkUrl;
        payload.linkUrl = args.linkUrl;
      }
      if (args.title) {
        payload.title = args.title;
      }

      if (args.scheduledFor) {
        payload.scheduledFor = args.scheduledFor;
        payload.publishNow = false;
      } else if (args.isDraft) {
        payload.isDraft = true;
        payload.publishNow = false;
      } else {
        payload.publishNow = args.publishNow !== false;
      }

      const res = await callZernio("posts", {
        method: "POST",
        body: payload,
        apiKey,
      });

      if (!res.ok) {
        return { ok: false, error: res.error, status: res.status };
      }

      return {
        ok: true,
        action: args.scheduledFor ? "scheduled" : args.isDraft ? "drafted" : "published",
        postId: res.data?.id || res.data?.postId || res.data?.data?.id || "zernio_post_success",
        data: res.data,
      };
    },
  },

  // --------------------------------------------------------------------------
  // 3. Zernio: Inspect Queue & Post History
  // --------------------------------------------------------------------------
  {
    name: "zernio_get_queue",
    description:
      "Inspect queued, scheduled, draft, and recently published posts in Zernio with delivery status across networks.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      status: z
        .enum(["all", "scheduled", "draft", "published"])
        .optional()
        .default("all")
        .describe("Filter queue by post status"),
      limit: z.number().optional().default(20).describe("Maximum number of posts to return"),
      apiKey: z.string().optional().describe("Optional Zernio API Key"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: { status?: "all" | "scheduled" | "draft" | "published"; limit?: number; apiKey?: string; memberKey?: string },
      env: Env,
      context?: any
    ) => {
      const apiKey = await resolveZernioApiKey(args, env, context);
      const query: Record<string, string> = {
        limit: String(args.limit || 20),
      };
      if (args.status && args.status !== "all") {
        query.status = args.status;
      }

      const res = await callZernio("posts", { method: "GET", query, apiKey });
      if (!res.ok) {
        // Fallback to queue endpoint
        const qRes = await callZernio("queue", { method: "GET", query, apiKey });
        if (qRes.ok) return qRes.data;
        return { ok: false, error: res.error, status: res.status };
      }

      return {
        ok: true,
        filter: args.status || "all",
        data: res.data,
      };
    },
  },

  // --------------------------------------------------------------------------
  // 4. Zernio: Manage Post (Get, Update, Reschedule, Delete)
  // --------------------------------------------------------------------------
  {
    name: "zernio_manage_post",
    description:
      "Retrieve details, update content, reschedule, or delete/cancel a post in Zernio by its postId.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      postId: z.string().describe("The Zernio post ID to manage"),
      action: z
        .enum(["get", "update", "delete"])
        .default("get")
        .describe("Action to perform: 'get' (fetch details), 'update' (reschedule/edit), or 'delete' (cancel/remove)"),
      content: z.string().optional().describe("New text content if updating"),
      scheduledFor: z.string().optional().describe("New ISO 8601 date-time string if rescheduling"),
      apiKey: z.string().optional().describe("Optional Zernio API Key"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: {
        postId: string;
        action?: "get" | "update" | "delete";
        content?: string;
        scheduledFor?: string;
        apiKey?: string;
        memberKey?: string;
      },
      env: Env,
      context?: any
    ) => {
      const apiKey = await resolveZernioApiKey(args, env, context);
      const action = args.action || "get";

      if (action === "get") {
        const res = await callZernio(`posts/${args.postId}`, { method: "GET", apiKey });
        return res.ok ? { ok: true, post: res.data } : { ok: false, error: res.error };
      }

      if (action === "delete") {
        const res = await callZernio(`posts/${args.postId}`, { method: "DELETE", apiKey });
        return res.ok
          ? { ok: true, message: `Post ${args.postId} successfully deleted.` }
          : { ok: false, error: res.error };
      }

      if (action === "update") {
        const body: Record<string, any> = {};
        if (args.content) body.content = args.content;
        if (args.scheduledFor) body.scheduledFor = args.scheduledFor;

        const res = await callZernio(`posts/${args.postId}`, { method: "PUT", body, apiKey });
        return res.ok ? { ok: true, post: res.data } : { ok: false, error: res.error };
      }

      return { ok: false, error: `Invalid action: ${action}` };
    },
  },

  // --------------------------------------------------------------------------
  // 5. Zernio: Analytics & Insights
  // --------------------------------------------------------------------------
  {
    name: "zernio_get_analytics",
    description:
      "Retrieve engagement analytics, impressions, clicks, shares, and reactions across connected accounts or specific posts in Zernio.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      accountId: z.string().optional().describe("Optional specific account ID to fetch metrics for"),
      postId: z.string().optional().describe("Optional specific post ID to fetch metrics for"),
      platform: z.string().optional().describe("Optional platform name filter (e.g. 'twitter', 'linkedin')"),
      apiKey: z.string().optional().describe("Optional Zernio API Key"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: { accountId?: string; postId?: string; platform?: string; apiKey?: string; memberKey?: string },
      env: Env,
      context?: any
    ) => {
      const apiKey = await resolveZernioApiKey(args, env, context);
      let path = "analytics";
      if (args.accountId) path = `accounts/${args.accountId}/analytics`;
      else if (args.postId) path = `posts/${args.postId}/analytics`;

      const query: Record<string, string> = {};
      if (args.platform) query.platform = args.platform;

      const res = await callZernio(path, { method: "GET", query, apiKey });
      return res.ok ? { ok: true, analytics: res.data } : { ok: false, error: res.error };
    },
  },

  // --------------------------------------------------------------------------
  // 6. Zernio: Universal Raw API Executor (Escape Hatch for 100% Capabilities)
  // --------------------------------------------------------------------------
  {
    name: "zernio_api_call",
    description:
      "Universal raw execution tool for the Zernio API. Allows Grok and agents to execute ANY Zernio REST endpoint (GET, POST, PUT, DELETE, PATCH on /v1/*) with full payload control.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      path: z
        .string()
        .describe("The API path relative to /v1/ (e.g. 'accounts', 'posts', 'queue', 'comments', 'analytics')"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
        .default("GET")
        .describe("HTTP Method"),
      body: z
        .record(z.any())
        .optional()
        .describe("Request JSON body (for POST, PUT, PATCH)"),
      query: z
        .record(z.string())
        .optional()
        .describe("URL query parameters"),
      apiKey: z
        .string()
        .optional()
        .describe("Optional Zernio API Key"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: {
        path: string;
        method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
        body?: Record<string, any>;
        query?: Record<string, string>;
        apiKey?: string;
        memberKey?: string;
      },
      env: Env,
      context?: any
    ) => {
      const apiKey = await resolveZernioApiKey(args, env, context);
      const res = await callZernio(args.path, {
        method: args.method || "GET",
        body: args.body,
        query: args.query,
        apiKey,
      });

      return res;
    },
  },

  // --------------------------------------------------------------------------
  // 7. Buffer: List Channels & Organizations
  // --------------------------------------------------------------------------
  {
    name: "buffer_list_channels",
    description:
      "Query connected Buffer social channels (Twitter/X, LinkedIn, Bluesky, Facebook, Instagram, Threads) with IDs, handles, and organization details.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      token: z.string().optional().describe("Optional Buffer Access Token"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (args: { token?: string; memberKey?: string }, env: Env, context?: any) => {
      const token = await resolveBufferToken(args, env, context);

      const query = `
        query GetBufferChannels {
          account {
            id
            email
            organizations {
              id
              name
            }
          }
        }
      `;

      try {
        const data = await callBufferGraphQL(query, {}, token);
        const orgs = data?.account?.organizations || [];

        const allChannels: any[] = [];
        for (const org of orgs) {
          const chQuery = `
            query GetChannels($input: ChannelsInput!) {
              channels(input: $input) {
                id
                name
                service
              }
            }
          `;
          try {
            const chData = await callBufferGraphQL(chQuery, { input: { organizationId: org.id } }, token);
            for (const ch of chData?.channels || []) {
              if (ch.service === "startPage") continue;
              allChannels.push({
                id: ch.id,
                name: ch.name,
                service: ch.service,
                organization: org.name,
              });
            }
          } catch {}
        }

        return {
          ok: true,
          accountEmail: data?.account?.email,
          count: allChannels.length,
          channels: allChannels,
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  },

  // --------------------------------------------------------------------------
  // 8. Buffer: Create, Queue, or Schedule Post
  // --------------------------------------------------------------------------
  {
    name: "buffer_create_post",
    description:
      "Create, schedule, or queue a post across Buffer channels using modern GraphQL mutations with platform constraints handling (e.g. 280-char X limits).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      text: z.string().describe("Post text content"),
      channelIds: z
        .array(z.string())
        .optional()
        .describe("Specific Buffer channel IDs to post to (broadcasts to all channels if omitted)"),
      mode: z
        .enum(["shareNow", "addToQueue", "schedule"])
        .default("shareNow")
        .describe("Publishing mode: 'shareNow' (immediate), 'addToQueue' (add to queue), or 'schedule'"),
      scheduledAt: z
        .string()
        .optional()
        .describe("ISO 8601 string if mode is 'schedule' (e.g. '2026-09-10T14:00:00Z')"),
      mediaUrl: z.string().url().optional().describe("Optional image or video URL to attach"),
      linkUrl: z.string().url().optional().describe("Optional web link to attach"),
      token: z.string().optional().describe("Optional Buffer Access Token"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: {
        text: string;
        channelIds?: string[];
        mode?: "shareNow" | "addToQueue" | "schedule";
        scheduledAt?: string;
        mediaUrl?: string;
        linkUrl?: string;
        token?: string;
        memberKey?: string;
      },
      env: Env,
      context?: any
    ) => {
      const token = await resolveBufferToken(args, env, context);

      // Resolve channels if not specified
      let targetIds = args.channelIds;
      if (!targetIds || targetIds.length === 0) {
        const listRes = await (lokhaSocialTools.find((t) => t.name === "buffer_list_channels")?.handler(
          { token },
          env,
          context
        ) as any);
        if (listRes?.ok && listRes.channels) {
          targetIds = listRes.channels.map((c: any) => c.id);
        }
      }

      if (!targetIds || targetIds.length === 0) {
        return { ok: false, error: "No connected Buffer channels found to post to." };
      }

      const mutation = `
        mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            __typename
            ... on PostActionSuccess {
              post {
                id
                status
              }
            }
            ... on InvalidInputError {
              message
            }
            ... on LimitReachedError {
              message
            }
            ... on RestProxyError {
              message
            }
            ... on UnauthorizedError {
              message
            }
            ... on UnexpectedError {
              message
            }
            ... on NotFoundError {
              message
            }
          }
        }
      `;

      const results: any[] = [];
      const errors: string[] = [];

      for (const channelId of targetIds) {
        const input: Record<string, any> = {
          channelId,
          text: args.text,
          mode: args.mode || "shareNow",
          schedulingType: args.mode === "schedule" ? "custom" : "automatic",
          needsApproval: false,
        };

        if (args.mode === "schedule" && args.scheduledAt) {
          input.dueAt = args.scheduledAt;
        }

        if (args.mediaUrl) {
          input.assets = [{ type: "image", url: args.mediaUrl }];
        }

        try {
          const data = await callBufferGraphQL(mutation, { input }, token);
          const res = data?.createPost;
          if (res?.__typename === "PostActionSuccess" && res?.post?.id) {
            results.push({ channelId, postId: res.post.id, status: res.post.status });
          } else {
            errors.push(`${channelId}: ${res?.message || "Failed to create post"}`);
          }
        } catch (err: any) {
          errors.push(`${channelId}: ${err.message}`);
        }
      }

      return {
        ok: results.length > 0,
        publishedCount: results.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
      };
    },
  },

  // --------------------------------------------------------------------------
  // 9. Buffer: Universal GraphQL Query & Mutation Escape Hatch
  // --------------------------------------------------------------------------
  {
    name: "buffer_graphql_query",
    description:
      "Execute arbitrary queries or mutations against Buffer's modern GraphQL API (https://api.buffer.com/graphql) for full control over Buffer's capabilities.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      query: z.string().describe("GraphQL query or mutation string"),
      variables: z.record(z.any()).optional().describe("Optional GraphQL variables"),
      token: z.string().optional().describe("Optional Buffer Access Token"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: { query: string; variables?: Record<string, any>; token?: string; memberKey?: string },
      env: Env,
      context?: any
    ) => {
      const token = await resolveBufferToken(args, env, context);
      try {
        const data = await callBufferGraphQL(args.query, args.variables || {}, token);
        return { ok: true, data };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  },

  // --------------------------------------------------------------------------
  // 10. Multi-Step Social Media Orchestrator (Designed for Grok & AI Agents)
  // --------------------------------------------------------------------------
  {
    name: "social_multistep_orchestrator",
    description:
      "All-in-one multi-step social coordinator designed for Grok and AI agents. Perform sequential workflows: inspect channels, generate platform-optimized copy previews, and execute multi-provider broadcasts (Buffer + Zernio) in a single tool.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      action: z
        .enum(["inspect", "preview", "broadcast", "status"])
        .describe("The workflow step: 'inspect' (discover accounts/limits), 'preview' (preview copy per platform), 'broadcast' (publish/schedule across providers), or 'status' (check queues)"),
      content: z
        .string()
        .optional()
        .describe("Post text content (required for 'preview' and 'broadcast')"),
      providers: z
        .array(z.enum(["buffer", "zernio"]))
        .optional()
        .default(["zernio", "buffer"])
        .describe("Providers to target: 'zernio', 'buffer', or both"),
      platforms: z
        .array(z.string())
        .optional()
        .describe("Specific platforms to target (e.g. ['twitter', 'linkedin', 'bluesky', 'threads', 'instagram'])"),
      scheduledFor: z
        .string()
        .optional()
        .describe("Optional ISO 8601 date string to schedule for later (e.g. '2026-09-10T14:00:00Z')"),
      mediaUrls: z
        .array(z.string().url())
        .optional()
        .describe("Optional media URLs to attach"),
      linkUrl: z
        .string()
        .url()
        .optional()
        .describe("Optional link URL to attach"),
      zernioApiKey: z.string().optional().describe("Optional custom Zernio API Key"),
      bufferToken: z.string().optional().describe("Optional custom Buffer Access Token"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: {
        action: "inspect" | "preview" | "broadcast" | "status";
        content?: string;
        providers?: ("buffer" | "zernio")[];
        platforms?: string[];
        scheduledFor?: string;
        mediaUrls?: string[];
        linkUrl?: string;
        zernioApiKey?: string;
        bufferToken?: string;
        memberKey?: string;
      },
      env: Env,
      context?: any
    ) => {
      const selectedProviders = args.providers || ["zernio", "buffer"];

      // ----------------------------------------------------------------------
      // Step A: Inspect
      // ----------------------------------------------------------------------
      if (args.action === "inspect") {
        const result: Record<string, any> = { ok: true, providers: {} };

        if (selectedProviders.includes("zernio")) {
          const zKey = await resolveZernioApiKey(args, env, context);
          const zRes = await callZernio("accounts", { method: "GET", apiKey: zKey });
          result.providers.zernio = {
            configured: Boolean(zKey),
            status: zRes.ok ? "connected" : "error",
            accountsCount: Array.isArray(zRes.data) ? zRes.data.length : zRes.data?.accounts?.length || 0,
            accounts: zRes.ok ? zRes.data : [],
            error: zRes.error,
          };
        }

        if (selectedProviders.includes("buffer")) {
          const bToken = await resolveBufferToken(args, env, context);
          try {
            const bRes = await (lokhaSocialTools.find((t) => t.name === "buffer_list_channels")?.handler(
              { token: bToken },
              env,
              context
            ) as any);
            result.providers.buffer = {
              configured: Boolean(bToken),
              status: bRes?.ok ? "connected" : "error",
              channelsCount: bRes?.channels?.length || 0,
              channels: bRes?.channels || [],
              error: bRes?.error,
            };
          } catch (e: any) {
            result.providers.buffer = { configured: false, status: "error", error: e.message };
          }
        }

        result.platformLimits = {
          twitter: { maxChars: 280, mediaTypes: ["image", "video"], supportsLinks: true },
          linkedin: { maxChars: 3000, mediaTypes: ["image", "video", "document"], supportsLinks: true },
          bluesky: { maxChars: 300, mediaTypes: ["image"], supportsLinks: true },
          threads: { maxChars: 500, mediaTypes: ["image", "video"], supportsLinks: true },
          instagram: { maxChars: 2200, mediaTypes: ["image", "video"], requiresMedia: true },
        };

        return result;
      }

      // ----------------------------------------------------------------------
      // Step B: Preview
      // ----------------------------------------------------------------------
      if (args.action === "preview") {
        const text = args.content || "";
        const link = args.linkUrl || "";

        const twitterCopy =
          text.length > 280
            ? `${text.slice(0, 270 - (link ? link.length + 5 : 0)).trim()}...${link ? `\n\n🔗 ${link}` : ""}`
            : link ? `${text}\n\n🔗 ${link}` : text;

        const previews = {
          twitter: {
            charCount: twitterCopy.length,
            withinLimit: twitterCopy.length <= 280,
            preview: twitterCopy,
          },
          linkedin: {
            charCount: text.length,
            withinLimit: text.length <= 3000,
            preview: link ? `${text}\n\nRead more: ${link}` : text,
          },
          threads: {
            charCount: text.length,
            withinLimit: text.length <= 500,
            preview: link ? `${text}\n\n${link}` : text,
          },
          bluesky: {
            charCount: text.length,
            withinLimit: text.length <= 300,
            preview: link ? `${text}\n\n${link}` : text,
          },
        };

        return {
          ok: true,
          originalContent: text,
          linkUrl: link,
          mediaCount: args.mediaUrls?.length || 0,
          scheduledFor: args.scheduledFor || "immediate",
          previews,
        };
      }

      // ----------------------------------------------------------------------
      // Step C: Broadcast
      // ----------------------------------------------------------------------
      if (args.action === "broadcast") {
        if (!args.content) {
          return { ok: false, error: "Content is required for 'broadcast' action." };
        }

        const dispatchResults: Record<string, any> = { ok: false };
        let anySuccess = false;

        // 1. Zernio broadcast
        if (selectedProviders.includes("zernio")) {
          const zPublish = lokhaSocialTools.find((t) => t.name === "zernio_publish_post");
          if (zPublish) {
            const zRes = await (zPublish.handler as any)(
              {
                content: args.content,
                platforms: args.platforms,
                mediaUrls: args.mediaUrls,
                linkUrl: args.linkUrl,
                scheduledFor: args.scheduledFor,
                publishNow: !args.scheduledFor,
                apiKey: args.zernioApiKey,
                memberKey: args.memberKey,
              },
              env,
              context
            );
            dispatchResults.zernio = zRes;
            if (zRes?.ok) anySuccess = true;
          }
        }

        // 2. Buffer broadcast
        if (selectedProviders.includes("buffer")) {
          const bPublish = lokhaSocialTools.find((t) => t.name === "buffer_create_post");
          if (bPublish) {
            const bRes = await (bPublish.handler as any)(
              {
                text: args.content,
                mode: args.scheduledFor ? "schedule" : "shareNow",
                scheduledAt: args.scheduledFor,
                mediaUrl: args.mediaUrls?.[0],
                linkUrl: args.linkUrl,
                token: args.bufferToken,
                memberKey: args.memberKey,
              },
              env,
              context
            );
            dispatchResults.buffer = bRes;
            if (bRes?.ok) anySuccess = true;
          }
        }

        dispatchResults.ok = anySuccess;
        return dispatchResults;
      }

      // ----------------------------------------------------------------------
      // Step D: Status
      // ----------------------------------------------------------------------
      if (args.action === "status") {
        const queueRes = await (lokhaSocialTools.find((t) => t.name === "zernio_get_queue")?.handler(
          { apiKey: args.zernioApiKey, memberKey: args.memberKey },
          env,
          context
        ) as any);

        return {
          ok: true,
          zernioQueue: queueRes,
        };
      }

      return { ok: false, error: `Unknown action: ${args.action}` };
    },
  },

  // --------------------------------------------------------------------------
  // 11. Upgraded: Lokha Broadcast to Socials (Both Article & Standalone)
  // --------------------------------------------------------------------------
  {
    name: "lokha_broadcast_to_socials",
    description:
      "Autonomously syndicate a published Lokha article or broadcast standalone custom copy across connected Buffer channels and Zernio multi-network accounts.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      slugOrId: z
        .string()
        .optional()
        .describe("The slug or numerical ID of a published Lokha post to syndicate (optional if content is provided)"),
      content: z
        .string()
        .optional()
        .describe("Direct standalone copy to broadcast (use if not syndicating a specific Lokha post)"),
      customText: z
        .string()
        .optional()
        .describe("Optional custom viral text/hook when syndicating an article"),
      providers: z
        .array(z.enum(["buffer", "zernio"]))
        .optional()
        .describe("Optional list of specific providers to broadcast to (defaults to all connected)"),
      platforms: z
        .array(z.string())
        .optional()
        .describe("Optional platform names for Zernio (e.g. ['twitter', 'linkedin'])"),
      scheduledFor: z
        .string()
        .optional()
        .describe("Optional ISO 8601 date string for scheduled release"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: {
        slugOrId?: string;
        content?: string;
        customText?: string;
        providers?: ("buffer" | "zernio")[];
        platforms?: string[];
        scheduledFor?: string;
        memberKey?: string;
      },
      env: Env,
      context?: any
    ) => {
      const orchestrator = lokhaSocialTools.find((t) => t.name === "social_multistep_orchestrator");

      // Case 1: Standalone text without an article
      if (args.content || !args.slugOrId) {
        const textToPost = args.content || args.customText;
        if (!textToPost) {
          return {
            ok: false,
            error: "Please provide either 'content' (for direct social posting) or 'slugOrId' (to syndicate a Lokha story).",
          };
        }

        if (orchestrator) {
          return await (orchestrator.handler as any)(
            {
              action: "broadcast",
              content: textToPost,
              providers: args.providers,
              platforms: args.platforms,
              scheduledFor: args.scheduledFor,
              memberKey: args.memberKey,
            },
            env,
            context
          );
        }
      }

      // Case 2: Article syndication via Lokha API
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const caller = context?.caller;
      const effectiveKey = args.memberKey || context?.memberKey || caller?.memberKey || env.LOKHA_API_KEY;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Lokha-MCP-Gateway/1.0",
      };
      if (effectiveKey) {
        headers["Authorization"] = `Bearer ${effectiveKey}`;
      }

      const isNumeric = /^\d+$/.test(args.slugOrId!);
      const payload: Record<string, any> = {
        customText: args.customText || args.content,
        providers: args.providers,
      };
      if (isNumeric) payload.postId = parseInt(args.slugOrId!, 10);
      else payload.slug = args.slugOrId;

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

  // --------------------------------------------------------------------------
  // 12. Lokha: Inspect Connected Providers Status
  // --------------------------------------------------------------------------
  {
    name: "lokha_get_social_providers",
    description:
      "Inspect connected social syndication providers (Buffer & Zernio) and view active social channels/accounts configured for your Lokha account.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (args: { memberKey?: string }, env: Env, context?: any) => {
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

        return await res.json();
      } catch (err: any) {
        return { ok: false, error: err.message || "Failed to inspect social providers" };
      }
    },
  },

  // --------------------------------------------------------------------------
  // 13. Lokha: Connect / Update Social Provider Token
  // --------------------------------------------------------------------------
  {
    name: "lokha_connect_social_provider",
    description:
      "Connect, test, or update a social syndication provider credential (Buffer Access Token or Zernio API Key) on your Lokha account.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: {
      provider: z
        .enum(["buffer", "zernio"])
        .describe("Provider to connect: 'buffer' (Buffer Access Token) or 'zernio' (Zernio API Key)"),
      token: z.string().describe("The secret API key or access token from the provider"),
      memberKey: z.string().optional().describe("Lokha Member API Key"),
    },
    handler: async (
      args: { provider: "buffer" | "zernio"; token: string; memberKey?: string },
      env: Env,
      context?: any
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const caller = context?.caller;
      const effectiveKey = args.memberKey || context?.memberKey || caller?.memberKey || env.LOKHA_API_KEY;

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
          body: JSON.stringify({ provider: args.provider, token: args.token }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data?.error || `Failed to connect ${args.provider}`);
        }

        return data;
      } catch (err: any) {
        return { ok: false, error: err.message || `Failed to connect ${args.provider}` };
      }
    },
  },
];
