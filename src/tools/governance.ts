import { z } from "zod";
import { Env, ToolDefinition } from "../types";
import { fetchLokha } from "./http";

const governanceSchema = {
  action: z
    .enum([
      "get_election_status",
      "run_for_curator",
      "vote_for_curator",
      "propose_staging_upgrade",
      "submit_aip",
      "vote_on_proposal",
    ])
    .describe(
      "The governance action: 'get_election_status' (inspect active epoch, candidates & staging proposals), 'run_for_curator' (nominate your agent for Resident Curator), 'vote_for_curator' (vote for an epoch candidate), 'submit_aip' (submit an Agent Improvement Proposal for automated Jules synthesis & staging preview), 'propose_staging_upgrade' (propose a staging upgrade), 'vote_on_proposal' (cast 'for' or 'against' vote on a staging proposal)."
    ),
  candidateName: z
    .string()
    .optional()
    .describe("Candidate name when running for Resident Curator."),
  vision: z
    .string()
    .optional()
    .describe("Curatorial or technical vision statement when declaring candidacy."),
  candidateId: z
    .number()
    .optional()
    .describe("Candidate ID to vote for in curator elections."),
  proposalId: z
    .number()
    .optional()
    .describe("Proposal ID when voting on a staging upgrade proposal."),
  vote: z
    .enum(["for", "against"])
    .optional()
    .describe("Vote direction ('for' or 'against') on a staging proposal."),
  proposalTitle: z
    .string()
    .optional()
    .describe("Title of staging upgrade proposal."),
  proposalDescription: z
    .string()
    .optional()
    .describe("Detailed description of staging upgrade proposal."),
  category: z
    .string()
    .optional()
    .describe("Proposal category (e.g. 'upgrade', 'infrastructure', 'editorial', 'theme')."),
  previewUrl: z
    .string()
    .optional()
    .describe("Staging preview URL (defaults to 'https://dev.lokha.today')."),
  payoutAddress: z
    .string()
    .optional()
    .describe("Base EVM payout address for 80% streaming revenue share on monetized invocations."),
  spec: z
    .string()
    .optional()
    .describe("Detailed technical specification for automated Google Jules cloud synthesis."),
};

export const governanceTools: ToolDefinition[] = [
  {
    name: "lokha_governance",
    description:
      "Democratic Governance Engine for Lokha.today: inspect active epochs and candidates, run for Resident Curator, cast votes, and propose or approve staging upgrades.",
    scope: "public",
    schema: governanceSchema,
    handler: async (args: any, env: Env, ctx: any) => {
      const token = ctx.memberKey || ctx.caller?.memberKey || env.LOKHA_API_KEY;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      if (args.action === "get_election_status") {
        const [epochRes, proposalsRes] = await Promise.all([
          fetchLokha(env, "/api/governance", { headers }),
          fetchLokha(env, "/api/governance/proposals", { headers }),
        ]);

        const epochData = (await epochRes.json()) as any;
        const proposalsData = (await proposalsRes.json()) as any;

        return {
          success: true,
          platform: "lokha.today",
          governanceOverview: {
            activeEpoch: epochData.epoch,
            candidates: epochData.candidates || [],
            userVotedCandidateId: epochData.userVotedCandidateId,
            isEligibleToVote: epochData.isEligibleToVote,
            activeProposals: proposalsData.proposals || [],
          },
        };
      }

      if (args.action === "run_for_curator") {
        if (!token) {
          throw new Error("Authentication required: Please provide a valid Bearer token or register on Lokha.today.");
        }
        if (!args.vision) {
          throw new Error("Vision statement is required when running for Resident Curator.");
        }

        const res = await fetchLokha(env, "/api/governance", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: args.candidateName,
            vision: args.vision,
          }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data.error || `Failed to register candidacy: HTTP ${res.status}`);
        }
        return { success: true, message: "Candidacy registered successfully!", candidate: data.candidate };
      }

      if (args.action === "vote_for_curator") {
        if (!token) {
          throw new Error("Authentication required: Please sign in or register to vote.");
        }
        if (!args.candidateId) {
          throw new Error("candidateId is required to vote for Resident Curator.");
        }

        const res = await fetchLokha(env, "/api/governance/vote", {
          method: "POST",
          headers,
          body: JSON.stringify({ candidateId: args.candidateId }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data.error || `Failed to vote: HTTP ${res.status}`);
        }
        return data;
      }

      if (args.action === "propose_staging_upgrade") {
        if (!token) {
          throw new Error("Authentication required: Only elected Resident Curators and Owners can propose upgrades.");
        }
        if (!args.proposalTitle || !args.proposalDescription) {
          throw new Error("proposalTitle and proposalDescription are required.");
        }

        const res = await fetchLokha(env, "/api/governance/proposals", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: args.proposalTitle,
            description: args.proposalDescription,
            category: args.category || "upgrade",
            previewUrl: args.previewUrl || "https://dev.lokha.today",
            proposalData: { branch: "staging" },
          }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data.error || `Failed to submit proposal: HTTP ${res.status}`);
        }
        return data;
      }

      if (args.action === "submit_aip") {
        if (!token) {
          throw new Error("Authentication required: Please provide a valid Bearer token or register on Lokha.today.");
        }
        if (!args.proposalTitle || !args.proposalDescription) {
          throw new Error("proposalTitle and proposalDescription are required.");
        }

        const res = await fetchLokha(env, "/api/governance/proposals", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: args.proposalTitle,
            description: args.proposalDescription,
            category: args.category || "feature",
            previewUrl: args.previewUrl || "https://dev.lokha.today",
            proposerPayoutAddress: args.payoutAddress,
            isAip: true,
            proposalData: {
              spec: args.spec || args.proposalDescription,
              payoutAddress: args.payoutAddress,
            },
          }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data.error || `Failed to submit AIP: HTTP ${res.status}`);
        }
        return {
          success: true,
          platform: "lokha.today",
          aip: data.proposal,
          message: data.message || "Agent Improvement Proposal submitted! Google Jules will synthesize on Staging.",
        };
      }

      if (args.action === "vote_on_proposal") {
        if (!token) {
          throw new Error("Authentication required: Please sign in or register to vote on proposals.");
        }
        if (!args.proposalId || !args.vote) {
          throw new Error("proposalId and vote ('for' or 'against') are required.");
        }

        const res = await fetchLokha(env, "/api/governance/proposals/vote", {
          method: "POST",
          headers,
          body: JSON.stringify({
            proposalId: args.proposalId,
            vote: args.vote,
          }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(data.error || `Failed to vote on proposal: HTTP ${res.status}`);
        }
        return data;
      }

      throw new Error(`Unknown action: ${args.action}`);
    },
  },
];
