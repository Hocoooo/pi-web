const model = "sub2api_access/gpt-6.1-sol:high";
const cwd = "/Users/noname/GitProjects/pi-web";
const branch = "feature/task-dashboard";
const baseline = "/tmp/pi-web-dashboard-baseline-c9gxnkb8";
const tickets = [
  ["01", "persistent-task-board", []],
  ["02", "task-details-and-cards", ["01"]],
  ["03", "drag-and-manual-order", ["01"]],
  ["04", "link-existing-sessions", ["01"]],
  ["05", "filters-and-saved-views", ["02", "03", "04"]],
  ["06", "shared-context-versions", ["01"]],
  ["07", "ai-context-summary", ["04", "06"]],
  ["08", "start-task-session", ["04", "06"]],
  ["09", "accept-context-updates", ["08"]],
  ["10", "reassign-session", ["09"]],
  ["11", "inherit-task-on-fork", ["04"]],
  ["12", "archive-and-restore", ["08"]],
  ["13", "customize-status-columns", ["01"]],
  ["14", "remove-status-column", ["12", "13"]]
];
const common = `You are working on the operator-approved Pi Web Task Dashboard implementation.
Repo/cwd: ${cwd}. Required branch: ${branch}. Initial HEAD: 85cc4f38b563053b4e473e50257cde3c9cb6d931.
Operator expressly requests GPT-6.1 Sol with high thinking for all children, clear modules, useful abstractions, no overengineering or excessive defensive layers, and reuse of existing capabilities. The parent owns acceptance and scheduling.
Read AGENTS.md and docs/branch-features/README.md FIRST before each development iteration, then affected linked feature contracts, relevant docs/agents notes and ADRs, GLOSSARY.md, docs/agents/issue-tracker.md, and the full .scratch/task-dashboard/spec.md. Read your complete ticket. Research recommendations are not approved dependencies.
Preserve all pre-existing work. The initial dirty-document snapshot is ${baseline}. Do not edit the parent spec, unrelated agent configuration, other tickets, or this orchestration script. No reset, stash, checkout/discard, git commit, push, remote publication, global installation, destructive cleanup, or switching branches. No nested subagents or external CLI fallback. Never use next build.
Only one child may write this checkout; all stages are serial. Do not introduce a second Agent engine, generic repository framework, redundant wrappers, duplicate task rules, speculative features, or catch-and-ignore fallbacks. Keep meaningful module boundaries and test public behavior. Retain real authorization, concurrency, persistence and input-boundary checks required by the spec; 'not overdefensive' does not mean weakening them.
The approved test seams are: unified task operations with real temporary storage, existing session/SDK integration with synthetic histories and mocked providers, and browser user flows. Read /Users/noname/.agents/skills/tdd/SKILL.md and its testing/mocking references before implementation; use small red/green vertical slices at these already-approved seams. Do not ask the user to reconfirm them.
The dev service was listening on 127.0.0.1:30141, PID 95436 at setup. Verify and reuse it; NEVER start a second Next dev even on another port in this checkout. Do not restart it without parent approval. Use temporary agent dirs for backend tests, synthetic SDK histories, and mocked API fixtures for browser tests against the existing service. Do not mutate the real user's sessions/tasks or call real paid providers. Do not run the self-starting npm run test:e2e while this dev server occupies the checkout. No global install or host-service change without approval.
Run focused behavior tests, tsc --noEmit, lint, and the relevant existing regression suite. At ticket 01 capture the baseline test state before edits. Do not claim a skipped Windows/Safari/real-provider check passed. If needed, surface specific validation gaps to the parent; failing implementation tests, incomplete acceptance, or infrastructure/tooling failures must not be hidden or marked resolved.
Infrastructure failures (workflow, child startup, runtime, extension or tool setup) are STOP conditions: record exact failure, run/cwd/branch, current changed files and evidence; do not retry by changing protocol or launching a CLI. Use contact_supervisor for a material decision/blocker and concise progress updates, not generic intercom targets.
All reports use the run's bound output artifact. Keep noisy logs and snapshots under a unique temporary directory, not repo-root report files. Return actual paths to those artifacts. Check the branch and current ticket status before any source write.`;
const implementationSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["ready_for_review", "blocked"] },
    ticket: { type: "string" },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    baselineSnapshotPath: { type: "string" },
    checks: { type: "array", items: { type: "object", properties: {
      command: { type: "string" }, result: { type: "string", enum: ["passed", "failed", "not_run"] }, evidencePath: { type: "string" }, note: { type: "string" }
    }, required: ["command", "result", "evidencePath", "note"], additionalProperties: false } },
    blockingIssues: { type: "array", items: { type: "string" } },
    residualRisks: { type: "array", items: { type: "string" } }
  },
  required: ["outcome", "ticket", "summary", "changedFiles", "baselineSnapshotPath", "checks", "blockingIssues", "residualRisks"],
  additionalProperties: false
};
const reviewSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approved", "changes_requested", "stop"] },
    ticket: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    residualRisks: { type: "array", items: { type: "string" } },
    parentReceipt: { type: "string" },
    observedTicketStatus: { type: "string" }
  },
  required: ["decision", "ticket", "summary", "findings", "evidence", "residualRisks", "parentReceipt", "observedTicketStatus"],
  additionalProperties: false
};
function record(stage, result) {
  return { stage, runId: result.runId, ok: result.ok, outputReference: result.outputReference, outputPathMapping: result.outputPathMapping, artifactPaths: result.artifactPaths, structuredOutput: result.structuredOutput, output: result.output };
}
const evidence = [];
const completed = [];
for (const [id, slug, blockers] of tickets) {
  if (!blockers.every(b => completed.includes(b))) return { state: "blocked", reason: "dependency_not_accepted", ticket: id, completed, evidence };
  const ticketPath = `.scratch/task-dashboard/issues/${id}-${slug}.md`;
  let accepted = false;
  let repair = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = `ticket-${id}-implementation-${attempt}`;
    emit({ stage: "implementation", ticket: id, attempt, completed });
    const implemented = await runs.run(key, {
      label: `${attempt ? "Fix" : "Implement"} task dashboard ${id}`,
      agent: "worker", model, context: "fresh", cwd, worktree: false,
      timeoutMs: 7200000, acceptance: false, outputSchema: implementationSchema,
      output: `tickets/${id}/implementation-${attempt}.json`,
      task: `${common}\n\nImplement ONLY ticket ${id}: ${ticketPath}. Approved blockers: ${blockers.join(", ") || "none"}; independently verify their on-disk statuses are resolved before claiming. Set this ticket Status to claimed before beginning. Never mark it resolved: parent acceptance is required.\nCapture a per-ticket BEFORE snapshot/manifest and a bounded reviewable patch including newly created source files in a temporary evidence directory, so the reviewer can distinguish this ticket from the existing dirty work and prior tickets. Preserve the original ticket snapshot across repair attempts; record actual report paths.\nDeliver the entire narrow vertical slice, including schema/storage as needed, backend, usable UI, behavior tests and updated feature contracts/index. Run focused tests and applicable gates. Do not check off unverified acceptance criteria. If an environmental gap is non-blocking, make it explicit for parent disposition, not an invented pass.\nOn a repair attempt fix only parent-accepted findings below plus tests/contracts they require, not unrelated improvements.\n${repair || "This is the first implementation pass. Investigate only the scope needed by this ticket; use existing modules before adding a new abstraction."}\nReturn the structured implementation report. outcome=ready_for_review only when implementation tests/gates have no unresolved failures and the deliverable is ready for evidence review. No final completion approval request is needed from you; a separate fresh reviewer follows. If a material issue blocks work, contact_supervisor while active, then accurately report blocked if unresolved.`
    });
    evidence.push(record(key, implemented));
    const ir = implemented.structuredOutput;
    if (!implemented.ok || !ir || ir.outcome !== "ready_for_review" || ir.blockingIssues.length) return { state: "blocked", reason: "implementation_or_infrastructure_blocker", ticket: id, completed, evidence };
    const reviewKey = `ticket-${id}-review-${attempt}`;
    const reviewed = await runs.run(reviewKey, {
      label: `Review task dashboard ${id}`,
      agent: "reviewer", model, context: "fresh", cwd, worktree: false,
      timeoutMs: 7200000, acceptance: false, outputSchema: reviewSchema,
      output: `tickets/${id}/review-${attempt}.json`,
      task: `${common}\n\nYou are the fresh, READ-ONLY evidence reviewer for ${ticketPath}. Do NOT edit source, docs, tickets, or git state. Writing the bound report and temporary test outputs is allowed. No nested subagents. Review both repo standards and the originating ticket/spec; prioritize concrete bugs, regressions, untested behavior, overengineering and duplicate mechanisms, not speculative preferences.\nImplementation report: ${JSON.stringify(ir)}\nBound implementation output: ${JSON.stringify(implemented.outputReference || implemented.outputPathMapping || implemented.artifactPaths || "see implementation report")}.\nInspect the actual per-ticket delta against the writer's BEFORE snapshot (including untracked files), relevant surrounding code, contracts and tests. Reproduce focused checks as appropriate; do not treat the writer report or source-string assertions as proof. Classify each issue with concrete file/line, failure scenario, impact and proposed minimal fix. No automatic false blocker for explicitly optional/unavailable real-platform validation; report the gap for parent disposition.\nMANDATORY PARENT ACCEPTANCE BARRIER: when your review is ready, use contact_supervisor(reason=need_decision) to send your proposed approve/fix/stop decision, evidence and remaining gaps. Ask the parent to inspect and decide. If you recommend approval, the parent—not you—will verify and update the ticket to resolved with accurate checklist evidence. Wait for that decision before finalizing; this is a real acceptance gate, not a routine completion notification. If contact_supervisor is unavailable, STOP and report it, do not invent an intercom target or approve yourself.\nReturn structured decision reflecting the parent's actual receipt. decision=approved is allowed ONLY after explicit parent acceptance and independently reading this ticket Status=resolved with no unresolved implementation failures. Otherwise return changes_requested with parent-accepted findings for the next writer, or stop. Quote the real parent receipt concisely. Never turn a merely queued/delivered message into approval.`
    });
    evidence.push(record(reviewKey, reviewed));
    const rr = reviewed.structuredOutput;
    if (!reviewed.ok || !rr) return { state: "blocked", reason: "review_or_infrastructure_blocker", ticket: id, completed, evidence };
    if (rr.decision === "approved" && rr.observedTicketStatus === "resolved" && rr.parentReceipt) {
      completed.push(id);
      accepted = true;
      emit({ stage: "accepted", ticket: id, completed, reviewRunId: reviewed.runId, outputReference: reviewed.outputReference });
      break;
    }
    if (rr.decision !== "changes_requested") return { state: "blocked", reason: "parent_or_review_stop", ticket: id, completed, evidence };
    repair = `Parent-reviewed repair request: ${JSON.stringify(rr)}\nPrior implementation report: ${JSON.stringify(ir)}`;
  }
  if (!accepted) return { state: "blocked", reason: "bounded_repair_limit", ticket: id, completed, evidence };
}
const finalGate = await runs.run("dashboard-final-integration-review", {
  label: "Verify integrated task dashboard",
  agent: "reviewer", model, context: "fresh", cwd, worktree: false,
  timeoutMs: 7200000, acceptance: false, outputSchema: reviewSchema,
  output: "final/integration-review.json",
  task: `${common}\n\nAll 14 individual tickets have passed parent acceptance. Perform final READ-ONLY integration validation against the complete spec, not just ticket-local success. No source/ticket edits. All individual evidence references: ${JSON.stringify(evidence.map(e => ({ stage: e.stage, runId: e.runId, outputReference: e.outputReference, outputPathMapping: e.outputPathMapping })))}\nRun the relevant complete unit/regression suite, tsc --noEmit, lint and safe dashboard browser flows using isolated fixtures and the existing service; do not launch another dev server or call next build. Check combined filter/deleted-column/archived-task behavior, source selection and data exposure, task reassignment with pending context, fork inheritance, lifecycle races, and preserved original session policy. Verify all 14 ticket files are accurately resolved, identify platform and real-provider gaps, inspect cumulative diff for accidental edits and excessive abstraction.\nBefore finalizing, contact_supervisor(reason=need_decision) with the concrete integration evidence and ask the parent for final acceptance. Do not approve yourself. If defects remain, return changes_requested or stop with exact affected tickets; the workflow must report partial/blocked rather than claim completion. Return ticket=all and observedTicketStatus=resolved only if all are resolved and parent accepts; quote the actual receipt. No commit, push or publication.`
});
evidence.push(record("dashboard-final-integration-review", finalGate));
const final = finalGate.structuredOutput;
return { state: finalGate.ok && final && final.decision === "approved" && final.observedTicketStatus === "resolved" && final.parentReceipt ? "completed" : "blocked", reason: "final_integration_gate", branch, cwd, model, completed, evidence };
