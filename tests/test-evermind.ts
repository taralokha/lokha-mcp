import assert from "node:assert";
import { evermindTools } from "../src/tools/evermind.ts";
import { allTools, generateOpenAPISpec } from "../src/tools/index.ts";
import { CallerProfile, Env } from "../src/types.ts";

const mockEnv: Env = {
  EVEROS_API_KEY: "382263d3-609f-4449-8dfd-3df370605776",
};

const anonymousCaller: CallerProfile = {
  role: "anonymous",
  isPaid: false,
  isAgent: false,
  dailyLimit: 20,
  usedToday: 0,
  hourlyLimit: 10,
  usedThisHour: 0,
  isOwner: false,
  isCurator: false,
  isAuthor: false,
};

const callerWithoutIdentity: CallerProfile = {
  role: "agent",
  isPaid: true,
  isAgent: true,
  dailyLimit: 200,
  usedToday: 0,
  hourlyLimit: 60,
  usedThisHour: 0,
  isOwner: false,
  isCurator: false,
  isAuthor: true,
  // username, email, and id are intentionally undefined
};

const bobAgentCaller: CallerProfile = {
  username: "bob",
  role: "agent",
  isPaid: true,
  isAgent: true,
  dailyLimit: 200,
  usedToday: 0,
  hourlyLimit: 60,
  usedThisHour: 0,
  isOwner: false,
  isCurator: false,
  isAuthor: true,
};

const aliceSubscriberCaller: CallerProfile = {
  username: "alice",
  role: "subscriber",
  isPaid: true,
  isAgent: false,
  dailyLimit: 200,
  usedToday: 0,
  hourlyLimit: 60,
  usedThisHour: 0,
  isOwner: false,
  isCurator: false,
  isAuthor: false,
};

const ownerCaller: CallerProfile = {
  username: "jith",
  role: "owner",
  isPaid: true,
  isAgent: false,
  dailyLimit: 999999,
  usedToday: 0,
  hourlyLimit: 999999,
  usedThisHour: 0,
  isOwner: true,
  isCurator: true,
  isAuthor: true,
};

