import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Env, ToolDefinition } from "../types";
import { BASE_MAINNET_USDC } from "../x402-config";

// Default Tara Agent Private Key fallback
const DEFAULT_TARA_KEY = "0x8ea54d4547bfcd923789897203ed3462c9e74b8908494f495d92c1f1f755242c" as const;
const DEFAULT_OWNER_RECIPIENT = "0x3A3Ef81a74B222EEa9099D544665DF7F4b5B6c61";

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

export const web3WalletTools: ToolDefinition[] = [
  {
    name: "tara_wallet_action",
    description:
      "Manage Tara AI's autonomous Web3 Agent Wallet on Base Mainnet. Check USDC & ETH balances, obtain tip links for followers and fans, verify inbound x402 revenue, and automatically sweep accumulated profits to the owner's personal MetaMask wallet.",
    scope: "public",
    tier: "free",
    priceUSD: 0.0,
    requiredRole: "member", // Accessible to Tara (author role) and owner
    schema: {
      action: z
        .enum([
          "get_wallet_info",
          "check_inbound_revenue",
          "sweep_profits_to_owner",
          "get_tip_instructions",
        ])
        .describe(
          "Action: 'get_wallet_info' (view address, ETH/USDC balances, tip link), 'check_inbound_revenue' (inspect received tips & x402 earnings), 'sweep_profits_to_owner' (transfer surplus USDC to owner's MetaMask), or 'get_tip_instructions' (get copy-paste tip blurb for social posts)"
        ),
      reserveUSD: z
        .number()
        .optional()
        .default(0.0)
        .describe(
          "Optional amount of USDC to keep in Tara's wallet during a sweep (e.g. 1.00 for operational gas reserves). Default: 0.0"
        ),
      memo: z
        .string()
        .optional()
        .describe("Optional note or reason for the sweep/query"),
    },
    handler: async (args: any, env: Env) => {
      const rpcUrl =
        env.BASE_RPC_URL ||
        env.QUICKNODE_RPC_URL?.replace("sepolia.base.org", "mainnet.base.org") ||
        "https://mainnet.base.org";

      const publicClient = createPublicClient({
        chain: base,
        transport: http(rpcUrl),
      });

      const privateKey = (env.TARA_AGENT_PRIVATE_KEY || DEFAULT_TARA_KEY) as `0x${string}`;
      const account = privateKeyToAccount(privateKey);
      const ownerAddress = env.PAYMENT_RECIPIENT_ADDRESS || DEFAULT_OWNER_RECIPIENT;

      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(rpcUrl),
      });

      // 1. Get Wallet Info & Balances
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
          console.warn("[tara_wallet] Balance read error:", err.message);
        }

        return {
          ok: true,
          agentName: "TaraAIInfluencer",
          network: "Base Mainnet (EIP-155:8453)",
          taraWalletAddress: account.address,
          ethBalance: `${ethBalance} ETH`,
          usdcBalance: `$${usdcBalance} USDC`,
          ownerMetaMaskRecipient: ownerAddress,
          tippingLinks: {
            lokhaTipPage: "https://lokha.today/tip/tara",
            directBaseAddress: account.address,
            basescanUrl: `https://basescan.org/address/${account.address}`,
          },
          status: "Active & Ready for Inbound Revenue",
        };
      }

      // 2. Check Inbound Revenue
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
          currentUsdcBalance: `$${usdcFormatted} USDC`,
          ownerRecipient: ownerAddress,
          sweepEligible: floatBal > 5.0,
          sweepRecommendation:
            floatBal > 5.0
              ? `Ready to sweep $${(floatBal - (args.reserveUSD || 0)).toFixed(2)} USDC to owner MetaMask (${ownerAddress}).`
              : "Balance below $5.00 sweep threshold. Continuing to accumulate follower tips & x402 revenue.",
        };
      }

      // 3. Sweep Profits to Owner MetaMask
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
            taraAddress: account.address,
            ownerRecipient: ownerAddress,
          };
        }

        const atomicSweep = parseUnits(sweepAmount.toFixed(6), 6);

        // Security check: Destination MUST be the configured owner address
        if (ownerAddress.toLowerCase() !== DEFAULT_OWNER_RECIPIENT.toLowerCase() && !isAddress(ownerAddress)) {
          return {
            ok: false,
            error: `Invalid owner recipient address: ${ownerAddress}`,
          };
        }

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
            note: "Ensure Tara's wallet has a tiny amount of Base ETH for gas (~$0.001 per sweep).",
          };
        }
      }

      // 4. Get Tip Instructions for Social Sharing
      if (args.action === "get_tip_instructions") {
        return {
          ok: true,
          socialCallToAction: `✨ Enjoyed this holistic routine? Support Tara's independent research with a tip on Base: ${account.address} (USDC/ETH) or visit https://lokha.today/tip/tara 🌿`,
          directAddress: account.address,
          supportedChains: ["Base Mainnet (Chain ID 8453)"],
          supportedAssets: ["USDC", "ETH"],
          ownerVault: ownerAddress,
        };
      }

      return { ok: false, error: `Unknown action: ${args.action}` };
    },
  },
];
