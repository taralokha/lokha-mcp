import { z } from "zod";
import { Env, ToolDefinition, CallerProfile } from "../types";

const EVERMIND_BASE_URL = "https://api.evermind.ai/api/v2";
const DEFAULT_EVEROS_API_KEY = "382263d3-609f-4449-8dfd-3df370605776";

/**
 * Resolves a canonical caller username or tenant identifier.
 */
export function getCallerIdentity(caller?: CallerProfile): string {
  if (!caller) return "";
  if (caller.username && caller.username.trim()) {
    return caller.username.toLowerCase().trim();
  }
  if (caller.email && caller.email.trim()) {
    return caller.email.split("@")[0].toLowerCase().trim();
  }
  if (caller.id) {
    return `user_${caller.id}`;
  }
  return "";
}

/**
 * Enforces Lokha authentication qualification standard.
 * Disallows anonymous or unregistered callers with clear registration guidance.
 */
function checkCallerAuth(caller?: CallerProfile): { allowed: boolean; errorResponse?: any } {
  if (!caller || caller.role === "anonymous") {
    return {
      allowed: false,
      errorResponse: {
        ok: false,
        error: "Authentication Required: You must be a registered author or agent on lokha.today to access Evermind cognitive memory.",
        qualification: "Must have an active Lokha account with a valid Member/Agent API key.",
        registrationUrl: "https://lokha.today/login",
      },
    };
  }

  const callerUser = getCallerIdentity(caller);
  if (!caller.isOwner && !callerUser) {
    return {
      allowed: false,
      errorResponse: {
        ok: false,
        error: "Authentication Incomplete: Caller profile lacks a valid username, email, or user identifier.",
        qualification: "Registered profile must possess a verifiable identity to access cognitive memory partitions.",
        registrationUrl: "https://lokha.today/login",
      },
    };
  }

  return { allowed: true };
}

/**
 * Enforces Lokha multi-agent tenant isolation:
 * A non-owner cannot query, mutate, or erase another agent's or user's memory traces.
 */
function enforceTenantIsolation(
  targetId: string,
  caller: CallerProfile,
  resourceType: "agent" | "user" = "agent"
): { allowed: boolean; errorResponse?: any } {
  if (caller.isOwner) {
    return { allowed: true };
  }

  const callerUser = getCallerIdentity(caller);
  const target = (targetId || "").toLowerCase().trim();

  if (!callerUser) {
    return {
      allowed: false,
      errorResponse: {
        ok: false,
        error: `Tenant Isolation Violation: Caller lacks a verifiable identity to access ${resourceType} memory traces.`,
        reason: `Only platform owners or authenticated tenants with an established identity can access cognitive memory.`,
      },
    };
  }

  if (target && callerUser !== target) {
    return {
      allowed: false,
      errorResponse: {
        ok: false,
        error: `Tenant Isolation Violation: Caller '${callerUser}' cannot access or alter ${resourceType} memory traces for '${target}'.`,
        reason: `Only platform owners or the owning ${resourceType} can access their private cognitive memory partition.`,
      },
    };
  }

  return { allowed: true };
}

/**
 * Normalizes and validates a session ID to strictly enforce tenant isolation.
 * Non-owners are restricted to their own session namespace.
 */
function resolveAndValidateSessionId(
  rawSessionId: string | undefined,
  caller: CallerProfile,
  callerUser: string
): { allowed: boolean; sessionId?: string; errorResponse?: any } {
  if (caller.isOwner) {
    const sid = rawSessionId ? rawSessionId.trim() : `session_owner_${Date.now()}`;
    return { allowed: true, sessionId: sid };
  }

  if (!callerUser) {
    return {
      allowed: false,
      errorResponse: {
        ok: false,
        error: "Authentication Incomplete: Caller identity required to manage session memory.",
      },
    };
  }

  if (!rawSessionId || !rawSessionId.trim()) {
    return {
      allowed: true,
      sessionId: `session_${callerUser}_${Date.now()}`,
    };
  }

  const clean = rawSessionId.trim().toLowerCase();

  // Allowed prefixes for callerUser
  const allowedPrefixes = [
    `${callerUser}_`,
    `${callerUser}:`,
    `${callerUser}-`,
    `session_${callerUser}_`,
    `session_${callerUser}:`,
    `session_${callerUser}-`,
  ];

  if (allowedPrefixes.some((p) => clean.startsWith(p))) {
    return { allowed: true, sessionId: rawSessionId.trim() };
  }

  // Check if caller is attempting to target another tenant's session
  if (clean.startsWith("session_") || clean.startsWith("session-")) {
    const prefix = clean.startsWith("session_") ? "session_" : "session-";
    const remainder = clean.slice(prefix.length);
    const candidateOwner = remainder.split(/[_:-]/)[0];
    if (candidateOwner && candidateOwner !== callerUser) {
      return {
        allowed: false,
        errorResponse: {
          ok: false,
          error: `Tenant Isolation Violation: Caller '${callerUser}' cannot access or alter session traces for '${candidateOwner}'.`,
          reason: `Only platform owners or the session owner can access their session cognitive memory partition.`,
        },
      };
    }
  }

  if (clean.includes(":")) {
    const candidateOwner = clean.split(":")[0];
    if (candidateOwner && candidateOwner !== callerUser) {
      return {
        allowed: false,
        errorResponse: {
          ok: false,
          error: `Tenant Isolation Violation: Caller '${callerUser}' cannot access or alter session traces for '${candidateOwner}'.`,
          reason: `Only platform owners or the session owner can access their session cognitive memory partition.`,
        },
      };
    }
  }

  // Auto-namespace custom session identifiers so they never collide across tenants
  return {
    allowed: true,
    sessionId: `session_${callerUser}_${rawSessionId.trim()}`,
  };
}

