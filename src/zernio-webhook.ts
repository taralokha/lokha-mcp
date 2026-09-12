/**
 * Real-time Instant Replies via Zernio Webhook + Letta Cloud + EverOS Memory
 *
 * Route: POST /webhook/zernio
 * - Verifies X-Zernio-Signature (HMAC-SHA256 lowercase hex of raw body with shared secret)
 * - Loop Guard: Drops own-account messages / comments
 * - Latency Guard: Returns HTTP 200 OK immediately (<150ms)
 * - Background Processing (ctx.waitUntil):
 *   1. Generates response using Letta Cloud Agent in Tara's persona
 *   2. Sends reply via Zernio API
 *   3. Persists conversation to EverOS memory
 */

import { Env } from "./types";

const DEFAULT_LETTA_AGENT_ID = "agent-ac206673-8b30-4551-b5ab-1b3e26dc71ec";
const DEFAULT_LETTA_API_KEY = "sk-let-OWIxM2M3MjEtM2I2MS00ZmU1LWJhYzAtNTY1MDNkNmJjNDA0OjIzYjA3NWI0LWE2ZTYtNDBlNi1iN2RmLTQ2NjU1MDc1NDQ2Mg==";
const DEFAULT_ZERNIO_API_KEY = "sk_207890ddac7feb19eb39b99da5d2203b9b9556b5d0206a524319529fa9581cc1";
const DEFAULT_EVEROS_API_KEY = "382263d3-609f-4449-8dfd-3df370605776";

const KNOWN_OWN_HANDLES = new Set(["tara_lokha", "lokha.today", "tara"]);

/**
 * Verify Zernio Webhook HMAC-SHA256 signature
 */
export async function verifyZernioSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;

  const cleanSig = (
    signatureHeader.startsWith("sha256=")
      ? signatureHeader.slice(7)
      : signatureHeader
  ).trim().toLowerCase();

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const hmac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(hmac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toLowerCase();

  return hex === cleanSig;
}

/**
 * Handle incoming Zernio Webhook request
 */
