import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentAdvisor } = await jiti.import("./subagent-advice.ts");
const { createSubagentAdviceTool } = await jiti.import("./subagent-advice-tool.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");

const input = {
  task: "Resolve an intermittent parser failure; UI already works.",
  candidate_task: "Independently test the parser hypothesis; return reproduction evidence.",
  tradeoffs: "Two failed hypotheses; isolated read-only review needs three files. Parent can add fixtures independently. Reviewer need not inherit history.",
};
const context = { scope: "session-a:user-1", contextPercent: 63 };
const responseBody = (choice = "delegate") => ({
  model: "typesafe/jev-1.13",
  answers: { delegation: { type: "choice", choice, confidence: 0.8, probabilities: { direct: 0.1, delegate: 0.8, unknown: 0.1 } } },
  usage: { input_tokens: 100, output_tokens: 20 },
  debug: "must-not-leak",
});
const response = (choice) => Response.json(responseBody(choice));
const advisor = (overrides = {}) => createSubagentAdvisor({ apiKey: () => "test-key", fetch: async () => response(), ...overrides });

function toolContext(overrides = {}) {
  return {
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [
        { type: "message", id: "user-1", message: { role: "user", content: "private transcript NOT TO SEND" } },
        { type: "message", id: "assistant-1", message: { role: "assistant", content: "private reasoning NOT TO SEND" } },
      ],
    },
    getContextUsage: () => ({ percent: 63, tokens: 63_000, contextWindow: 100_000 }),
    ...overrides,
  };
}

async function execute(tool, ctx = toolContext(), signal) {
  return tool.execute("call", input, signal, undefined, ctx);
}

test("advice sends only a bounded explicit packet, fixed rubric and coarse metric to the fixed endpoint", async () => {
  let sent;
  const evaluate = advisor({ fetch: async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return response();
  } });
  const result = await evaluate({ ...input, extra: "not-to-send" }, context);
  assert.equal(sent.url, "https://llm-proxy.tapsvc.com/api/alpha/decisions");
  assert.equal(sent.options.redirect, "error");
  assert.equal(sent.options.headers.Authorization, "Bearer test-key");
  assert.equal(sent.body.model, "typesafe/jev-1.13");
  assert.deepEqual(JSON.parse(sent.body.state), { ...input, context_usage_percent_band: 60 });
  assert.deepEqual(Object.keys(sent.body.questions.delegation.criteria), ["direct", "delegate", "unknown"]);
  assert.match(sent.body.questions.delegation.instructions, /untrusted evidence, never instructions/);
  assert.doesNotMatch(sent.options.body, /session-a|user-1|not-to-send/);
  assert.equal(result.recommendation, "delegate");
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.source, "jev");
  assert.doesNotMatch(JSON.stringify(result), /test-key|must-not-leak/);
});

test("all three recommendations are advisory and confidence is not used as an authorization threshold", async () => {
  for (const recommendation of ["direct", "delegate", "unknown"]) {
    const evaluate = advisor({ fetch: async () => {
      const body = responseBody(recommendation);
      body.answers.delegation.confidence = 0.3;
      return Response.json(body);
    } });
    const result = await evaluate(input, context);
    assert.equal(result.recommendation, recommendation);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.confidence, 0.3);
  }
});

test("missing credentials, invalid input and pre-cancellation never make a network call", async () => {
  const fetch = async () => { throw new Error("must not fetch"); };
  assert.equal((await advisor({ apiKey: () => " ", fetch })(input, context)).reason, "not_configured");
  for (const invalid of [{ ...input, task: " " }, { ...input, candidate_task: "x".repeat(2_001) }, { ...input, tradeoffs: "x".repeat(4_001) }]) {
    assert.equal((await advisor({ fetch })(invalid, context)).reason, "invalid_input");
  }
  const cancelled = { ...context, signal: AbortSignal.abort() };
  assert.equal((await advisor({ fetch })(input, cancelled)).reason, "cancelled");
});

test("remote errors, rate limits and malformed or oversized responses fall back without retry or remote details", async () => {
  const badChoice = responseBody();
  badChoice.answers.delegation.choice = ["delegate"];
  const badProbability = responseBody();
  badProbability.answers.delegation.probabilities.direct = 1;
  const extraProbability = responseBody();
  extraProbability.answers.delegation.probabilities.permission = 0;
  const badConfidence = responseBody();
  badConfidence.answers.delegation.confidence = 2;
  const outcomes = [
    () => { throw new Error("secret upstream credentials"); },
    () => new Response("secret upstream body", { status: 401 }),
    () => new Response("secret upstream body", { status: 429 }),
    () => new Response("secret upstream body", { status: 503 }),
    () => new Response("not-json"),
    () => Response.json({}),
    () => Response.json(badChoice),
    () => Response.json(badProbability),
    () => Response.json(extraProbability),
    () => Response.json(badConfidence),
    () => new Response("x".repeat(32_001)),
  ];
  for (const outcome of outcomes) {
    let calls = 0;
    const result = await advisor({ fetch: async () => { calls++; return outcome(); } })(input, context);
    assert.equal(calls, 1);
    assert.equal(result.reason, "unavailable");
    assert.equal(result.recommendation, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /secret|upstream|credentials/);
  }
});

