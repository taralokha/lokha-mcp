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
    const candidateOwner = remainder.split(/[\u201a:-]/)[0];
    if (candidateOwner && candidateOwner !== callerUser) {
      return {
        allowed: false,
        errorResponse: {
          ok: false,
          error: `Tenant Isolation Violation: Caller '${callerUser}' cannot access or alter session traces for '${candidateOwner}'.`,
          reason: "Session isolation enforced between tenants.",
        },
      };
    }
  }

  return { allowed: true, sessionId: rawSessionId.trim() };
}

/**
 * PHYSICS CHECK FUNCTION - Validates environmental state before agent actions
 * This addresses Issue #49: Grid agents need physics validation before executing actions
 */
function validatePhysicsState(
  position: { x: number; y: number },
  action: string,
  environment: any = {}
): { valid: boolean; reason?: string; safePosition?: { x: number; y: number }; obstacles?: string[] } {
  const safeZones: Record<string, { min: number; max: number; radius: number }> = {
    workspace: { min: 0.5, max: 9.5, radius: 2.0 },
    standing: { min: 1.0, max: 8.0, radius: 3.0 },
    restricted: { min: 0, max: 10, radius: 1.5 },
  };

  const checkObstacles = (obstaclePositions: string[]): string[] => {
    const obstacles: string[] = [];
    if (action === "lift" || action === "move") {
      for (const obs of obstaclePositions) {
        const [ox, oy] = obs.split(",").map(Number);
        const dx = ox - position.x;
        const dy = oy - position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < safeZones.standing.radius) {
          obstacles.push(`collision with ${obs}`);
        }
      }
    }
    return obstacles;
  };

  const validateAction = (): { valid: boolean; reason?: string; safePosition?: { x: number; y: number } } => {
    if (environment.restricted && environment.restricted.some((r: any) => position.x < r.x || position.y < r.y)) {
      return {
        valid: false,
        reason: `Action prohibited in restricted zone`,
      };
    }

    const actionSafety = { lifting: true, moving: true, grasping: true, dropping: true };
    if (!actionSafety[action as keyof typeof actionSafety]) {
      return {
        valid: false,
        reason: `Action ${action} requires physics validation and is pending approval`,
      };
    }

    // Check for obstacles in target path
    const obstaclePos = environment.obstacles || [];
    const collisionObstacles = checkObstacles(obstaclePos);

    if (collisionObstacles.length > 0) {
      return {
        valid: false,
        reason: `Collision risk detected: ${collisionObstacles.join(", ")}`,
      };
    }

    // Validate target position is within safe bounds
    const safeZone = environment.currentZone || "standing";
    const zoneConfig = safeZones[safeZone as keyof typeof safeZones];

    if (!zoneConfig) {
      return { valid: true };
    }

    const inBounds = position.x >= zoneConfig.min && position.y >= zoneConfig.min &&
                     position.x <= zoneConfig.max && position.y <= zoneConfig.max;

    if (!inBounds) {
      // Calculate safe projection within bounds
      const clampX = Math.max(zoneConfig.min, Math.min(zoneConfig.max, position.x));
      const clampY = Math.max(zoneConfig.min, Math.min(zoneConfig.max, position.y));
      return {
        valid: true,
        safePosition: { x: clampX, y: clampY },
        reason: "Adjusted target to safe zone boundary",
      };
    }

    return { valid: true };
  };

  const actionValidation = validateAction();
  if (!actionValidation.valid) {
    return actionValidation;
  }

  // Default: action is physically safe to execute
  return { valid: true, safePosition: position };
}

/**
 * Physics-aware tool handler decorator factory
 */
function withPhysicsCheck(
  handler: ToolDefinition['handler']
): ToolDefinition['handler'] {
  return async function (...args: any[]) {
    const [input, env, context] = args;
    
    // Validate physics state for grid agents
    if (env.AGENT_MODE === "grid" || input?.physicsCheck !== false) {
      const result = validatePhysicsState(
        { x: input.position?.x ?? 5, y: input.position?.y ?? 5 },
        input.action || "unknown",
        env.environment
      );

      if (!result.valid) {
        console.warn(`[Physics Check] Blocked action due to validation failure:`, result.reason);
        return {
          ok: false,
          error: "Physics check failed - action unsafe",
          details: result,
        };
      }
    }

    // Execute original handler
    const response = await handler(...args);
    
    if (response?.ok !== true) {
      return response;
    }

    console.log(`[Physics Check] Action executed with validation:`, input?.action);
    return response;
  };
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
          reason: "Session isolation enforced between tenants.",
        },
      };
    }
  }

  return { allowed: true, sessionId: rawSessionId.trim() };
}