export async function handleZernioWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawBody = await request.text();
  const sigHeader =
    request.headers.get("X-Zernio-Signature") ||
    request.headers.get("x-zernio-signature") ||
    request.headers.get("X-Late-Signature") ||
    request.headers.get("x-late-signature");

  const secret = env.ZERNIO_WEBHOOK_SECRET;

  // Signature verification (if secret is configured)
  if (secret) {
    const isValid = await verifyZernioSignature(rawBody, sigHeader, secret);
    if (!isValid) {
      console.warn("[Zernio Webhook] Signature verification failed");
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Handle test webhook events immediately
  if (body.event === "webhook.test") {
    console.log("🔔 [Zernio Webhook] Test webhook event received successfully:", body.message || "Test ping");
    return new Response(
      JSON.stringify({
        received: true,
        test: true,
        message: "Webhook endpoint active and verified",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Loop Guard: Drop own-account messages / comments
  const isOwn =
    body.isOwnAccount === true ||
    body.comment?.author?.isOwnAccount === true ||
    body.message?.direction === "outbound" ||
    KNOWN_OWN_HANDLES.has(String(body.comment?.author?.username || "").toLowerCase()) ||
    KNOWN_OWN_HANDLES.has(String(body.message?.sender?.username || "").toLowerCase());

  if (isOwn) {
    console.log("🛡️ [Loop Guard] Dropping own-account message/comment to prevent infinite loops.");
    return new Response(
      JSON.stringify({ received: true, status: "ignored", reason: "own_account" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Latency Guard: Queue asynchronous background processing and return HTTP 200 in <150ms
  ctx.waitUntil(processZernioEventAsync(body, env));

  return new Response(
    JSON.stringify({
      received: true,
      event: body.event || "unknown",
      status: "processing",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Background Asynchronous Processing Pipeline:
 * Letta Cloud Agent -> Zernio Reply -> EverOS Memory
 */
async function processZernioEventAsync(body: any, env: Env): Promise<void> {
  const event = body.event || "";
  const isComment = event === "comment.received" || !!body.comment;
  const isMessage = event === "message.received" || !!body.message;

  if (!isComment && !isMessage) {
    console.log(`ℹ️ [Zernio Webhook] Unhandled event type: "${event}"`);
    return;
  }

  const lettaApiKey = env.LETTA_API_KEY || DEFAULT_LETTA_API_KEY;
  const lettaAgentId = env.LETTA_AGENT_ID || DEFAULT_LETTA_AGENT_ID;
  const zernioApiKey = env.ZERNIO_API_KEY || DEFAULT_ZERNIO_API_KEY;
  const everosApiKey = env.EVEROS_API_KEY || DEFAULT_EVEROS_API_KEY;

  let platform = "social";
  let incomingText = "";
  let authorName = "Friend";
  let contextPrompt = "";

  // 1. Context Extraction
  if (isComment) {
    const comment = body.comment || {};
    platform = comment.platform || body.account?.platform || "social";
    authorName = comment.author?.name || (comment.author?.username ? `@${comment.author.username}` : "Friend");
    incomingText = comment.text || "";
    const postContent = body.post?.content || "";

    contextPrompt = `[Social Incoming Comment on ${platform}]
Author: ${authorName}
Post Context: "${postContent}"
User Comment: "${incomingText}"

Instructions:
Craft a concise, warm, helpful public reply (1-3 sentences) in Tara's persona:
- Grounded in cellular vitality, mindful prana, natural radiance, and gentle warmth.
- Empathetic, encouraging, and scientifically sound.
- Strict constraint: DO NOT mention "Isha Foundation", "Isha", or "Sadhguru".
Reply directly to the user with no quotation marks.`;
  } else if (isMessage) {
    const message = body.message || {};
    platform = message.platform || body.account?.platform || "social";
    authorName = message.sender?.name || (message.sender?.username ? `@${message.sender.username}` : "Friend");
    incomingText = message.text || "";

    contextPrompt = `[Social Incoming Direct Message on ${platform}]
From: ${authorName}
Message: "${incomingText}"

Instructions:
Craft an empathetic, insightful, concise response in Tara's persona:
- Grounded in positive prana, holistic nourishment, and cellular well-being.
- Strict constraint: DO NOT mention "Isha Foundation", "Isha", or "Sadhguru".
Reply directly to the user with no quotation marks.`;
  }

  if (!incomingText.trim()) {
    console.log("[Zernio Webhook] Empty text in event; skipping processing.");
    return;
  }

  console.log(`💬 [Zernio Webhook] Processing ${isComment ? "comment" : "message"} from ${authorName} on ${platform}...`);

  // 2. Generate Reply via Letta Cloud Agent
  let replyText = "";
  try {
    const lettaRes = await fetch(`https://api.letta.com/v1/agents/${lettaAgentId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lettaApiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "LettaClient/1.0",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: contextPrompt }],
      }),
    });

    if (lettaRes.ok) {
      const lettaData = (await lettaRes.json()) as any;
      const assistantMsg = lettaData.messages?.find(
        (m: any) => m.message_type === "assistant_message"
      );
      if (assistantMsg?.content) {
        replyText = assistantMsg.content.trim();
        // Remove surrounding quotes if model added them
        if (replyText.startsWith('"') && replyText.endsWith('"')) {
          replyText = replyText.slice(1, -1).trim();
        }
      }
    } else {
      const errBody = await lettaRes.text().catch(() => "");
      console.warn(`[Letta Agent Notice]: HTTP ${lettaRes.status}: ${errBody.slice(0, 150)}`);
    }
  } catch (err: any) {
    console.warn(`[Letta Agent Error]: ${err.message}`);
  }

  // Fallback if Letta reply unavailable
  if (!replyText) {
    replyText = isComment
      ? "Thank you so much for your thoughts! Wishing you radiant energy and lightness today. 🌱✨"
      : "Thank you for reaching out! Wishing you deep cellular vitality and peace today. 🌱✨";
  }

  console.log(`🤖 [Tara Reply Crafted]: "${replyText}"`);

  // 3. Post Reply via Zernio API
  try {
    if (isComment) {
      const postId =
        body.comment?.postId ||
        body.comment?.platformPostId ||
        body.post?.id ||
        body.post?.platformPostId;
      const accountId = body.account?.id || body.account?.accountId;
      const commentId = body.comment?.id;

      if (!postId || !accountId) {
        console.warn("[Zernio Webhook] Missing postId or accountId to reply to comment.");
      } else {
        const replyPayload: Record<string, any> = {
          accountId,
          message: replyText,
        };
        if (commentId) {
          replyPayload.commentId = commentId;
        }

        const zernioRes = await fetch(
          `https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(postId)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${zernioApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(replyPayload),
          }
        );

        if (zernioRes.ok) {
          console.log(`✅ [Zernio Reply Sent] Successfully replied to comment on post ${postId}`);
        } else {
          const errText = await zernioRes.text().catch(() => "");
          console.warn(`[Zernio Comment Reply Notice]: HTTP ${zernioRes.status}: ${errText.slice(0, 150)}`);
        }
      }
    } else if (isMessage) {
      const conversationId = body.conversation?.id || body.message?.conversationId;

      if (!conversationId) {
        console.warn("[Zernio Webhook] Missing conversationId to send DM reply.");
      } else {
        const zernioRes = await fetch(
          `https://zernio.com/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${zernioApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: replyText }),
          }
        );

        if (zernioRes.ok) {
          console.log(`✅ [Zernio DM Sent] Successfully sent DM to conversation ${conversationId}`);
        } else {
          const errText = await zernioRes.text().catch(() => "");
          console.warn(`[Zernio DM Notice]: HTTP ${zernioRes.status}: ${errText.slice(0, 150)}`);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[Zernio API Post Error]: ${err.message}`);
  }

  // 4. Persist Turn to EverOS Biological Memory Layer
  if (everosApiKey) {
    try {
      const cleanSessionId = `zernio_${platform}_${authorName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      await fetch("https://api.evermind.ai/api/v2/memory/add", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${everosApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: cleanSessionId,
          messages: [
            {
              sender_id: authorName,
              role: "user",
              timestamp: Date.now() - 1000,
              content: incomingText,
            },
            {
              sender_id: "tara",
              role: "assistant",
              timestamp: Date.now(),
              content: replyText,
            },
          ],
          async_mode: true,
        }),
      });
      console.log(`🧠 [EverOS Memory] Interaction persisted for session: ${cleanSessionId}`);
    } catch (err: any) {
      console.warn(`[EverOS Memory Notice]: ${err.message}`);
    }
  }
}
