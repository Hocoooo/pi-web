import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { loadNextCueModels } = await createJiti(import.meta.url).import("./next-cue-models.ts");

test("the settings picker rejects HTTP 200 model errors rather than claiming a model disappeared", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ modelList: [], modelError: "Temporarily unavailable" });
    await assert.rejects(loadNextCueModels("/project", new AbortController().signal), /unavailable/);
    globalThis.fetch = async () => Response.json({ modelList: null });
    await assert.rejects(loadNextCueModels("/project", new AbortController().signal), /unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loads available model ids from the authorized project-scoped endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const models = [{ provider: "fast", id: "small", name: "Small" }];
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/api/models?cwd=%2Fproject%20one");
      assert.equal(options.signal, controller.signal);
      return Response.json({ modelList: models });
    };
    assert.deepEqual(await loadNextCueModels("/project one", controller.signal), models);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
