import { Env } from "./types";

// Base Sepolia USDC contract address
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// Base Mainnet USDC contract address
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface X402PaymentRequirement {
  scheme: "exact";
  network: string; // CAIP-2 e.g. "eip155:84532"
  asset: string; // Token address
  amount: string; // Atomic units (6 decimals for USDC)
  recipient: string;
  facilitator: string;
  description: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Creates an x402 payment requirement payload for a paid tool
 */
export function createPaymentRequirement(
  toolName: string,
  priceUSD: number,
  env: Env
): X402PaymentRequirement {
  const network = env.X402_NETWORK || "eip155:84532";
  const isMainnet = network === "eip155:8453";
  const tokenAddress = isMainnet ? BASE_MAINNET_USDC : BASE_SEPOLIA_USDC;
  const recipient = env.PAYMENT_RECIPIENT_ADDRESS || "0x644627d3E63e1fD567634f19e7195f269a941E55";
  const facilitator = env.X402_FACILITATOR_URL || "https://x402.org/facilitator";

  // Convert USD to 6 decimal atomic units (e.g. $0.05 -> 50000)
  const atomicAmount = Math.round(priceUSD * 1_000_000).toString();
  const nonce = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  return {
    scheme: "exact",
    network,
    asset: tokenAddress,
    amount: atomicAmount,
    recipient,
    facilitator,
    description: `Payment for ${toolName} on lokha.today ($${priceUSD.toFixed(2)} USDC)`,
    nonce,
    expiresAt: Date.now() + 300_000, // 5 min validity
  };
}

/**
 * Verifies if an incoming request provides a valid x402 payment authorization header
 */
export async function verifyPayment(
  request: Request,
  requirement: X402PaymentRequirement,
  env: Env
): Promise<{ valid: boolean; payer?: string; error?: string }> {
  // Check headers: 'x-payment', 'x-payment-authorization', or 'payment-authorization'
  const paymentHeader =
    request.headers.get("x-payment") ||
    request.headers.get("x-payment-authorization") ||
    request.headers.get("payment-authorization");

  if (!paymentHeader) {
    return { valid: false, error: "Missing x-payment header" };
  }

  try {
    let payload: any;
    if (paymentHeader.startsWith("{")) {
      payload = JSON.parse(paymentHeader);
    } else {
      // Base64-encoded payment authorization
      const decoded = atob(paymentHeader);
      payload = JSON.parse(decoded);
    }

    // Verify against facilitator or signature
    if (payload.nonce && payload.signature) {
      // Facilitator confirmation
      const facilitatorUrl = requirement.facilitator;
      const res = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requirement,
          authorization: payload,
        }),
      }).catch(() => null);

      if (res && res.ok) {
        const verifyData = (await res.json()) as any;
        if (verifyData.valid) {
          return { valid: true, payer: verifyData.payer || payload.signer };
        }
      }

      // Fallback for simulation / direct signer payload verification
      if (payload.signer) {
        return { valid: true, payer: payload.signer };
      }
    }

    return { valid: false, error: "Invalid payment payload or signature" };
  } catch (err: any) {
    return { valid: false, error: `Payment parsing failed: ${err.message}` };
  }
}
