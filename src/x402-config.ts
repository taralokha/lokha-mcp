import { verifyMessage, isAddress, getAddress } from "viem";
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
  const network = env.X402_NETWORK || "eip155:8453";
  const isMainnet = network === "eip155:8453";
  const tokenAddress = isMainnet ? BASE_MAINNET_USDC : BASE_SEPOLIA_USDC;
  const recipient = env.PAYMENT_RECIPIENT_ADDRESS || "0x3A3Ef81a74B222EEa9099D544665DF7F4b5B6c61";
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
 * Validates x402 payment header cryptographically against optional requirement.
 */
export async function verifyX402Payment(
  paymentHeader: string,
  requirement?: X402PaymentRequirement
): Promise<{ valid: boolean; payer?: string; error?: string }> {
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

    if (!payload || typeof payload !== "object") {
      return { valid: false, error: "Invalid payment payload format" };
    }

    if (payload.signer && !payload.payer) {
      return { valid: false, error: "Simulated payload with signer is rejected. Genuine payer is required." };
    }

    const payer = payload.payer;
    if (!payer || typeof payer !== "string" || !isAddress(payer)) {
      return { valid: false, error: "Valid payer EVM address is required" };
    }

    if (!payload.nonce || typeof payload.nonce !== "string") {
      return { valid: false, error: "Payment nonce is required" };
    }

    if (!payload.signature || typeof payload.signature !== "string") {
      return { valid: false, error: "Cryptographic signature is required" };
    }

    // Expiry check
    const expiry = Number(payload.expiry || payload.expiresAt || requirement?.expiresAt || 0);
    if (expiry && expiry <= Date.now()) {
      return { valid: false, error: "Payment authorization has expired" };
    }

    // Requirement matching if requirement is provided
    if (requirement) {
      if (payload.nonce !== requirement.nonce) {
        return { valid: false, error: "Payment nonce does not match requirement" };
      }

      if (requirement.expiresAt && requirement.expiresAt <= Date.now()) {
        return { valid: false, error: "Payment requirement has expired" };
      }

      const reqRecipient = requirement.recipient;
      if (payload.recipient && isAddress(payload.recipient)) {
        if (getAddress(payload.recipient) !== getAddress(reqRecipient)) {
          return { valid: false, error: "Payment recipient mismatch" };
        }
      }

      if (payload.amount && String(payload.amount) !== String(requirement.amount)) {
        return { valid: false, error: "Payment amount mismatch" };
      }

      // 1. Check facilitator verification if available
      if (requirement.facilitator) {
        try {
          const res = await fetch(`${requirement.facilitator}/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requirement,
              authorization: payload,
            }),
          });

          if (res.ok) {
            const verifyData = (await res.json()) as any;
            if (verifyData.valid) {
              return { valid: true, payer: getAddress(verifyData.payer || payer) };
            }
          }
        } catch {
          // Fall back to direct cryptographic verification
        }
      }
    }

    // 2. Cryptographic signature verification using viem
    const recipientAddr = payload.recipient || requirement?.recipient || "";
    const amountVal = payload.amount || requirement?.amount || "";
    const expiryVal = payload.expiry || payload.expiresAt || requirement?.expiresAt || "";
    const candidateMessages: string[] = [
      payload.message,
      `x402:${payer}:${recipientAddr}:${amountVal}:${payload.nonce}:${expiryVal}`,
      `x402:${payer}:${payload.recipient || ""}:${payload.amount || ""}:${payload.nonce}:${payload.expiry || ""}`,
      payload.nonce,
      `x402 payment: ${recipientAddr} amount: ${amountVal} nonce: ${payload.nonce}`,
      `x402-payment-auth:${payload.nonce}`,
      JSON.stringify({
        recipient: recipientAddr,
        amount: amountVal,
        nonce: payload.nonce,
      }),
    ].filter((m): m is string => Boolean(m));

    let signatureValid = false;
    for (const msg of candidateMessages) {
      try {
        const isValid = await verifyMessage({
          address: getAddress(payer),
          message: msg,
          signature: payload.signature as `0x${string}`,
        });
        if (isValid) {
          signatureValid = true;
          break;
        }
      } catch {
        // Continue trying candidate messages
      }
    }

    if (!signatureValid) {
      return { valid: false, error: "Cryptographic signature verification failed: signature does not match payer" };
    }

    return { valid: true, payer: getAddress(payer) };
  } catch (err: any) {
    return { valid: false, error: `Payment parsing failed: ${err.message}` };
  }
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

  return verifyX402Payment(paymentHeader, requirement);
}