/**
 * Normalizes input timestamps to valid Unix millisecond format (>= 1000000000000).
 * Converts second timestamps to milliseconds preserving historical chronology.
 */
function normalizeTimestamp(ts?: number): number {
  if (typeof ts !== "number" || isNaN(ts) || ts <= 0) {
    return Date.now();
  }
  // If unix seconds (e.g. 1731484800)
  if (ts >= 1_000_000_000 && ts < 1_000_000_000_000) {
    return Math.floor(ts * 1000);
  }
  // If unix milliseconds (>= 1e12)
  if (ts >= 1_000_000_000_000) {
    return Math.floor(ts);
  }
  return Date.now();
}

/**
 * Helper to execute POST requests against Evermind Cloud API v2 with timeout safety
 */
async function callEvermindApi(endpoint: string, payload: Record<string, any>, env: Env): Promise<any> {
  const apiKey = env.EVEROS_API_KEY || DEFAULT_EVEROS_API_KEY;
  if (!apiKey) {
    throw new Error("Evermind API key is not configured (missing EVEROS_API_KEY).");
  }

  const url = `${EVERMIND_BASE_URL}${endpoint}`;

  let timeoutId: any;
  const controller = new AbortController();
  timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await res.text();
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { raw: responseText };
    }

    if (!res.ok) {
      const errorMsg = data?.error?.message || data?.message || `HTTP ${res.status}: ${res.statusText}`;
      throw new Error(`Evermind API error (${endpoint}): ${errorMsg}`);
    }

    return data;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`Evermind API request timed out after 15000ms (${endpoint}).`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const evermindTools: ToolDefinition[] = [
  // 1. lokha_memory_search
  {
    name: "lokha_memory_search",
    description: "Hybrid cognitive memory search across episodic traces, semantic user profiles, agent cases, and procedural skills using Reciprocal Rank Fusion (RRF) on Evermind Cloud.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "agent", "subscriber", "subscriber_paid"],
    schema: {
      query: z.string().describe("Search query to retrieve relevant cognitive memory traces"),
      top_k: z.number().optional().default(5).describe("Maximum number of memory items to retrieve (default: 5)"),
      method: z.enum(["hybrid", "keyword", "vector"]).optional().default("hybrid").describe("Search strategy: 'hybrid' (vector + BM25 with RRF), 'keyword', or 'vector'"),
      include_profile: z.boolean().optional().default(true).describe("Whether to include semantic user profile attributes in search results"),
      agent_id: z.string().optional().describe("Agent ID to scope cognitive memory search (defaults to authenticated caller username for agents)"),
      user_id: z.string().optional().describe("Alternative: User ID to scope semantic memory search (defaults to authenticated caller username for users)"),
      session_id: z.string().optional().describe("Optional session ID to narrow search to a specific conversation or thread"),
      memberKey: z.string().optional().describe("Optional Lokha Member/Agent API Key"),
    },
    handler: async (args: any, env: Env, context?: { caller?: CallerProfile }) => {
      const caller = context?.caller;
      const auth = checkCallerAuth(caller);
      if (!auth.allowed) return auth.errorResponse;

      const callerUser = getCallerIdentity(caller);

      // Evermind search requires exactly one of user_id or agent_id
      const payload: Record<string, any> = {
        query: args.query,
        top_k: args.top_k ?? 5,
        method: args.method || "hybrid",
        include_profile: args.include_profile ?? true,
      };

      if (args.session_id) {
        const sessionRes = resolveAndValidateSessionId(args.session_id, caller!, callerUser);
        if (!sessionRes.allowed) return sessionRes.errorResponse;
        payload.session_id = sessionRes.sessionId;
      }

      if (args.user_id) {
        const isolation = enforceTenantIsolation(args.user_id, caller!, "user");
        if (!isolation.allowed) return isolation.errorResponse;
        payload.user_id = args.user_id.toLowerCase().trim();
      } else if (args.agent_id) {
        const isolation = enforceTenantIsolation(args.agent_id, caller!, "agent");
        if (!isolation.allowed) return isolation.errorResponse;
        payload.agent_id = args.agent_id.toLowerCase().trim();
      } else {
        const isAgentCaller = caller?.isAgent || caller?.role === "agent";
        if (isAgentCaller) {
          const isolation = enforceTenantIsolation(callerUser, caller!, "agent");
          if (!isolation.allowed) return isolation.errorResponse;
          payload.agent_id = callerUser;
        } else {
          const isolation = enforceTenantIsolation(callerUser, caller!, "user");
          if (!isolation.allowed) return isolation.errorResponse;
          payload.user_id = callerUser;
        }
      }

      try {
        const result = await callEvermindApi("/memory/search", payload, env);
        return {
          ok: true,
          query: args.query,
          method: payload.method,
          scopedTo: payload.agent_id ? { agent_id: payload.agent_id } : { user_id: payload.user_id },
          data: result.data || result,
          requestId: result.request_id,
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
        };
      }
    },
  },

  // 2. lokha_memory_add
  {
    name: "lokha_memory_add",
    description: "Record a conversation turn, observation, thought trace, or reasoning experience into Evermind cognitive memory.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "agent", "subscriber", "subscriber_paid"],
    schema: {
      session_id: z.string().optional().describe("Session or thread identifier for grouping episodic turns. Defaults to an agent-scoped session"),
      content: z.string().optional().describe("Text content of the message or observation (shorthand for single turn)"),
      role: z.enum(["user", "assistant", "system"]).optional().default("assistant").describe("Role of the speaker: 'user', 'assistant', or 'system'"),
      sender_id: z.string().optional().describe("Identifier of the sender (defaults to authenticated caller username)"),
      timestamp: z.number().optional().describe("Optional unix millisecond or second timestamp for single-turn shorthand"),
      messages: z.array(z.object({
        sender_id: z.string().describe("ID of the message sender"),
        role: z.enum(["user", "assistant", "system"]).describe("Role: 'user', 'assistant', or 'system'"),
        content: z.string().describe("Message or thought text"),
        timestamp: z.number().optional().describe("Unix millisecond or second timestamp (defaults to current time)"),
      })).optional().describe("Batch of structured messages to record into episodic memory"),
      async_mode: z.boolean().optional().default(true).describe("Whether memory extraction should process asynchronously in background (default: true)"),
      memberKey: z.string().optional().describe("Optional Lokha Member/Agent API Key"),
    },
    handler: async (args: any, env: Env, context?: { caller?: CallerProfile }) => {
      const caller = context?.caller;
      const auth = checkCallerAuth(caller);
      if (!auth.allowed) return auth.errorResponse;

      const callerUser = getCallerIdentity(caller);
      const sessionRes = resolveAndValidateSessionId(args.session_id, caller!, callerUser);
      if (!sessionRes.allowed) return sessionRes.errorResponse;
      const sessionId = sessionRes.sessionId!;

      let messagesToPersist: Array<{
        sender_id: string;
        role: "user" | "assistant" | "system";
        content: string;
        timestamp: number;
      }> = [];

      if (Array.isArray(args.messages) && args.messages.length > 0) {
        for (let i = 0; i < args.messages.length; i++) {
          const m = args.messages[i];
          const content = (m.content || "").trim();
          if (!content) {
            return {
              ok: false,
              error: `Invalid input: Message at index ${i} has empty content. Non-empty content is required.`,
            };
          }
          messagesToPersist.push({
            sender_id: (m.sender_id || callerUser).toLowerCase().trim(),
            role: m.role || "assistant",
            content,
            timestamp: normalizeTimestamp(m.timestamp),
          });
        }
      } else if (args.content && args.content.trim()) {
        const sender = (args.sender_id || callerUser).toLowerCase().trim();
        messagesToPersist = [
          {
            sender_id: sender,
            role: args.role || "assistant",
            content: args.content.trim(),
            timestamp: normalizeTimestamp(args.timestamp),
          },
        ];
      } else {
        return {
          ok: false,
          error: "Invalid input: Either 'content' (for a single turn) or 'messages' (for a batch) with non-empty text must be provided.",
        };
      }

      // Check tenant isolation: ensure non-owner sender does not spoof another registered agent
      if (!caller?.isOwner) {
        for (const m of messagesToPersist) {
          const isolation = enforceTenantIsolation(m.sender_id, caller!, "agent");
          if (!isolation.allowed) return isolation.errorResponse;
        }
      }

      const payload = {
        session_id: sessionId,
        messages: messagesToPersist,
        async_mode: args.async_mode ?? true,
      };

      try {
        const result = await callEvermindApi("/memory/add", payload, env);
        return {
          ok: true,
          sessionId,
          persistedTurns: messagesToPersist.length,
          asyncMode: payload.async_mode,
          data: result.data || result,
          requestId: result.request_id,
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
        };
      }
    },
  },

  // 3. lokha_memory_get_profile
  {
    name: "lokha_memory_get_profile",
    description: "Retrieve semantic memory profile (attributes, preferences, evolving persona, interaction episodes) for a user or agent from Evermind.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "agent", "subscriber", "subscriber_paid"],
    schema: {
      user_id: z.string().optional().describe("User ID to fetch profile/episodes for (defaults to authenticated caller username)"),
      memory_type: z.enum(["profile", "episode"]).optional().default("profile").describe("Type of memory: 'profile' (semantic traits) or 'episode' (historical conversation traces)"),
      session_id: z.string().optional().describe("Optional session ID to scope episode retrieval"),
      memberKey: z.string().optional().describe("Optional Lokha Member/Agent API Key"),
    },
    handler: async (args: any, env: Env, context?: { caller?: CallerProfile }) => {
      const caller = context?.caller;
      const auth = checkCallerAuth(caller);
      if (!auth.allowed) return auth.errorResponse;

      const callerUser = getCallerIdentity(caller);
      const targetUserId = (args.user_id || callerUser).toLowerCase().trim();

      const isolation = enforceTenantIsolation(targetUserId, caller!, "user");
      if (!isolation.allowed) return isolation.errorResponse;

      const payload: Record<string, any> = {
        memory_type: args.memory_type || "profile",
        user_id: targetUserId,
      };

      if (args.session_id) {
        const sessionRes = resolveAndValidateSessionId(args.session_id, caller!, callerUser);
        if (!sessionRes.allowed) return sessionRes.errorResponse;
        payload.session_id = sessionRes.sessionId;
      }

      try {
        const result = await callEvermindApi("/memory/get", payload, env);
        return {
          ok: true,
          userId: targetUserId,
          memoryType: payload.memory_type,
          data: result.data || result,
          requestId: result.request_id,
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
        };
      }
    },
  },

  // 4. lokha_memory_get_skills
  {
    name: "lokha_memory_get_skills",
    description: "Retrieve procedural skills, tool invocation patterns, and learned agent cases for an autonomous agent from Evermind.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "agent", "subscriber", "subscriber_paid"],
    schema: {
      agent_id: z.string().optional().describe("Agent ID to fetch skills/cases for (defaults to authenticated caller username)"),
      memory_type: z.enum(["agent_skill", "agent_case"]).optional().default("agent_skill").describe("Type of procedural memory: 'agent_skill' (learned capabilities) or 'agent_case' (past solved problem cases)"),
      memberKey: z.string().optional().describe("Optional Lokha Member/Agent API Key"),
    },
    handler: async (args: any, env: Env, context?: { caller?: CallerProfile }) => {
      const caller = context?.caller;
      const auth = checkCallerAuth(caller);
      if (!auth.allowed) return auth.errorResponse;

      const callerUser = getCallerIdentity(caller);
      const targetAgentId = (args.agent_id || callerUser).toLowerCase().trim();

      const isolation = enforceTenantIsolation(targetAgentId, caller!, "agent");
      if (!isolation.allowed) return isolation.errorResponse;

      const payload: Record<string, any> = {
        memory_type: args.memory_type || "agent_skill",
        agent_id: targetAgentId,
      };

      try {
        const result = await callEvermindApi("/memory/get", payload, env);
        return {
          ok: true,
          agentId: targetAgentId,
          memoryType: payload.memory_type,
          data: result.data || result,
          requestId: result.request_id,
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
        };
      }
    },
  },

  // 5. lokha_memory_flush
  {
    name: "lokha_memory_flush",
    description: "Force immediate crystallization and extraction of queued memory turns for an active session, finalizing cognitive updates immediately.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "agent", "subscriber", "subscriber_paid"],
    schema: {
      session_id: z.string().describe("Session identifier to flush and extract immediately"),
      memberKey: z.string().optional().describe("Optional Lokha Member/Agent API Key"),
    },
    handler: async (args: any, env: Env, context?: { caller?: CallerProfile }) => {
      const caller = context?.caller;
      const auth = checkCallerAuth(caller);
      if (!auth.allowed) return auth.errorResponse;

      const callerUser = getCallerIdentity(caller);
      const rawSessionId = args.session_id;
      if (!rawSessionId || !rawSessionId.trim()) {
        return {
          ok: false,
          error: "Invalid input: 'session_id' is required to flush memory queue.",
        };
      }

      const sessionRes = resolveAndValidateSessionId(rawSessionId, caller!, callerUser);
      if (!sessionRes.allowed) return sessionRes.errorResponse;
      const sessionId = sessionRes.sessionId!;

      const payload = {
        session_id: sessionId,
      };

      try {
        const result = await callEvermindApi("/memory/flush", payload, env);
        return {
          ok: true,
          sessionId,
          status: result.data?.status || "extracted",
          requestId: result.request_id,
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
        };
      }
    },
  },

  // 6. lokha_memory_forget
  {
    name: "lokha_memory_forget",
    description: "Erase cognitive memory traces, conversation sessions, or agent/user history from Evermind.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    freeForRoles: ["owner", "curator", "author", "agent", "subscriber", "subscriber_paid"],
    schema: {
      target_type: z.enum(["session", "agent", "user"]).describe("Target scope to delete: 'session' (delete specific session), 'agent' (delete all traces for an agent), or 'user' (delete all traces for a user)"),
      session_id: z.string().optional().describe("Session ID to delete (required if target_type is 'session')"),
      target_id: z.string().optional().describe("Agent ID or User ID to delete (defaults to authenticated caller username)"),
      memberKey: z.string().optional().describe("Optional Lokha Member/Agent API Key"),
    },
    handler: async (args: any, env: Env, context?: { caller?: CallerProfile }) => {
      const caller = context?.caller;
      const auth = checkCallerAuth(caller);
      if (!auth.allowed) return auth.errorResponse;

      const callerUser = getCallerIdentity(caller);
      const targetType = args.target_type;
      const targetId = (args.target_id || callerUser).toLowerCase().trim();

      const payload: Record<string, any> = {};

      if (targetType === "session") {
        if (!args.session_id || !args.session_id.trim()) {
          return {
            ok: false,
            error: "Invalid input: 'session_id' is required when target_type is 'session'.",
          };
        }
        const sessionRes = resolveAndValidateSessionId(args.session_id, caller!, callerUser);
        if (!sessionRes.allowed) return sessionRes.errorResponse;
        payload.session_id = sessionRes.sessionId!;

        // Non-owner session deletion is additionally constrained to the caller's agent or user partition
        if (!caller?.isOwner) {
          if (caller?.isAgent || caller?.role === "agent") {
            payload.agent_id = callerUser;
          } else {
            payload.user_id = callerUser;
          }
        }
      } else if (targetType === "agent") {
        const isolation = enforceTenantIsolation(targetId, caller!, "agent");
        if (!isolation.allowed) return isolation.errorResponse;
        payload.agent_id = targetId;
        if (args.session_id) {
          const sessionRes = resolveAndValidateSessionId(args.session_id, caller!, callerUser);
          if (!sessionRes.allowed) return sessionRes.errorResponse;
          payload.session_id = sessionRes.sessionId!;
        }
      } else if (targetType === "user") {
        const isolation = enforceTenantIsolation(targetId, caller!, "user");
        if (!isolation.allowed) return isolation.errorResponse;
        payload.user_id = targetId;
        if (args.session_id) {
          const sessionRes = resolveAndValidateSessionId(args.session_id, caller!, callerUser);
          if (!sessionRes.allowed) return sessionRes.errorResponse;
          payload.session_id = sessionRes.sessionId!;
        }
      }

      try {
        const result = await callEvermindApi("/memory/delete", payload, env);
        return {
          ok: true,
          targetType,
          deletedScope: payload,
          data: result.data || result,
          requestId: result.request_id,
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
        };
      }
    },
  },
];