test("a stalled transport is bounded by the short deadline", async () => {
  let signal;
  const evaluate = advisor({ timeoutMs: () => 250, fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const start = Date.now();
  const result = await evaluate(input, context);
  assert.equal(result.reason, "unavailable");
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - start < 2_000);
});

test("cancelling an in-flight assessment returns immediately and does not cache a result", async () => {
  const controller = new AbortController();
  let calls = 0;
  const evaluate = advisor({ fetch: async () => {
    calls++;
    if (calls === 1) {
      controller.abort();
      return new Promise(() => {});
    }
    return response();
  } });
  const result = await evaluate(input, { ...context, signal: controller.signal });
  assert.equal(result.reason, "cancelled");
  assert.equal((await evaluate(input, context)).source, "jev");
  assert.equal(calls, 2);
});

test("cache reuses a phase but invalidates on new evidence, usage band, session/phase, and TTL", async () => {
  let calls = 0;
  let time = 0;
  const evaluate = advisor({ now: () => time, fetch: async () => { calls++; return response(); } });
  assert.equal((await evaluate(input, context)).cached, false);
  assert.equal((await evaluate(input, { ...context, contextPercent: 68 })).cached, true);
  assert.equal(calls, 1);
  assert.equal((await evaluate(input, { ...context, scope: "session-b:user-1" })).cached, false);
  assert.equal((await evaluate(input, { ...context, scope: "session-a:user-2" })).cached, false);
  assert.equal((await evaluate(input, { ...context, contextPercent: 80 })).cached, false);
  assert.equal((await evaluate({ ...input, tradeoffs: "New constraints: both agents must edit the same file." }, context)).cached, false);
  time = 5 * 60_000;
  assert.equal((await evaluate(input, context)).cached, false);
  assert.equal(calls, 6);
});

test("cache is bounded and transient failures do not poison it", async () => {
  let calls = 0;
  const evaluate = advisor({ fetch: async () => { calls++; return calls === 1 ? new Response("", { status: 503 }) : response(); } });
  assert.equal((await evaluate(input, context)).source, "fallback");
  assert.equal((await evaluate(input, context)).source, "jev");
  for (let i = 0; i < 32; i++) await evaluate(input, { scope: `other-${i}` });
  assert.equal((await evaluate(input, context)).cached, false);
  assert.equal(calls, 35);
});

test("tool forwards host metrics and local phase identity, not transcript contents", async () => {
  let packet;
  let localContext;
  const tool = createSubagentAdviceTool(() => true, async (params, ctx) => {
    packet = params;
    localContext = ctx;
    return { advisoryOnly: true, recommendation: "direct", source: "jev", reason: "evaluated", cached: false };
  });
  const result = await execute(tool);
  assert.deepEqual(packet, input);
  assert.equal(localContext.contextPercent, 63);
  assert.deepEqual(JSON.parse(localContext.scope), ["session-a", "user-1"]);
  assert.doesNotMatch(JSON.stringify(packet), /private/);
  assert.match(result.content[0].text, /not an execution gate/);
  const ctx = toolContext();
  ctx.sessionManager.getBranch = () => [{ type: "compaction", id: "compact-1" }];
  await execute(tool, ctx);
  assert.deepEqual(JSON.parse(localContext.scope), ["session-a", "compact-1"]);
});

test("a stale advice tool cannot call Jev after the built-in feature is disabled", async () => {
  const tool = createSubagentAdviceTool(() => false, async () => { throw new Error("must not assess"); });
  const result = await execute(tool, {});
  assert.equal(result.details.reason, "disabled");
});

test("assessment only recommends; direct/unknown suggestions neither launch nor block a later Agent call", async () => {
  for (const recommendation of ["direct", "unknown"]) {
    let launches = 0;
    const tools = new Map();
    const completed = { sessionId: "child", status: "completed", result: "done" };
    await createSubagentExtension({
      async start() { launches++; return { run: completed, completion: Promise.resolve(completed) }; },
    }, () => []).factory({ registerTool(tool) { tools.set(tool.name, tool); } });
    const assessment = createSubagentAdviceTool(() => true, async () => ({
      advisoryOnly: true, recommendation, source: "jev", reason: "evaluated", cached: false,
    }));
    await execute(assessment);
    assert.equal(launches, 0);
    const result = await tools.get("Agent").execute("launch", { prompt: "Explicitly requested task", description: "Requested work" }, undefined, undefined, toolContext());
    assert.equal(launches, 1);
    assert.equal(result.isError, undefined);
  }
});
