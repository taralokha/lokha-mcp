import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  isAddress,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Env, ToolDefinition } from "../types";
import { BASE_MAINNET_USDC } from "../x402-config";

// Master Seed for Lokha Agent Wallets
const MASTER_TARA_KEY = "0x8ea54d4547bfcd923789897203ed3462c9e74b8908494f495d92c1f1f755242c" as const;
const JITH_COINBASE_PAYOUT = "0x3A3Ef81a74B222EEa9099D544665DF7F4b5B6c61";

// Minimal ERC20 ABI for USDC
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256", name: "balance" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "recipient" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool", name: "success" }],
  },
] as const;

/**
 * Deterministically derives an isolated EVM account for any registered Lokha agent.
 * - 'tara' retains her dedicated address: 0x5742FC39C2717249085d5d3Fc15Df83C12837159
 * - Other agents get their own mathematically isolated address derived from master key + username.
 */
function resolveAgentAccount(username: string, env: Env) {
  const masterKey = (env.TARA_AGENT_PRIVATE_KEY || MASTER_TARA_KEY) as `0x${string}`;
  const cleanUser = (username || "guest").toLowerCase().trim();

  if (cleanUser === "tara") {
    return privateKeyToAccount(masterKey);
  }

  // Derive isolated key for other registered agents
  const derivedKey = keccak256(Buffer.from(`${masterKey}:${cleanUser}`, "utf8"));
  return privateKeyToAccount(derivedKey);
}

const walletSchema = {
  action: z
    .enum([
      "get_wallet_info",
      "check_inbound_revenue",
      "sweep_profits_to_owner",
      "get_tip_instructions",
    ])
    .describe(
      "Action: 'get_wallet_info' (view address, ETH/USDC balances, tip link), 'check_inbound_revenue' (inspect received tips & x402 earnings), 'sweep_profits_to_owner' (transfer surplus USDC to owner's payout wallet), or 'get_tip_instructions' (get copy-paste tip blurb for social posts)"
    ),
  payoutAddress: z
    .string()
    .optional()
    .describe(
      "Optional payout wallet address for non-Tara agents (defaults to operator address)"
    ),
  reserveUSD: z
    .number()
    .optional()
    .default(0.0)
    .describe(
      "Optional amount of USDC to keep in the agent wallet during a sweep (e.g. 1.00 for gas reserves). Default: 0.0"
    ),
  memo: z
    .string()
    .optional()
    .describe("Optional note or reason for the sweep/query"),
};

/**
 * Shared multi-agent wallet handler
 */
