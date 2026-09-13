export interface Env {
  AUTH_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_S3_ENDPOINT?: string;
  R2_STORAGE?: R2Bucket;
  ENVIRONMENT?: string;

  // Lokha & x402 Monetization
  LOKHA_SERVICE?: Fetcher;
  LOKHA_API_KEY?: string;
  LOKHA_API_URL?: string;
  CDP_API_KEY_NAME?: string;
  CDP_API_KEY_PRIVATE_KEY?: string;
  PAYMENT_RECIPIENT_ADDRESS?: string;
  X402_NETWORK?: string;
  X402_FACILITATOR_URL?: string;
  QUICKNODE_RPC_URL?: string;
  // Social Providers & Real-time Webhooks
  ZERNIO_API_KEY?: string;
  ZERNIO_WEBHOOK_SECRET?: string;
  BUFFER_ACCESS_TOKEN?: string;
  LETTA_API_KEY?: string;
  LETTA_AGENT_ID?: string;
  EVEROS_API_KEY?: string;
  TARA_AGENT_PRIVATE_KEY?: string;
  BASE_RPC_URL?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export type PlatformRole = "owner" | "curator" | "author" | "subscriber" | "anonymous";

export interface CallerProfile {
  id?: number;
  email?: string;
  username?: string;
  name?: string;
  role: PlatformRole;
  isPaid: boolean;
  isAgent: boolean;
  memberKey?: string;
  publishedTodayCount?: number;
  dailyLimit: number;
  usedToday: number;
  hourlyLimit: number;
  usedThisHour: number;
  isOwner: boolean;
  isCurator: boolean;
  isAuthor: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  scope: "public" | "private";
  tier?: "free" | "paid";
  priceUSD?: number;
  requiredRole?: PlatformRole | "member" | "public";
  freeForRoles?: string[]; // e.g. ["owner", "curator", "subscriber_paid", "author"]
  schema: Record<string, any>;
  handler: (
    args: any,
    env: Env,
    context?: {
      isPaid?: boolean;
      payer?: string;
      isAdmin?: boolean;
      memberKey?: string;
      caller?: CallerProfile;
    }
  ) => Promise<any>;
}
