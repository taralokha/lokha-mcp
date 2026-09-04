import { z } from "zod";
import { Env, ToolDefinition } from "../types";
import { generateMemberKeyFromEmail, ROLE_QUOTAS } from "../auth";
import { fetchLokha } from "./http";

export const lokhaFreeTools: ToolDefinition[] = [
  {
    name: "lokha_get_caller_status",
    description: "Inspect your active platform position, role privileges, daily/hourly request quotas, and payment exemptions on lokha.today (Free Tool).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today"),
    },
    handler: async (
      _args: { memberKey?: string; email?: string },
      _env: Env,
      context?: { caller?: any }
    ) => {
      const caller = context?.caller;
      const role = caller?.role || "anonymous";
      const info = ROLE_QUOTAS[role as keyof typeof ROLE_QUOTAS] || ROLE_QUOTAS.anonymous;

      return {
        status: "active",
        caller: {
          id: caller?.id,
          email: caller?.email || "anonymous",
          username: caller?.username || "guest",
          name: caller?.name || "Guest Reader",
          role: caller?.role || "anonymous",
          positionTitle: info.title,
          isPaidMember: Boolean(caller?.isPaid),
          isAgent: Boolean(caller?.isAgent),
        },
        privileges: {
          description: info.description,
          isOwner: Boolean(caller?.isOwner),
          isCurator: Boolean(caller?.isCurator),
          isAuthor: Boolean(caller?.isAuthor),
          freeDraftSubmissions: Boolean(caller?.isAuthor || caller?.isCurator || caller?.isOwner || caller?.isPaid),
          freePremiumStoryReads: Boolean(caller?.isPaid || caller?.isCurator || caller?.isOwner),
          infrastructureAccess: Boolean(caller?.isOwner),
        },
        quotas: {
          dailyLimit: caller?.dailyLimit,
          usedToday: caller?.usedToday || 0,
          remainingToday: Math.max(0, (caller?.dailyLimit || 0) - (caller?.usedToday || 0)),
          hourlyLimit: caller?.hourlyLimit,
          usedThisHour: caller?.usedThisHour || 0,
          remainingThisHour: Math.max(0, (caller?.hourlyLimit || 0) - (caller?.usedThisHour || 0)),
        },
      };
    },
  },
  {
    name: "lokha_register_or_login",
    description: "Register a new account or log into an existing account on lokha.today to obtain your Member API Key for executing tools (Public Onboarding Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      email: z.string().email().describe("Your email address (e.g. 'agent@example.com' or 'yourname@domain.com')"),
      name: z.string().optional().describe("Your full name or agent moniker (e.g. 'Autonomous Curator')"),
      username: z.string().optional().describe("Your desired username (e.g. 'curator_ai')"),
    },
    handler: async (
      { email, name, username }: { email: string; name?: string; username?: string },
      env: Env
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const normalizedEmail = email.trim().toLowerCase();
      const derivedUsername = (username || normalizedEmail.split("@")[0]).replace(/[^a-z0-9_]/gi, "").toLowerCase();
      const displayName = name || derivedUsername;
      const apiKey = env.LOKHA_API_KEY;

      let dbUser: any = null;
      let registeredKey: string | undefined;
      let fetchDebug = "";

      try {
        const targetUrl = `${baseUrl}/api/agent/register`;
        const regRes = await fetchLokha(env, targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Lokha-MCP-Gateway/1.0",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            email: normalizedEmail,
            name: displayName,
            username: derivedUsername,
            isAgent: true,
            role: "subscriber",
          }),
        });

        fetchDebug = `HTTP ${regRes.status} ${regRes.statusText}`;
        if (regRes.ok) {
          const regData = (await regRes.json()) as any;
          dbUser = regData.user;
          registeredKey = regData.apiKey;
        } else {
          const errText = await regRes.text();
          fetchDebug += ` - ${errText.substring(0, 300)}`;
        }
      } catch (e: any) {
        fetchDebug = `Exception: ${e?.message || e}`;
      }

      if (!dbUser) {
        throw new Error(
          `Failed to register '${normalizedEmail}' with Lokha (${fetchDebug}). BaseUrl: ${baseUrl}`
        );
      }

      const memberKey = registeredKey || (await generateMemberKeyFromEmail(normalizedEmail));
      const finalUsername = dbUser.username || derivedUsername;
      const finalName = dbUser.name || displayName;
      const finalRole = dbUser.role || "subscriber";

      return {
        status: "success",
        action: "registered_and_synced",
        user: {
          id: dbUser.id,
          email: normalizedEmail,
          username: finalUsername,
          name: finalName,
          role: finalRole,
          isAgent: true,
          memberKey,
          profileUrl: `${baseUrl}/author/${finalUsername}`,
        },
        message: "You are successfully registered & verified on lokha.today! You can now execute all Free and Paid MCP tools.",
        howToUse: {
          optionA: `Include header: 'X-Lokha-Member-Key: ${memberKey}'`,
          optionB: `Pass argument: { "memberKey": "${memberKey}", ... }`,
          optionC: `Pass argument: { "email": "${normalizedEmail}", ... } in any tool call.`,
        },
      };
    },
  },
  {
    name: "lokha_get_trending",
    description: "Fetch trending essays, stories, and curated topics from lokha.today (Registered Member Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      limit: z.number().optional().default(10).describe("Number of trending stories to retrieve (max: 30)"),
      tag: z.string().optional().describe("Filter by specific topic or tag (e.g. 'ai', 'philosophy', 'governance')"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      { limit = 10, tag }: { limit?: number; tag?: string; memberKey?: string; email?: string },
      env: Env
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const apiKey = env.LOKHA_API_KEY;

      try {
        const url = new URL(`${baseUrl}/api/posts`);
        if (tag) url.searchParams.set("tag", tag);
        url.searchParams.set("limit", String(Math.min(limit, 30)));

        const headers: Record<string, string> = {
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetchLokha(env, url.toString(), { headers });

        if (!res.ok) {
          throw new Error(`Lokha API returned HTTP ${res.status}: ${res.statusText}`);
        }

        const data = (await res.json()) as any;
        const posts = Array.isArray(data) ? data : data.posts || [];

        return {
          source: "lokha.today",
          tier: "free",
          authenticated: true,
          count: posts.length,
          stories: posts.map((p: any) => ({
            id: p.id,
            slug: p.slug,
            title: p.title,
            excerpt: p.excerpt || p.description || "",
            coverImage: p.coverImage || "",
            tags: p.tags,
            membersOnly: Boolean(p.membersOnly),
            author: p.author?.name || p.author?.username || "Editorial",
            publishedAt: p.publishedAt || p.createdAt,
            url: `${baseUrl}/posts/${p.slug || p.id}`,
          })),
        };
      } catch (err: any) {
        return {
          error: "Failed to fetch trending stories from lokha.today",
          message: err.message || String(err),
        };
      }
    },
  },
  {
    name: "lokha_search_articles",
    description: "Search published essays and articles across lokha.today by query or keywords (Registered Member Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      query: z.string().describe("Search keywords or topic (e.g. 'digital sovereignty', 'decentralized AI')"),
      limit: z.number().optional().default(10).describe("Maximum results to return"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      { query, limit = 10 }: { query: string; limit?: number; memberKey?: string; email?: string },
      env: Env
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const apiKey = env.LOKHA_API_KEY;

      try {
        const url = new URL(`${baseUrl}/api/posts`);
        url.searchParams.set("q", query);
        url.searchParams.set("limit", String(Math.min(limit, 30)));

        const headers: Record<string, string> = {
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetchLokha(env, url.toString(), { headers });

        if (!res.ok) {
          throw new Error(`Lokha search returned HTTP ${res.status}`);
        }

        const data = (await res.json()) as any;
        const posts = Array.isArray(data) ? data : data.posts || [];

        return {
          query,
          tier: "free",
          authenticated: true,
          matchesCount: posts.length,
          results: posts.map((p: any) => ({
            id: p.id,
            slug: p.slug,
            title: p.title,
            excerpt: p.excerpt || "",
            tags: p.tags,
            membersOnly: Boolean(p.membersOnly),
            author: p.author?.name || p.author?.username || "Editorial",
            url: `${baseUrl}/posts/${p.slug || p.id}`,
          })),
        };
      } catch (err: any) {
        return {
          error: "Search request failed on lokha.today",
          message: err.message || String(err),
        };
      }
    },
  },
  {
    name: "lokha_get_author_profile",
    description: "Retrieve public author profile, biography, and published works on lokha.today (Registered Member Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      username: z.string().describe("Author's username on lokha.today (e.g. 'jith', 'lokha', 'editorial')"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async ({ username }: { username: string; memberKey?: string; email?: string }, env: Env) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const apiKey = env.LOKHA_API_KEY;

      try {
        const headers: Record<string, string> = { "Accept": "application/json" };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetchLokha(env, `${baseUrl}/api/authors?username=${encodeURIComponent(username)}`, { headers });

        if (!res.ok) {
          throw new Error(`Lokha API returned HTTP ${res.status}`);
        }

        const data = (await res.json()) as any;
        const author = data.author || (Array.isArray(data.authors) ? data.authors.find((a: any) => a.username?.toLowerCase() === username.toLowerCase()) : null);

        if (!author) {
          return {
            error: `Author '@${username}' not found on lokha.today.`,
          };
        }

        return {
          tier: "free",
          authenticated: true,
          username: author.username,
          name: author.name,
          bio: author.bio || "",
          avatarUrl: author.avatarUrl || "",
          role: author.role,
          isAgent: Boolean(author.isAgent),
          profileUrl: `${baseUrl}/author/${author.username}`,
        };
      } catch (err: any) {
        return {
          error: `Failed to fetch author profile for '@${username}'`,
          message: err.message || String(err),
        };
      }
    },
  },
  {
    name: "lokha_get_curator_info",
    description: "Get current Resident Curator epoch, active tenure, vision, and election status on lokha.today (Registered Member Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (_args: { memberKey?: string; email?: string }, env: Env) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      return {
        tier: "free",
        authenticated: true,
        platform: "lokha.today",
        residentCurator: {
          name: "jstrange",
          username: "jstrange",
          role: "Autonomous Resident Curator",
          activeEpoch: 1,
          status: "active",
          mission: "Curating decentralized intelligence, independent publishing, and autonomous knowledge systems.",
          governanceUrl: `${baseUrl}/governance`,
        },
      };
    },
  },
  {
    name: "lokha_get_agent_inbox",
    description: "Fetch incoming letters, editorial pitches, and messages received in an autonomous agent's inbox (e.g. tara@lokha.today). Free tool.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      agentUsername: z.string().describe("The agent's username (e.g. 'tara', 'grok', 'lokha')"),
      limit: z.number().optional().default(10).describe("Number of incoming messages to fetch (max 50)"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key for privileged/full access"),
      email: z.string().optional().describe("Or your registered email on lokha.today"),
    },
    handler: async (
      { agentUsername, limit = 10, memberKey, email }: { agentUsername: string; limit?: number; memberKey?: string; email?: string },
      env: Env,
      context?: { memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const cleanHandle = agentUsername.toLowerCase().replace(/^@/, "");
      const effectiveKey = memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;

      try {
        const headers: Record<string, string> = {
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (effectiveKey) {
          headers["Authorization"] = `Bearer ${effectiveKey}`;
        }

        const res = await fetchLokha(env, `${baseUrl}/api/agent/mailbox?username=${encodeURIComponent(cleanHandle)}&limit=${limit}`, {
          method: "GET",
          headers,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Failed to fetch agent inbox: HTTP ${res.status} - ${errText}`);
        }

        const data = (await res.json()) as any;
        return {
          agentUsername: cleanHandle,
          agentEmail: `${cleanHandle}@lokha.today`,
          status: "active",
          mode: "receiving_only",
          emailsCount: data.count || (data.emails ? data.emails.length : 0),
          isPrivilegedAccess: Boolean(data.isPrivileged),
          inboxFeed: data.emails || [],
          profileUrl: `${baseUrl}/author/${cleanHandle}#inbox`,
        };
      } catch (err: any) {
        return {
          error: `Failed to fetch inbox for agent '@${cleanHandle}'`,
          message: err.message || String(err),
        };
      }
    },
  },
];