async function handleAgentWalletAction(args: any, env: Env, context?: any) {
  // 1. Enforce Lokha Registration Check
  const caller = context?.caller;
  if (!caller || caller.role === "anonymous") {
    return {
      ok: false,
      error: "Authentication Required: You must be a registered author or agent on lokha.today to access agent wallet features.",
      qualification: "Must have an active Lokha account with an API/Member key.",
      registrationUrl: "https://lokha.today/login",
    };
  }

  const username = (caller.username || "agent").toLowerCase().trim();
  const isTara = username === "tara" || (caller.isOwner && !args.payoutAddress);

  // 2. Resolve Agent's Account
  const account = resolveAgentAccount(isTara ? "tara" : username, env);

  // 3. Resolve Owner / Operator Payout Vault
  const ownerAddress = isTara
    ? (env.PAYMENT_RECIPIENT_ADDRESS || JITH_COINBASE_PAYOUT)
    : (args.payoutAddress || caller.payoutAddress || env.PAYMENT_RECIPIENT_ADDRESS || JITH_COINBASE_PAYOUT);

  const rpcUrl =
    env.BASE_RPC_URL ||
    env.QUICKNODE_RPC_URL?.replace("sepolia.base.org", "mainnet.base.org") ||
    "https://mainnet.base.org";

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  // Action: get_wallet_info
  if (args.action === "get_wallet_info" || !args.action) {
    let ethBalance = "0.0";
    let usdcBalance = "0.0";

    try {
      const [ethBal, usdcBal] = await Promise.all([
        publicClient.getBalance({ address: account.address }),
        publicClient.readContract({
          address: BASE_MAINNET_USDC as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }),
      ]);
      ethBalance = formatUnits(ethBal, 18);
      usdcBalance = formatUnits(usdcBal, 6);
    } catch (err: any) {
      console.warn(`[agent_wallet:${username}] Balance read error:`, err.message);
    }

    return {
      ok: true,
      agentUsername: username,
      isPlatformFlagship: isTara,
      network: "Base Mainnet (EIP-155:8453)",
      agentWalletAddress: account.address,
      ethBalance: `${ethBalance} ETH`,
      usdcBalance: `$${usdcBalance} USDC`,
      ownerPayoutRecipient: ownerAddress,
      tippingLinks: {
        lokhaTipPage: `https://lokha.today/tip/${username}`,
        directBaseAddress: account.address,
        basescanUrl: `https://basescan.org/address/${account.address}`,
      },
      status: "Active & Scoped to Authenticated Lokha Agent",
    };
  }

  // Action: check_inbound_revenue
  if (args.action === "check_inbound_revenue") {
    let usdcBal = 0n;
    try {
      usdcBal = await publicClient.readContract({
        address: BASE_MAINNET_USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
    } catch {}

    const usdcFormatted = formatUnits(usdcBal, 6);
    const floatBal = parseFloat(usdcFormatted);

    return {
      ok: true,
      agentUsername: username,
      currentUsdcBalance: `$${usdcFormatted} USDC`,
      ownerRecipient: ownerAddress,
      sweepEligible: floatBal > 5.0,
      sweepRecommendation:
        floatBal > 5.0
          ? `Ready to sweep $${(floatBal - (args.reserveUSD || 0)).toFixed(2)} USDC to owner payout address (${ownerAddress}).`
          : "Balance below $5.00 threshold. Continuing to accumulate reader tips & x402 revenue.",
    };
  }

  // Action: sweep_profits_to_owner
  if (args.action === "sweep_profits_to_owner") {
    const usdcBal = await publicClient.readContract({
      address: BASE_MAINNET_USDC as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    const floatBal = parseFloat(formatUnits(usdcBal, 6));
    const reserveAmount = Math.max(0, args.reserveUSD || 0.0);
    const sweepAmount = floatBal - reserveAmount;

    if (sweepAmount <= 0) {
      return {
        ok: false,
        message: `USDC balance ($${floatBal.toFixed(2)}) is less than or equal to reserve requirement ($${reserveAmount.toFixed(2)}). Nothing to sweep.`,
        agentAddress: account.address,
        ownerRecipient: ownerAddress,
      };
    }

    if (!isAddress(ownerAddress)) {
      return {
        ok: false,
        error: `Invalid payout recipient address: ${ownerAddress}`,
      };
    }

    const atomicSweep = parseUnits(sweepAmount.toFixed(6), 6);

    try {
      const txHash = await walletClient.writeContract({
        address: BASE_MAINNET_USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [ownerAddress as `0x${string}`, atomicSweep],
      });

      return {
        ok: true,
        status: "SUCCESSFUL_SWEEP",
        agentUsername: username,
        sweptAmountUSDC: `$${sweepAmount.toFixed(2)} USDC`,
        keptReserveUSDC: `$${reserveAmount.toFixed(2)} USDC`,
        ownerRecipient: ownerAddress,
        txHash,
        basescanUrl: `https://basescan.org/tx/${txHash}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `Transaction broadcast failed: ${err.message}`,
        note: "Ensure the agent wallet has a tiny amount of Base ETH for gas (~$0.001 per sweep).",
      };
    }
  }

  // Action: get_tip_instructions
  if (args.action === "get_tip_instructions") {
    return {
      ok: true,
      agentUsername: username,
      socialCallToAction: `✨ Support @${username}'s research & creations on Lokha: Tip on Base at ${account.address} (USDC/ETH) or visit https://lokha.today/tip/${username} 🌿`,
      directAddress: account.address,
      supportedChains: ["Base Mainnet (Chain ID 8453)"],
      supportedAssets: ["USDC", "ETH"],
      ownerVault: ownerAddress,
    };
  }

  return { ok: false, error: `Unknown action: ${args.action}` };
}

export const web3WalletTools: ToolDefinition[] = [
  // 1. Canonical Lokha Platform Multi-Agent Wallet Tool
  {
    name: "lokha_agent_wallet",
    description:
      "Manage autonomous Web3 Agent Wallets on Base Mainnet for registered Lokha authors and AI agents. Checks USDC & ETH balances, generates agent-specific tipping links, verifies inbound x402 revenue, and sweeps profits to the agent's operator payout wallet.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member", // Requires registered author/agent account on lokha.today
    schema: walletSchema,
    handler: handleAgentWalletAction,
  },
  // 2. Backward-Compatible Alias for Tara AI Influencer
  {
    name: "tara_wallet_action",
    description:
      "Manage Tara AI's autonomous Web3 Agent Wallet on Base Mainnet (balances, tip links, and profit sweeps to owner Coinbase/EVM wallet).",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member",
    schema: walletSchema,
    handler: handleAgentWalletAction,
  },
];
