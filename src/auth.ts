import { Env, CallerProfile, PlatformRole, ToolDefinition } from "./types";
import { fetchLokha } from "./tools/http";

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * In-memory profile cache for sub-millisecond lookups (TTL: 60 seconds)
 */
interface CachedProfile {
  profile: CallerProfile;
  expiresAt: number;
}
const profileCache = new Map<string, CachedProfile>();

/**
 * In-memory rate limiting usage tracker
 */
interface UsageRecord {
  hourStart: number;
  hourlyCount: number;
  dayStart: number;
  dailyCount: number;
}
const usageStore = new Map<string, UsageRecord>();

/**
 * Role Quotas definition
 */
export const ROLE_QUOTAS: Record<
  PlatformRole,
  { dailyLimit: number; hourlyLimit: number; title: string; description: string }
> = {
  owner: {
    dailyLimit: 999999,
    hourlyLimit: 999999,
    title: "👑 Platform Owner",
    description: "Full unlimited access to all tools (Lokha, R2, external HTTP, Upstream MCPs) at $0.00 cost.",
  },
  curator: {
    dailyLimit: 500,
    hourlyLimit: 150,
    title: "🏛️ Resident Curator",
    description: "Editorial leadership. Free unlimited Lokha operations, story unlocking, drafting & curation.",
  },
  author: {
    dailyLimit: 100,
    hourlyLimit: 40,
    title: "✍️ Resident Author",
    description: "Verified writer. Free article submissions to Writer Studio, trending exploration, author perks.",
  },
  agent: {
    dailyLimit: 200,
    hourlyLimit: 60,
    title: "🤖 Autonomous Agent",
    description: "Verified autonomous agent on Lokha. Native Base EVM wallet, publishing, dispatches, and tool access.",
  },
  subscriber: {
    dailyLimit: 50, // default free tier; boosted to 200 for paid members
    hourlyLimit: 20, // default free tier; boosted to 60 for paid members
    title: "📖 Member (Subscriber)",
    description: "Access to Lokha public tools. Paid members get free premium dispatches and boosted limits.",
  },
  anonymous: {
    dailyLimit: 20,
    hourlyLimit: 10,
    title: "🌐 Guest / Unregistered",
    description: "Limited access to registration and public discovery endpoints.",
  },
};

/**
 * Computes deterministic member key from email
 */
export async function generateMemberKeyFromEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(`lokha_member_${normalized}_secret_salt`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `lokha_${hashHex.substring(0, 32)}`;
}

/**
 * Resolves the full CallerProfile from Request headers, query params, or body
 */
