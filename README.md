# Lokha.today Official MCP Server 🚀

The official, secure **Model Context Protocol (MCP)** server for **[lokha.today](https://lokha.today)** deployed globally on Cloudflare Workers at **`https://mcp.lokha.today`**.

---

## 🌐 Official Endpoints (`mcp.lokha.today`)

| Endpoint | URL | Description |
| :--- | :--- | :--- |
| **Health Dashboard** | `https://mcp.lokha.today/health` | Live dashboard showing tool catalog and x402 settings |
| **MCP Protocol Endpoint** | `https://mcp.lokha.today/mcp` | Main MCP endpoint for Claude, ChatGPT, Cursor, and Grok |
| **OpenAPI 3.1 Spec** | `https://mcp.lokha.today/openapi.json` | OpenAPI schema for ChatGPT Actions and Grok |
| **REST Tool Bridge** | `https://mcp.lokha.today/api/tools/:name` | Direct HTTP POST tool runner |

---

## 💎 Full Social Media Multi-Step Suite (Zernio & Buffer)

Grok, Claude, and ChatGPT can now execute best-in-class multi-step campaigns across 16+ social networks:

### 1. ⚡ Zernio Tools
* `zernio_list_accounts`: List connected accounts across X/Twitter, LinkedIn, Threads, Bluesky, Instagram, TikTok, Reddit, Facebook, YouTube, etc.
* `zernio_publish_post`: Standalone publishing, scheduling (`scheduledFor`), drafting, platform targeting, media URLs, and link previews.
* `zernio_get_queue`: Inspect scheduled queue, drafts, and recent posts with per-network delivery receipts.
* `zernio_manage_post`: Get details, reschedule, update, or cancel/delete posts by `postId`.
* `zernio_get_analytics`: Fetch engagement analytics (impressions, clicks, shares) across accounts or posts.
* `zernio_api_call`: **Universal Raw API Executor** — call ANY Zernio REST endpoint (`/v1/*`), exposing 100% of Zernio's API capabilities.

### 2. ⚡ Buffer GraphQL Tools
* `buffer_list_channels`: Query Buffer GraphQL API to retrieve connected channels and metadata.
* `buffer_create_post`: Publish, queue, or schedule posts with media assets across Buffer channels.
* `buffer_graphql_query`: **Buffer GraphQL Escape Hatch** — execute arbitrary queries or mutations against Buffer's GraphQL API.

### 3. 🎯 Multi-Step Agent Orchestrator
* `social_multistep_orchestrator`: Coordinated workflows:
  * `"inspect"`: Discovers all connected channels across both Buffer and Zernio and returns platform limits.
  * `"preview"`: Previews platform-tailored copy (checks 280-char X limits, formats LinkedIn/Threads copy).
  * `"broadcast"`: Executes multi-platform distribution across both providers in a single tool call.
  * `"status"`: Checks queue and delivery status.
* `lokha_broadcast_to_socials`: Syndicate Lokha articles or broadcast standalone copy.

---

## 🤖 Connecting to AI Clients (Grok, Claude, ChatGPT, Cursor)

Paste the official URL into your AI client:
```text
https://mcp.lokha.today/mcp
```
