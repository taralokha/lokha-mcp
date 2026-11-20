/**
 * Real-time Gumroad Sales Webhook Handler
 * 
 * Route: POST /webhook/gumroad
 * - Fast Return: Acknowledges Gumroad within <50ms with HTTP 200 OK
 * - Background Processing (ctx.waitUntil):
 *   1. Parses sale payload (product, price in cents, buyer email, order number)
 *   2. Sends instant high-signal Telegram alert to Jith
 *   3. Records sale telemetry
 */

import { Env } from "./types";

const DEFAULT_TELEGRAM_BOT_TOKEN = "7868512117:AAHj317E3Vw2t86-g281V2ZomwTz3uY1hrc";
const DEFAULT_TELEGRAM_CHAT_ID = "704706927";

export async function handleGumroadWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse payload (Gumroad sends x-www-form-urlencoded or JSON)
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Failed to read request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: Record<string, any> = {};
  try {
    if (rawBody.trim().startsWith("{")) {
      payload = JSON.parse(rawBody);
    } else {
      const params = new URLSearchParams(rawBody);
      for (const [key, value] of params.entries()) {
        payload[key] = value;
      }
    }
  } catch {
    payload = {};
  }

  // Fast response to Gumroad
  const fastResponse = new Response(
    JSON.stringify({ ok: true, message: "Gumroad webhook received successfully" }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );

  // Background processing
  ctx.waitUntil(processGumroadSale(payload, env));

  return fastResponse;
}

async function processGumroadSale(payload: Record<string, any>, env: Env): Promise<void> {
  try {
    const productName = payload.product_name || payload.name || "Digital Product";
    const rawPrice = Number(payload.price || 0);
    const priceUsd = (rawPrice / 100).toFixed(2);
    const currency = (payload.currency || "usd").toUpperCase();
    const orderNumber = payload.order_number || payload.sale_id || "N/A";
    const email = payload.email || "anonymous";
    const maskedEmail = email.includes("@")
      ? `${email.slice(0, 3)}***@${email.split("@")[1]}`
      : email;

    const isRefund = payload.refunded === "true" || payload.refunded === true;
    const isDispute = payload.disputed === "true" || payload.disputed === true;

    console.log(`[Gumroad Webhook] Sale processed: "${productName}" - $${priceUsd} ${currency} (Order #${orderNumber})`);

    const botToken = env.TELEGRAM_BOT_TOKEN || DEFAULT_TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID || DEFAULT_TELEGRAM_CHAT_ID;

    if (botToken && chatId) {
      let message = "";
      if (isRefund) {
        message = `⚠️ <b>Gumroad Refund Processed</b>\n\n` +
          `• <b>Product:</b> ${escapeHtml(productName)}\n` +
          `• <b>Amount:</b> -$${priceUsd} ${currency}\n` +
          `• <b>Order:</b> #${orderNumber}`;
      } else if (isDispute) {
        message = `🚨 <b>Gumroad Dispute Alert</b>\n\n` +
          `• <b>Product:</b> ${escapeHtml(productName)}\n` +
          `• <b>Order:</b> #${orderNumber}`;
      } else {
        message = `🎉 <b>NEW GUMROAD SALE!</b> 💰\n\n` +
          `• <b>Product:</b> ${escapeHtml(productName)}\n` +
          `• <b>Revenue:</b> $${priceUsd} ${currency}\n` +
          `• <b>Customer:</b> <code>${escapeHtml(maskedEmail)}</code>\n` +
          `• <b>Order:</b> #${orderNumber}\n\n` +
          `<i>Fiat revenue deposited directly to creator payout account.</i>`;
      }

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      }).catch((e) => console.warn("[Telegram Alert Notice]:", e.message));
    }
  } catch (err: any) {
    console.warn("[Gumroad Webhook Processing Error]:", err.message);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
