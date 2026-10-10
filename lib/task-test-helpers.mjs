import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { taskOperation } = await jiti.import("./task-operations.ts");

/** Build an explicit end-anchored request from a fixture's current board, not user data. */
export async function moveRequest(input, options) {
  const board = await taskOperation({ action: "list" }, options);
  return { operationId: randomUUID(), position: { edge: "end" }, expectedOrderRevision: board.orderRevision, ...input };
}
