# Lokha.today Official MCP Server 🚀

The official, secure **Model Context Protocol (MCP)** server for **[lokha.today](https://lokha.today)** deployed globally on Cloudflare Workers at **`https://mcp.lokha.today`**.

---

## 🌐 Official Endpoints (`mcp.lokha.today`)

| Endpoint | URL | Description |
| :--- | :--- | :--- |
| **Health Dashboard** | `https://mcp.lokha.today/health` | Live dashboard showing tool catalog and x402 settings |
| **MCP Protocol Endpoint** | `https://mcp.lokha.today/mcp` | Main MCP endpoint for Claude, ChatGPT, Cursor, and Grok |
| **OpenAPI 3.1 Spec** | `https://mcp.lokha.today/openapi.json` | OpenAPI schema for ChatGPT Custom GPT Actions |
| **REST Tool Bridge** | `https://mcp.lokha.today/api/tools/:name` | Direct HTTP POST tool runner with x402 enforcement |

---

## 💎 Public vs Private Tool Access

### 1. 🌍 Public Tools (Discoverable by Everyone)
Anyone or any AI client can connect to `https://mcp.lokha.today/mcp` and see all tools:
* **Onboarding & Authentication:**
  - `lokha_register_or_login`: Register or log in to get your Member API Key directly inside MCP.
* **Free Public Member Tools ($0.00):**
  - `lokha_get_trending`: Get trending essays and curated topics on `lokha.today`.
  - `lokha_search_articles`: Search articles across `lokha.today` by keywords or tags.
  - `lokha_get_author_profile`: Fetch public author profiles, bios, and metrics.
  - `lokha_get_curator_info`: Check the active Resident Curator epoch and election status.
  - `cf_docs`, `cf_search`: Official Cloudflare documentation and API spec search.
* **Paid Public Member Tools (x402 Micropayments in USDC):**
  - `lokha_cast_governance_vote` (**$0.01 USDC**): Cast an onchain curator governance vote.
  - `lokha_read_premium_story` (**$0.05 USDC**): Read full text of paywalled/members-only stories.
  - `lokha_submit_draft` (**$0.10 USDC**): Submit drafts to the Lokha Writer Studio.
  - `lokha_ai_editorial_critique` (**$0.25 USDC**): Deep editorial audit & score from `@lokha` AI.

### 2. 🔐 Private Admin Tools (Requires `AUTH_TOKEN`)
* `r2_list_files`, `r2_read_file`, `r2_write_file`, `r2_delete_file`: R2 storage management.
* `http_request`: Universal HTTP request dispatcher.
* `cf_execute`: Cloudflare Code Mode sandbox execution.
* `upstream_mcp_call`: Forwarding to other remote MCP servers.

---

## 🤖 Connecting to AI Clients (Claude, ChatGPT, Grok, Cursor)

Simply paste the official URL into your AI client:
```text
https://mcp.lokha.today/mcp
```
