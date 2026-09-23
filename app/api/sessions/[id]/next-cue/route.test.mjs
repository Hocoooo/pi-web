import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { POST } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./route.ts");
const params = { params: Promise.resolve({ id: "not-a-real-session" }) };

test("suggestion route rejects malformed model requests before using a session", async () => {
  for (const body of ["not json", "{}", '{"model":{"provider":"fast"}}']) {
    const response = await POST(new Request("http://localhost/api/sessions/test/next-cue", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }), params);
    assert.equal(response.status, 400);
  }
});