async function runTests() {
  console.log("=== RUNNING EXTENSIVE EVERMIND TOOL SUITE TESTS ===");

  // 1. Tool Registration in allTools & generateOpenAPISpec
  console.log("Test 1: Tool registration in allTools & OpenAPI...");
  const toolNames = evermindTools.map((t) => t.name);
  assert.strictEqual(toolNames.length, 6, "Expected 6 Evermind tools");
  assert.ok(toolNames.includes("lokha_memory_search"));
  assert.ok(toolNames.includes("lokha_memory_add"));
  assert.ok(toolNames.includes("lokha_memory_get_profile"));
  assert.ok(toolNames.includes("lokha_memory_get_skills"));
  assert.ok(toolNames.includes("lokha_memory_flush"));
  assert.ok(toolNames.includes("lokha_memory_forget"));

  for (const name of toolNames) {
    const found = allTools.find((t) => t.name === name);
    assert.ok(found, `Tool ${name} should be in allTools`);
  }

  const spec = generateOpenAPISpec("https://mcp.lokha.today", bobAgentCaller);
  for (const name of toolNames) {
    assert.ok(spec.paths[`/api/tools/${name}`], `OpenAPI spec should expose /api/tools/${name}`);
  }
  console.log("✅ Tool registration & OpenAPI spec passed.");

  // 2. Anonymous Authentication Check
  console.log("Test 2: Anonymous caller rejection...");
  for (const tool of evermindTools) {
    const res = await tool.handler({ query: "test", session_id: "test", target_type: "session" }, mockEnv, {
      caller: anonymousCaller,
    });
    assert.strictEqual(res.ok, false, `Anonymous caller should be rejected by ${tool.name}`);
    assert.ok(res.error.includes("Authentication Required"), `Expected error text in ${tool.name}`);
  }
  console.log("✅ Anonymous rejection passed.");

  // 3. Caller Lacking Verifiable Identity Rejection
  console.log("Test 3: Caller lacking verifiable identity rejection...");
  for (const tool of evermindTools) {
    const res = await tool.handler({ query: "test", session_id: "test", target_type: "session" }, mockEnv, {
      caller: callerWithoutIdentity,
    });
    assert.strictEqual(res.ok, false, `Identity-less caller should be rejected by ${tool.name}`);
    assert.ok(
      res.error.includes("Authentication Incomplete") || res.error.includes("Tenant Isolation Violation"),
      `Expected identity rejection error in ${tool.name}: ${res.error}`
    );
  }
  console.log("✅ Identity-less caller rejection passed.");

  // 4. Multi-Agent Tenant Isolation
  console.log("Test 4: Multi-agent tenant isolation...");
  const searchTool = evermindTools.find((t) => t.name === "lokha_memory_search")!;
  const bobTamperSearch = await searchTool.handler(
    { query: "vitality", agent_id: "alice" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperSearch.ok, false);
  assert.ok(bobTamperSearch.error.includes("Tenant Isolation Violation"));

  const getSkillsTool = evermindTools.find((t) => t.name === "lokha_memory_get_skills")!;
  const bobTamperSkills = await getSkillsTool.handler(
    { agent_id: "alice" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperSkills.ok, false);
  assert.ok(bobTamperSkills.error.includes("Tenant Isolation Violation"));

  const getProfileTool = evermindTools.find((t) => t.name === "lokha_memory_get_profile")!;
  const bobTamperProfile = await getProfileTool.handler(
    { user_id: "alice" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperProfile.ok, false);
  assert.ok(bobTamperProfile.error.includes("Tenant Isolation Violation"));

  const forgetTool = evermindTools.find((t) => t.name === "lokha_memory_forget")!;
  const bobTamperForget = await forgetTool.handler(
    { target_type: "agent", target_id: "alice" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperForget.ok, false);
  assert.ok(bobTamperForget.error.includes("Tenant Isolation Violation"));

  // Cross-tenant session hijacking tests
  const flushTool = evermindTools.find((t) => t.name === "lokha_memory_flush")!;
  const bobTamperFlush1 = await flushTool.handler(
    { session_id: "session_alice_convo_1" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperFlush1.ok, false);
  assert.ok(bobTamperFlush1.error.includes("Tenant Isolation Violation"));

  const bobTamperFlush2 = await flushTool.handler(
    { session_id: "alice:session_xyz" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperFlush2.ok, false);
  assert.ok(bobTamperFlush2.error.includes("Tenant Isolation Violation"));

  const bobTamperForgetSession1 = await forgetTool.handler(
    { target_type: "session", session_id: "session_alice_convo_1" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperForgetSession1.ok, false);
  assert.ok(bobTamperForgetSession1.error.includes("Tenant Isolation Violation"));

  const addTool = evermindTools.find((t) => t.name === "lokha_memory_add")!;
  const bobTamperAddSession = await addTool.handler(
    { session_id: "session_alice_private", content: "malicious injected turn" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobTamperAddSession.ok, false);
  assert.ok(bobTamperAddSession.error.includes("Tenant Isolation Violation"));
  console.log("✅ Multi-agent tenant isolation passed.");

  // 5. Intelligent Default Scoping (Agent vs Human Subscriber)
  console.log("Test 5: Intelligent Default Scoping (Agent vs Human)...");
  // Agent caller with no agent_id or user_id defaults to agent_id
  const bobDefaultSearch = await searchTool.handler(
    { query: "autonomous settlement" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(bobDefaultSearch.ok, true);
  assert.strictEqual(bobDefaultSearch.scopedTo.agent_id, "bob");
  assert.strictEqual(bobDefaultSearch.scopedTo.user_id, undefined);

  // Human subscriber caller with no agent_id or user_id defaults to user_id
  const aliceDefaultSearch = await searchTool.handler(
    { query: "reading preferences" },
    mockEnv,
    { caller: aliceSubscriberCaller }
  );
  assert.strictEqual(aliceDefaultSearch.ok, true);
  assert.strictEqual(aliceDefaultSearch.scopedTo.user_id, "alice");
  assert.strictEqual(aliceDefaultSearch.scopedTo.agent_id, undefined);
  console.log("✅ Intelligent default scoping passed.");

  // 6. Timestamp Normalization & Historical Chronology Preservation
  console.log("Test 6: Timestamp normalization & empty message validation...");
  const pastUnixSeconds = 1700000000; // Historical timestamp in seconds
  const addHistoricalRes = await addTool.handler(
    {
      session_id: "history_test",
      messages: [
        {
          sender_id: "bob",
          role: "assistant",
          content: "Historical memory turn from past epoch",
          timestamp: pastUnixSeconds,
        },
      ],
    },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(addHistoricalRes.ok, true);
  // Verify session was auto-namespaced to Bob
  assert.ok(addHistoricalRes.sessionId.startsWith("session_bob_"));

  // Empty content validation
  const emptyMessageRes = await addTool.handler(
    {
      session_id: "empty_test",
      messages: [
        {
          sender_id: "bob",
          role: "assistant",
          content: "   ",
        },
      ],
    },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(emptyMessageRes.ok, false);
  assert.ok(emptyMessageRes.error.includes("empty content"));
  console.log("✅ Timestamp normalization and validation passed.");

  // 7. Owner Privilege (Bypass Tenant Isolation)
  console.log("Test 7: Platform Owner memory inspection across agents...");
  const ownerSearch = await searchTool.handler(
    { query: "prana", agent_id: "tara" },
    mockEnv,
    { caller: ownerCaller }
  );
  assert.strictEqual(ownerSearch.ok, true, `Owner should successfully inspect tara memory: ${JSON.stringify(ownerSearch)}`);
  assert.strictEqual(ownerSearch.scopedTo.agent_id, "tara");
  console.log("✅ Platform Owner cross-agent inspection passed.");

  // 8. Live Memory Lifecycle (Add -> Flush -> Get Profile -> Get Skills -> Forget)
  console.log("Test 8: Live Evermind Memory Lifecycle (Add -> Flush -> Get -> Forget)...");
  const testSession = `session_bob_live_full_${Date.now()}`;

  // Add single message
  const addRes1 = await addTool.handler(
    {
      session_id: testSession,
      content: "Bob verified full cognitive memory isolation and RRF indexing.",
      role: "assistant",
    },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(addRes1.ok, true, `Add single message failed: ${JSON.stringify(addRes1)}`);
  assert.strictEqual(addRes1.persistedTurns, 1);

  // Add batch messages
  const addRes2 = await addTool.handler(
    {
      session_id: testSession,
      messages: [
        {
          sender_id: "bob",
          role: "user",
          content: "Can we verify agent memory extraction in production?",
        },
        {
          sender_id: "bob",
          role: "assistant",
          content: "Yes, Evermind cognitive pipeline is fully verified.",
        },
      ],
    },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(addRes2.ok, true, `Add batch messages failed: ${JSON.stringify(addRes2)}`);
  assert.strictEqual(addRes2.persistedTurns, 2);

  // Flush memory session
  const flushRes = await flushTool.handler(
    { session_id: testSession },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(flushRes.ok, true, `Flush failed: ${JSON.stringify(flushRes)}`);
  console.log("  Memory flushed successfully:", flushRes.status);

  // Get Profile
  const profileRes = await getProfileTool.handler(
    { memory_type: "profile" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(profileRes.ok, true, `Get profile failed: ${JSON.stringify(profileRes)}`);

  // Get Skills
  const skillsRes = await getSkillsTool.handler(
    { memory_type: "agent_skill" },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(skillsRes.ok, true, `Get skills failed: ${JSON.stringify(skillsRes)}`);

  // Forget session
  const forgetRes = await forgetTool.handler(
    { target_type: "session", session_id: testSession },
    mockEnv,
    { caller: bobAgentCaller }
  );
  assert.strictEqual(forgetRes.ok, true, `Forget session failed: ${JSON.stringify(forgetRes)}`);
  console.log("  Memory session deleted successfully.");

  console.log("=== ALL EXTENSIVE EVERMIND TESTS PASSED SUCCESSFULLY ===");
}

runTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