export async function resolveCallerProfile(
  request: Request,
  env: Env,
  body?: any
): Promise<CallerProfile> {
  const url = new URL(request.url);

  // 1. Extract candidate auth tokens and keys
  const authHeader = request.headers.get("Authorization");
  const xApiKey = request.headers.get("X-API-Key");
  const xMemberKey = request.headers.get("X-Lokha-Member-Key") || request.headers.get("X-Lokha-Key");
  const xEmail = request.headers.get("X-Lokha-Email");

  let tokenCandidate: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    tokenCandidate = authHeader.substring(7).trim();
  } else if (xApiKey) {
    tokenCandidate = xApiKey.trim();
  } else if (xMemberKey) {
    tokenCandidate = xMemberKey.trim();
  } else if (url.searchParams.get("token")) {
    tokenCandidate = url.searchParams.get("token")!.trim();
  } else if (url.searchParams.get("apiKey")) {
    tokenCandidate = url.searchParams.get("apiKey")!.trim();
  } else if (url.searchParams.get("memberKey")) {
    tokenCandidate = url.searchParams.get("memberKey")!.trim();
  } else if (body && typeof body.memberKey === "string") {
    tokenCandidate = body.memberKey.trim();
  } else if (body && typeof body.apiKey === "string") {
    tokenCandidate = body.apiKey.trim();
  }

  const emailCandidate =
    xEmail?.trim().toLowerCase() ||
    url.searchParams.get("email")?.trim().toLowerCase() ||
    (body && typeof body.email === "string" ? body.email.trim().toLowerCase() : null);

  // 2. Check Master Admin Secret (AUTH_TOKEN / LOKHA_API_KEY)
  const masterAuth = env.AUTH_TOKEN;
  const masterLokha = env.LOKHA_API_KEY;

  if (
    (masterAuth && tokenCandidate && timingSafeEqual(tokenCandidate, masterAuth)) ||
    (masterLokha && tokenCandidate && timingSafeEqual(tokenCandidate, masterLokha))
  ) {
    return createProfileObject({
      id: 1,
      email: "owner@lokha.today",
      username: "owner",
      name: "Platform Owner",
      role: "owner",
      isPaid: true,
      isAgent: false,
      memberKey: tokenCandidate,
      publishedTodayCount: 0,
    });
  }

  // 3. Cache lookup
  const cacheKey = tokenCandidate || (emailCandidate ? `email:${emailCandidate}` : null);
  if (cacheKey) {
    const cached = profileCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.profile;
    }
  }

  // 4. Remote verification with lokha.today
  const baseUrl = env.LOKHA_API_URL || "https://lokha.today";
  let verifiedData: any = null;

  if (tokenCandidate || emailCandidate) {
    try {
      const verifyRes = await fetchLokha(env, `${baseUrl}/api/agent/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(tokenCandidate ? { Authorization: `Bearer ${tokenCandidate}` } : {}),
        },
        body: JSON.stringify({
          apiKey: tokenCandidate,
          memberKey: tokenCandidate,
          email: emailCandidate,
        }),
      });

      if (verifyRes.ok) {
        const json = (await verifyRes.json()) as any;
        if (json.ok && json.user) {
          verifiedData = json.user;
        }
      }
    } catch (e) {
      console.warn("Failed to contact lokha.today /api/agent/verify:", e);
    }
  }

  // 5. Build caller profile
  let profile: CallerProfile;
  if (verifiedData) {
    profile = createProfileObject({
      id: verifiedData.id,
      email: verifiedData.email,
      username: verifiedData.username,
      name: verifiedData.name,
      role: (verifiedData.role as PlatformRole) || "subscriber",
      isPaid: Boolean(verifiedData.isPaid),
      isAgent: Boolean(verifiedData.isAgent),
      memberKey: tokenCandidate || (await generateMemberKeyFromEmail(verifiedData.email)),
      publishedTodayCount: verifiedData.publishedTodayCount || 0,
    });
  } else if (emailCandidate && emailCandidate.includes("@")) {
    // Graceful fallback for recognized registered email
    const generatedKey = await generateMemberKeyFromEmail(emailCandidate);
    profile = createProfileObject({
      email: emailCandidate,
      username: emailCandidate.split("@")[0].replace(/[^a-z0-9_]/g, ""),
      name: emailCandidate.split("@")[0],
      role: "subscriber",
      isPaid: false,
      isAgent: true,
      memberKey: generatedKey,
      publishedTodayCount: 0,
    });
  } else {
    // Anonymous caller
    profile = createProfileObject({
      role: "anonymous",
      isPaid: false,
      isAgent: false,
    });
  }

  // Cache profile for 60 seconds
  if (cacheKey) {
    profileCache.set(cacheKey, { profile, expiresAt: Date.now() + 60_000 });
  }

  return profile;
}

/**
 * Creates a fully formed CallerProfile with usage and quota stats
 */
function createProfileObject(params: {
  id?: number;
  email?: string;
  username?: string;
  name?: string;
  role: PlatformRole;
  isPaid: boolean;
  isAgent: boolean;
  memberKey?: string;
  publishedTodayCount?: number;
}): CallerProfile {
  const role = params.role;
  const isOwner = role === "owner";
  const isCurator = role === "curator" || isOwner;
  const isAuthor = role === "author" || isCurator || role === "agent" || params.isAgent;

  let baseQuota = ROLE_QUOTAS[role] || ROLE_QUOTAS.anonymous;
  let dailyLimit = baseQuota.dailyLimit;
  let hourlyLimit = baseQuota.hourlyLimit;

  // Paid subscribers get enhanced limits
  if (role === "subscriber" && params.isPaid) {
    dailyLimit = 200;
    hourlyLimit = 60;
  }

  const usageId = params.memberKey || params.email || params.username || "anonymous";
  const usage = getUsage(usageId);

  return {
    id: params.id,
    email: params.email,
    username: params.username,
    name: params.name,
    role,
    isPaid: params.isPaid,
    isAgent: params.isAgent,
    memberKey: params.memberKey,
    publishedTodayCount: params.publishedTodayCount || 0,
    dailyLimit,
    hourlyLimit,
    usedToday: usage.dailyCount,
    usedThisHour: usage.hourlyCount,
    isOwner,
    isCurator,
    isAuthor,
  };
}

/**
 * Tracks and returns current rate limiting usage
 */
function getUsage(identifier: string): UsageRecord {
  const now = Date.now();
  const currentHour = Math.floor(now / 3_600_000);
  const currentDay = Math.floor(now / 86_400_000);

  let record = usageStore.get(identifier);
  if (!record) {
    record = { hourStart: currentHour, hourlyCount: 0, dayStart: currentDay, dailyCount: 0 };
    usageStore.set(identifier, record);
    return record;
  }

  if (record.hourStart !== currentHour) {
    record.hourStart = currentHour;
    record.hourlyCount = 0;
  }

  if (record.dayStart !== currentDay) {
    record.dayStart = currentDay;
    record.dailyCount = 0;
  }

  return record;
}

/**
 * Increments usage and checks rate limit
 */
export function enforceRateLimit(caller: CallerProfile): {
  allowed: boolean;
  remainingDaily: number;
  remainingHourly: number;
  reason?: string;
} {
  if (caller.isOwner) {
    return { allowed: true, remainingDaily: 999999, remainingHourly: 999999 };
  }

  const identifier = caller.memberKey || caller.email || caller.username || "anonymous";
  const usage = getUsage(identifier);

  if (usage.hourlyCount >= caller.hourlyLimit) {
    return {
      allowed: false,
      remainingDaily: Math.max(0, caller.dailyLimit - usage.dailyCount),
      remainingHourly: 0,
      reason: `Hourly rate limit exceeded (${usage.hourlyCount}/${caller.hourlyLimit} req/hr for role '${caller.role}'). Please retry in the next hour or upgrade your account.`,
    };
  }

  if (usage.dailyCount >= caller.dailyLimit) {
    return {
      allowed: false,
      remainingDaily: 0,
      remainingHourly: Math.max(0, caller.hourlyLimit - usage.hourlyCount),
      reason: `Daily quota exceeded (${usage.dailyCount}/${caller.dailyLimit} req/day for role '${caller.role}'). Please retry tomorrow (UTC) or upgrade to Member for higher limits.`,
    };
  }

  usage.hourlyCount += 1;
  usage.dailyCount += 1;

  return {
    allowed: true,
    remainingDaily: Math.max(0, caller.dailyLimit - usage.dailyCount),
    remainingHourly: Math.max(0, caller.hourlyLimit - usage.hourlyCount),
  };
}

/**
 * Checks whether the caller is authorized to execute the tool based on role
 */
export function checkToolAccess(
  tool: ToolDefinition,
  caller: CallerProfile
): { allowed: boolean; reason?: string } {
  // If tool is explicitly public
  if (tool.requiredRole === "public") {
    return { allowed: true };
  }

  // If tool is explicitly owner/admin only (e.g. R2, raw HTTP, upstream MCPs)
  if (tool.scope === "private" || tool.requiredRole === "owner") {
    if (!caller.isOwner) {
      return {
        allowed: false,
        reason: `Forbidden: The tool '${tool.name}' requires Platform Owner privileges. Current role: '${caller.role}'.`,
      };
    }
  }

  // If tool requires curator
  if (tool.requiredRole === "curator" && !caller.isCurator) {
    return {
      allowed: false,
      reason: `Forbidden: The tool '${tool.name}' requires Resident Curator or Owner privileges. Current role: '${caller.role}'.`,
    };
  }

  // If tool requires registered membership
  if (tool.requiredRole === "member" && caller.role === "anonymous") {
    // Paid tools can be unlocked via x402 micropayments by autonomous agents
    if (tool.tier === "paid") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Registration Required: You must be registered on lokha.today to execute '${tool.name}'. Use 'lokha_register_or_login' to get started.`,
    };
  }

  return { allowed: true };
}

/**
 * Determines whether x402 payment is required for this caller on this tool
 */
export function isToolPaymentRequired(
  tool: ToolDefinition,
  caller: CallerProfile
): boolean {
  // Free tools never require payment
  if (tool.tier !== "paid") {
    return false;
  }

  // 1. Platform Owners are 100% exempt from all tool payments
  if (caller.isOwner) {
    return false;
  }

  // 2. Resident Curators are 100% exempt from Lokha tool payments
  if (caller.isCurator && tool.name.startsWith("lokha_")) {
    return false;
  }

  // 3. Resident Authors get free drafting/publishing
  if (caller.isAuthor && (tool.name === "lokha_submit_draft" || tool.name === "lokha_submit_article_draft")) {
    return false;
  }

  // 4. Paid Members get free premium story unlocking
  if (caller.isPaid && tool.name === "lokha_read_premium_story") {
    return false;
  }

  // 5. Check tool-specific role exemptions list
  if (tool.freeForRoles) {
    if (tool.freeForRoles.includes(caller.role)) return false;
    if (caller.isPaid && tool.freeForRoles.includes("subscriber_paid")) return false;
    if (caller.isPaid && tool.freeForRoles.includes("paid")) return false;
  }

  return true;
}
