import { taskReportsFixture } from "./task-reports.fixture.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REPORT_TEXT = `# Work archive
## Identity, goals and constraints
Original goal; requirements preserved, not a completion assertion.
## Requirements and work chronology
Recorded exploration only.
## Deliverables, files and commits
artifact.ts; no commit recorded.
## Decisions, reasons and alternatives
Keep the local file; rejected database because this is single-user.
## Failed attempts, causes and fixes
Attempt one failed; the source records the cause.
## Actual verification
verify command: passed. Conversational claims are not observations; real provider quality unverified.
## Unfinished work, risks and next steps
Follow-up still open.
## Source coverage and directory
See fixed source directory below.`;
export async function reportGenerationFixture(options = {}) {
  const calls = [];
  const f = await taskReportsFixture({ ...options, onRequest: async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ payload: JSON.parse(body), res });
  } });
  // Force the documented compatible endpoint capability; actual wire reasoning is asserted.
  for (const provider of Object.values(f.providers)) provider.models[0].compat = { supportsReasoningEffort: true };
  await writeFile(join(f.agentDir, "models.json"), JSON.stringify({ providers: f.providers }));
  const wait = async (predicate, message = "condition") => {
    const deadline = Date.now() + 8000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  return { ...f, calls, wait,
    close: async () => {
      for (const call of calls) if (!call.res.writableEnded) call.res.writeHead(400).end("Controlled fixture shutdown");
      await f.close();
    },
    respond(index, mode = "success", text = REPORT_TEXT) {
      const { res } = calls[index];
      if (mode === "error") return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Controlled explicit model failure" } }));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", created: 1, model: "same-id", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", content: mode === "empty" ? "" : text });
      chunk({}, mode === "length" ? "length" : "stop");
      res.end("data: [DONE]\n\n");
    },
  };
}
