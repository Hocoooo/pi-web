# Advisory subagent delegation with Jev

Pi Web's built-in subagent extension exposes `assess_subagent` alongside `Agent`.
It is an **on-demand advisory tool**, not an automatic per-turn router or an
`Agent` execution gate. It neither creates a child nor prevents one from running.
The generic `jev_evaluate` extension, if installed, remains independent; this
bounded integration does not depend on that package or its local installation path.

## Policy

- Keep simple tasks, quick iterations and tightly coupled sequential work in the
  parent. Do not assess each user message or tool call.
- Follow explicit user requests to use or avoid subagents, subject to existing
  permissions and availability. Skip Jev assessment for those requests.
- At a genuine planning tradeoff, use `assess_subagent` to evaluate a proposed
  bounded deliverable. Useful moments include upcoming heavy independent
  exploration, independent hypothesis verification after failures, or newly
  discovered parallel work.
- Complexity or a long conversation alone is not enough. Balance fresh-context,
  specialist and parallel-work benefits against handoff, waiting and shared-file
  coordination costs.
- The result is `direct`, `delegate`, or `unknown`. It is advice, not permission or
  a correctness guarantee; no confidence threshold automatically launches a child.
  `unknown` or service failure means continue normal judgment, not retry for advice.
- Reuse advice until the task/evidence changes. For independent investigation,
  prefer `inherit_context:false` with verified facts and explicit constraints
  rather than copying a drifting conversation.

This is a model-followed policy, not a deterministic guarantee that simple tasks
will never call the assessor or spawn children. No advice is consulted implicitly
when `Agent` runs; explicit requests can proceed without a remote round trip.

## Configuration and activation

1. Enable built-in subagents in Pi Web.
2. Set `TAPSVC_API_KEY` in the Pi Web server process environment for live Jev advice.
   This integration does not read keys from `models.json` or another provider's auth.
3. Restart the server after changing its environment. Reload existing sessions
   after updating the application so their tool descriptions and guidelines refresh.

`PI_SUBAGENT_ADVICE_TIMEOUT_MS` optionally sets the total request/body-reading
budget in milliseconds. Default: **3000**. Valid range: **250–10000**; invalid
values fall back to the default. There are **no retries**. Missing credentials,
HTTP errors, malformed responses and timeouts return advisory `unknown` with a
bounded fallback reason. Cancellation returns `cancelled`.

Like other built-in subagent tools, the assessor is not registered when built-in
subagents are disabled or in Chat-only sessions. It also rechecks the enabled
setting at execution time. It is excluded from child-session extension tools so
children cannot recursively assess orchestration.

## Data and cache boundaries

The tool accepts only:

- `task`: current goal, constraints and remaining work (up to 2000 characters).
- `candidate_task`: independent subtask and deliverable (up to 2000 characters).
- `tradeoffs`: evidence for **and against** delegation, including unknowns
  (up to 4000 characters).

Only these explicit summaries and a coarse host-provided context-usage band are
sent to `https://llm-proxy.tapsvc.com/api/alpha/decisions`, using the fixed
`typesafe/jev-1.13` model and a fixed classification rubric. The host does not
collect file contents, transcript text, system prompts or reasoning for this
request. Do not supply secrets or material unauthorized for external transmission.
Tool arguments and results can still be recorded in the ordinary Pi session log.
There is no per-call human confirmation dialog.

Successful advice is cached in memory for five minutes, at most 32 entries per
loaded advisor. The cache key hashes the normalized explicit packet, coarse usage
band, session identity and latest user/compaction entry on the current branch.
Session/entry IDs are local cache inputs only, never sent to Jev. Changed evidence,
a new user/compaction phase, another session, or a changed usage band results in a
fresh assessment. Transient failures are not cached; the model is instructed not
to loop on them. Reloading the extension discards its cache.

Upstream responses are size-limited and validated; only known recommendation,
confidence and probability fields are returned. Remote error bodies and arbitrary
metadata are never passed into the conversation. Confidence is reported, not
interpreted as a calibrated probability of correctness.

## Validation

`lib/subagent-advice.test.mjs` uses injected transports: request boundaries,
response validation, error sanitization, timeout/cancellation, bounded phase cache,
local-only identity, disabled behavior and advisory/non-blocking semantics.
`lib/subagent-extension.test.mjs` covers registration and policy guidance;
`lib/subagents.test.mjs` covers child-tool exclusion.

A live protocol smoke check with one synthetic parser-investigation packet returned
valid advisory `delegate` guidance in 376 ms. No project files or transcript text
were sent. This confirms one successful request with the current service, not
routing accuracy or a production latency benchmark.

These tests establish mechanics, not Jev routing accuracy or latency in production.
Before introducing hard gates, compare task completion time, unnecessary child
launches, missed useful delegation and rework on a representative task set.
