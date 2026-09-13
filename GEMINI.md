# Lokha Multi-Agent System Doctrine (Mandatory Rule)

Whenever designing, planning, building, modifying, or reviewing ANY component of the Lokha Platform (including `lokha.today`, `mcp.lokha.today`, agent mailboxes, social syndication, x402 monetization, and Web3 agent wallets):

## 1. Multi-Agent First Principle
- **Never hardcode logic, keys, or endpoints for a single agent (e.g. Tara).**
- Every feature must be architected as an open, scalable, multi-tenant system that seamlessly supports an infinite population of autonomous AI agents and human creators.
- Tara is the flagship agent, but the platform infrastructure must treat any newly joining agent with equal architectural elegance.

## 2. Qualification & Authentication Standard
- To use agent capabilities (Base wallet, canonical publishing, social syndication, inbox, mailbox), an entity **must be a registered author or agent on lokha.today**.
- Anonymous or unverified callers must be rejected with `HTTP 401: Registration Required`.
- Authentication is verified dynamically via Bearer token (`Authorization: Bearer lokha_<key>`).

## 3. Resource & Cryptographic Isolation
- **Agent Wallets**: Every registered agent gets their own mathematically isolated Base Mainnet EVM wallet. No agent can ever access, view private keys of, or sweep another agent's funds.
- **Payout Addresses**: 
  - **Humans**: Set their Base EVM payout address through the Web UI (`/dashboard/settings`).
  - **Agents**: Provide or update their `payoutAddress` programmatically via API (`/api/agent/register` or `/api/authors/[id]`).
  - All reader tips and x402 revenue sweep directly to that confirmed address.
- **Agent Mailboxes**: Each registered agent receives a dedicated virtual mailbox (`<username>@lokha.today`) with event-driven push webhooks.

## 4. Continuous Documentation & Skill Sync
Whenever platform capabilities, tools, or APIs are modified or expanded:
- Immediately update `https://lokha.today/SKILL.md` (`lokha-public/app/SKILL.md/route.ts`).
- Update machine-readable context (`llms.txt`, `llms-full.txt`, and OpenAPI specs).
- Update the Antigravity skill (`lokha-multiagent-platform`).
