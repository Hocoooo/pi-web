import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createSubagentAdvisor, unavailableSubagentAdvice } from "./subagent-advice";

export function createSubagentAdviceTool(
  isEnabled: () => boolean,
  advise = createSubagentAdvisor(),
) {
  return defineTool({
    name: "assess_subagent",
    label: "Assess delegation",
    description: "Ask Jev for advisory-only direct/delegate/unknown guidance when delegation has a real tradeoff. Skip for simple quick iterations, explicit user delegation requests or prohibitions. Sends only your bounded task summary and a coarse context-usage metric to the external tapsvc service; never include secrets, full transcripts or material not authorized for transmission. Explain the remaining work, independent deliverable, isolation/parallel benefits, handoff dependencies and shared-file risks, including evidence against delegation. It does not launch or block Agent, grant permission, or replace planning. Unavailable/unknown advice means continue with normal judgment, not retry in a loop. Reuse advice until the task or evidence materially changes; confidence is not a correctness guarantee.",
    promptSnippet: "Get optional Jev advice for a genuine delegation tradeoff (no automatic launch or blocking)",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S", description: "Current goal, constraints and remaining work, not the full conversation." }),
      candidate_task: Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S", description: "Proposed bounded subtask and independently verifiable deliverable." }),
      tradeoffs: Type.String({ minLength: 1, maxLength: 4_000, pattern: "\\S", description: "Evidence for and against delegation: exploration left, failed attempts, fresh-context benefit, handoff cost, work the parent can do meanwhile, shared-file risks; state unknowns explicitly." }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let advice;
      if (!isEnabled()) {
        advice = unavailableSubagentAdvice("disabled");
      } else {
        // IDs remain local cache keys. Never read or forward message content.
        const branch = ctx.sessionManager.getBranch();
        const phase = branch.findLast((entry) => entry.type === "compaction" ||
          (entry.type === "message" && entry.message.role === "user"));
        advice = await advise(params, {
          scope: JSON.stringify([ctx.sessionManager.getSessionId(), phase?.id ?? null]),
          contextPercent: ctx.getContextUsage()?.percent,
          signal,
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          ...advice,
          guidance: "Advice only, not an execution gate. Respect the user's delegation instructions and existing permissions. For unknown/unavailable advice, continue normal judgment without retrying solely for a recommendation.",
        }) }],
        details: advice,
      };
    },
  });
}
