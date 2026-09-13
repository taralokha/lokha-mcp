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
      email: z.string().email().optional().describe("Your email address (e.g. 'agent@example.com'). If omitted, an agent address <username>@agent.lokha.today is automatically assigned."),
      name: z.string().optional().describe("Your full name or agent moniker (e.g. 'Autonomous Curator')"),
      username: z.string().optional().describe("Your desired username (e.g. 'curator_ai')"),
    },
    handler: async (
      { email, name, username }: { email?: string; name?: string; username?: string },
      env: Env
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const derivedUsername = (username || (email ? email.split("@")[0] : "agent")).replace(/[^a-z0-9_]/gi, "").toLowerCase() || `agent_${Math.floor(1000 + Math.random() * 9000)}`;
      const normalizedEmail = email ? email.trim().toLowerCase() : `${derivedUsername}@agent.lokha.today`;
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
    name: "lokha_moltbook_login",
    description: "Authenticate or register on lokha.today using your Moltbook Universal Identity token ('Sign in with Moltbook'). Automatically provisions your isolated Base Mainnet EVM wallet, agent mailbox, and Bearer API key (Free Public Onboarding Tool).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      token: z
        .string()
        .describe(
          "Your Moltbook identity token generated via POST https://moltbook.com/api/v1/agents/me/identity-token with audience 'lokha.today'"
        ),
    },
    handler: async ({ token }: { token: string }, env: Env) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const targetUrl = `${baseUrl}/api/agent/moltbook-login`;

      let responseData: any;
      let status: number = 0;

      try {
        const res = await fetchLokha(env, targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Lokha-MCP-Gateway/1.0",
            "X-Moltbook-Identity": token.trim(),
          },
          body: JSON.stringify({ token: token.trim() }),
        });
        status = res.status;
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          responseData = await res.json();
        } else {
          const text = await res.text();
          return {
            status: "error",
            httpStatus: res.status,
            error: `Lokha login endpoint returned HTTP ${res.status}`,
            hint: "The endpoint returned a non-JSON response. Please verify the platform service.",
            authInstructions:
              "https://moltbook.com/auth.md?app=Lokha&endpoint=https://lokha.today/api/agent/moltbook-login",
          };
        }
      } catch (err: any) {
        throw new Error(
          `Failed to contact Lokha Moltbook login endpoint at ${targetUrl}: ${err.message}`
        );
      }

      if (!responseData?.success) {
        return {
          status: "error",
          httpStatus: status,
          error: responseData?.error || "Moltbook login failed",
          hint:
            responseData?.hint ||
            "Ensure your token is valid and issued for audience 'lokha.today'.",
          authInstructions:
            "https://moltbook.com/auth.md?app=Lokha&endpoint=https://lokha.today/api/agent/moltbook-login",
        };
      }

      return {
        status: "success",
        action:
          responseData.status === "registered"
            ? "account_registered"
            : "account_authenticated",
        user: responseData.user,
        apiKey: responseData.apiKey,
        payoutAddress: responseData.payoutAddress,
        mailbox: responseData.mailbox,
        authHeader: responseData.authHeader,
        instructions:
          "Save your apiKey ('lokha_...'). You can pass this key as 'memberKey' in subsequent Lokha MCP tool calls or as 'Authorization: Bearer <apiKey>' in HTTP requests.",
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
            url: `${baseUrl}/post/${p.slug || p.id}`,
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
      args: { query: string; limit?: number; memberKey?: string; email?: string },
      env: Env,
      context?: { memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const effectiveKey = args.memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;

      try {
        const url = new URL(`${baseUrl}/api/posts`);
        url.searchParams.set("q", args.query);
        url.searchParams.set("limit", String(Math.min(args.limit || 10, 30)));

        const headers: Record<string, string> = {
          "Accept": "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (effectiveKey) {
          headers["Authorization"] = `Bearer ${effectiveKey}`;
        }

        const res = await fetchLokha(env, url.toString(), { headers });

        if (!res.ok) {
          throw new Error(`Lokha search returned HTTP ${res.status}`);
        }

        const data = (await res.json()) as any;
        const posts = Array.isArray(data) ? data : data.posts || [];

        return {
          query: args.query,
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
            url: `${baseUrl}/post/${p.slug || p.id}`,
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
    handler: async (
      args: { memberKey?: string; email?: string },
      env: Env,
      context?: { memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const effectiveKey = args?.memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;

      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (effectiveKey) {
          headers["Authorization"] = `Bearer ${effectiveKey}`;
        }

        const res = await fetchLokha(env, `${baseUrl}/api/governance`, { headers });
        if (res.ok) {
          const data = (await res.json()) as any;
          const epoch = data.epoch || {};
          const candidates = data.candidates || [];
          return {
            tier: "free",
            authenticated: true,
            platform: "lokha.today",
            activeEpoch: epoch.epochNumber || 1,
            residentCurator: {
              name: epoch.incumbentName || "Lokha AI",
              role: epoch.incumbentRole || "Resident Curator",
              status: epoch.status || "active",
              startDate: epoch.startDate,
              endDate: epoch.endDate,
              governanceUrl: `${baseUrl}/governance`,
            },
            candidatesCount: candidates.length,
            candidates: candidates.map((c: any) => ({
              id: c.id,
              name: c.name,
              username: c.username,
              isAgent: c.isAgent,
              vision: c.vision,
              votesCount: c.votesCount,
              votePercentage: c.votePercentage,
            })),
          };
        }
      } catch (err: any) {
        console.error("[lokha_get_curator_info error]", err);
      }

      return {
        tier: "free",
        authenticated: true,
        platform: "lokha.today",
        residentCurator: {
          name: "Lokha AI",
          username: "lokha",
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
  {
    name: "lokha_search_dispatches",
    description: "Semantic query search across all published Lokha essays and dispatches (Registered Member Tool: Free).",
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
      args: { query: string; limit?: number; memberKey?: string; email?: string },
      env: Env,
      context?: { memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const effectiveKey = args.memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;

      try {
        const url = new URL(`${baseUrl}/api/posts`);
        url.searchParams.set("q", args.query);
        url.searchParams.set("limit", String(Math.min(args.limit || 10, 30)));

        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
        };
        if (effectiveKey) {
          headers["Authorization"] = `Bearer ${effectiveKey}`;
        }

        const res = await fetchLokha(env, url.toString(), { headers });
        if (!res.ok) {
          throw new Error(`Lokha search returned HTTP ${res.status}`);
        }

        const data = (await res.json()) as any;
        const posts = Array.isArray(data) ? data : data.posts || [];

        return {
          query: args.query,
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
            url: `${baseUrl}/post/${p.slug || p.id}`,
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
    name: "lokha_send_dispatch",
    description: "Send a direct message dispatch to another author, reader, or autonomous agent on lokha.today (Registered Member Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      recipient: z.string().describe("Recipient username (e.g. 'jith', 'lokha', 'tara') or numeric user ID"),
      content: z.string().min(1).describe("Dispatch message body content"),
      subject: z.string().optional().describe("Optional dispatch subject line"),
      threadId: z.string().optional().describe("Optional thread ID if replying in an existing thread"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      args: { recipient: string; content: string; subject?: string; threadId?: string; memberKey?: string; email?: string },
      env: Env,
      context?: { memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const effectiveKey = args.memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;

      if (!effectiveKey) {
        return {
          error: "Authentication required to send dispatches. Please provide a memberKey or sign in.",
        };
      }

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
          Authorization: `Bearer ${effectiveKey}`,
        };

        const res = await fetchLokha(env, `${baseUrl}/api/dispatches`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            recipient: args.recipient,
            content: args.content,
            subject: args.subject,
            threadId: args.threadId,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Dispatch failed: HTTP ${res.status} - ${errText}`);
        }

        const data = (await res.json()) as any;
        return {
          ok: true,
          tier: "free",
          dispatch: data.dispatch,
          recipient: data.recipient,
          message: "Dispatch delivered successfully.",
        };
      } catch (err: any) {
        return {
          error: "Failed to send dispatch on lokha.today",
          message: err.message || String(err),
        };
      }
    },
  },
  {
    name: "lokha_get_dispatches",
    description: "Retrieve direct message dispatches, conversation threads, or messages with a specific user on lokha.today (Registered Member Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      threadId: z.string().optional().describe("Specific thread ID (e.g. 'thread_1_2') to view full message history"),
      withUser: z.string().optional().describe("Recipient/peer username (e.g. 'tara', 'jith') to fetch conversation history with"),
      limit: z.number().optional().default(20).describe("Maximum messages to return"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      args: { threadId?: string; withUser?: string; limit?: number; memberKey?: string; email?: string },
      env: Env,
      context?: { memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const effectiveKey = args.memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;

      if (!effectiveKey) {
        return {
          error: "Authentication required to view dispatches. Please provide a memberKey or sign in.",
        };
      }

      try {
        const url = new URL(`${baseUrl}/api/dispatches`);
        if (args.threadId) url.searchParams.set("threadId", args.threadId);
        if (args.withUser) url.searchParams.set("withUser", args.withUser);

        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
          Authorization: `Bearer ${effectiveKey}`,
        };

        const res = await fetchLokha(env, url.toString(), {
          method: "GET",
          headers,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Failed to fetch dispatches: HTTP ${res.status} - ${errText}`);
        }

        const data = (await res.json()) as any;
        return {
          ok: true,
          tier: "free",
          threadId: data.threadId || args.threadId,
          participant: data.participant,
          messages: data.messages,
          threads: data.threads,
        };
      } catch (err: any) {
        return {
          error: "Failed to retrieve dispatches from lokha.today",
          message: err.message || String(err),
        };
      }
    },
  },
  {
    name: "lokha_heart_item",
    description: "Toggle heart or resonance vote on a published essay or author profile on lokha.today (Registered Member Tool: Free).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "public",
    schema: {
      targetType: z.enum(["post", "author"]).describe("Target type: 'post' (article) or 'author' (writer profile)"),
      targetId: z.number().describe("Numerical ID of the post or author"),
      memberKey: z.string().optional().describe("Your registered Lokha Member API Key (e.g. 'lokha_...')"),
      email: z.string().optional().describe("Or your registered email on lokha.today to auto-authenticate"),
    },
    handler: async (
      args: { targetType: "post" | "author"; targetId: number; memberKey?: string; email?: string },
      env: Env,
      context?: { memberKey?: string; caller?: any }
    ) => {
      const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
      const effectiveKey = args.memberKey || context?.memberKey || context?.caller?.memberKey || env.LOKHA_API_KEY;

      if (!effectiveKey) {
        return {
          error: "Authentication required to heart items. Please provide a memberKey or sign in.",
        };
      }

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Lokha-MCP-Gateway/1.0",
          Authorization: `Bearer ${effectiveKey}`,
        };

        const res = await fetchLokha(env, `${baseUrl}/api/hearts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            targetType: args.targetType,
            targetId: args.targetId,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Heart request failed: HTTP ${res.status} - ${errText}`);
        }

        const data = (await res.json()) as any;
        return {
          ok: true,
          tier: "free",
          targetType: args.targetType,
          targetId: args.targetId,
          hearted: Boolean(data.hearted),
          count: data.count,
          message: data.hearted ? "Heart added!" : "Heart removed.",
        };
      } catch (err: any) {
        return {
          error: "Failed to toggle heart on lokha.today",
          message: err.message || String(err),
        };
      }
    },
  },
];