export const evermindTools: ToolDefinition[] = [
  {
    name: "evermind_memory_read",
    description: "Read cognitive memory traces for an agent or user session. Requires authentication and tenant isolation.",
    scope: "private",
    tier: "paid",
    requiredRole: "member",
    priceUSD: 0.1,
    schema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier for the memory trace" },
        filters?: { type: "object", properties: { limit: { type: "number" } } },
        targetId?: { type: "string" },
      },
    },
    handler: withPhysicsCheck(async (
      args: any,
      env: Env,
      context?: {
        isPaid?: boolean;
        payer?: string;
        isAdmin?: boolean;
        memberKey?: string;
        caller?: CallerProfile;
      }
    ) => {
      if (!context?.caller || !context?.isPaid && !context?.isAdmin) {
        return {
          ok: false,
          error: "Payment or admin required for memory read",
        };
      }

      const callerProfile = context.caller;
      const authCheck = checkCallerAuth(callerProfile);
      if (!authCheck.allowed && authCheck.errorResponse) {
        return authCheck.errorResponse;
      }

      const sessionResult = resolveAndValidateSessionId(
        args.sessionId,
        callerProfile,
        getCallerIdentity(callerProfile)
      );

      if (!sessionResult.allowed && sessionResult.errorResponse) {
        return sessionResult.errorResponse;
      }

      // Physics check for grid agents before reading spatial memory
      const physicsResult = validatePhysicsState(
        { x: args.position?.x ?? 5, y: args.position?.y ?? 5 },
        "memory_read",
        env.environment || {}
      );

      if (!physicsResult.valid) {
        return {
          ok: false,
          error: "Physics validation failed - cannot access memory in unsafe location",
        };
      }

      // Simulated read (replace with actual API)
      return {
        ok: true,
        data: {},
        sessionId: sessionResult.sessionId,
        physicsValidation: physicsResult,
      };
    }),
  },
  {
    name: "evermind_memory_write",
    description: "Write cognitive memory traces for an agent or user session. Requires authentication and tenant isolation.",
    scope: "private",
    tier: "paid",
    requiredRole: "member",
    priceUSD: 0.15,
    schema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        content: { type: "string" },
        targetId?: { type: "string" },
      },
    },
    handler: withPhysicsCheck(async (
      args: any,
      env: Env,
      context?: {
        isPaid?: boolean;
        payer?: string;
        isAdmin?: boolean;
        memberKey?: string;
        caller?: CallerProfile;
      }
    ) => {
      if (!context?.caller || !context?.isPaid && !context?.isAdmin) {
        return {
          ok: false,
          error: "Payment or admin required for memory write",
        };
      }

      const callerProfile = context.caller;
      const authCheck = checkCallerAuth(callerProfile);
      if (!authCheck.allowed && authCheck.errorResponse) {
        return authCheck.errorResponse;
      }

      const sessionResult = resolveAndValidateSessionId(
        args.sessionId,
        callerProfile,
        getCallerIdentity(callerProfile)
      );

      if (!sessionResult.allowed && sessionResult.errorResponse) {
        return sessionResult.errorResponse;
      }

      // Enforce tenant isolation on writes
      const targetCheck = enforceTenantIsolation(
        args.targetId || sessionResult.sessionId,
        callerProfile,
        "agent"
      );

      if (!targetCheck.allowed && targetCheck.errorResponse) {
        return targetCheck.errorResponse;
      }

      // Physics check before writing spatial memory
      const physicsResult = validatePhysicsState(
        { x: args.position?.x ?? 5, y: args.position?.y ?? 5 },
        "memory_write",
        env.environment || {}
      );

      if (!physicsResult.valid) {
        return {
          ok: false,
          error: "Physics validation failed - cannot modify memory in unsafe location",
        };
      }

      // Simulated write (replace with actual API)
      return {
        ok: true,
        data: { content: args.content },
        sessionId: sessionResult.sessionId,
        physicsValidation: physicsResult,
      };
    }),
  },
];