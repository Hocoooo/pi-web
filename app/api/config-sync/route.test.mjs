import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-config-sync-route-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: true });
const { GET, PUT, POST } = await jiti.import("./route.ts");
test.after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(agentDir, { recursive: true, force: true });
});
function request(method = "GET", body, headers = {}) {
  return new Request("http://localhost/api/config-sync", { method, headers: { host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
test("GET is side-effect free and exposes only binding/status; PUT requires explicit repository trust", async () => {
  assert.deepEqual(await (await GET(request())).json(), { repository: "", branch: "main", lastSync: null });
  assert.deepEqual(await readdir(agentDir), []);
  const binding = { repository: "https://example.invalid/private-config.git", branch: "main", trusted: true };
  const saved = await PUT(request("PUT", binding));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { repository: binding.repository, branch: "main", lastSync: null });
  const status = await (await GET(request())).json();
  assert.deepEqual(Object.keys(status).sort(), ["branch", "lastSync", "repository"]);
  assert.equal((await PUT(request("PUT", { ...binding, trusted: false }))).status, 400);
  assert.equal(JSON.parse(await readFile(join(agentDir, "config-sync.json"), "utf8")).repository, binding.repository);
});
test("all routes reject untrusted origins and mutations require JSON; invalid requests do no Git work", async () => {
  for (const handler of [GET, PUT, POST]) {
    const method = handler === GET ? "GET" : handler === PUT ? "PUT" : "POST";
    const response = await handler(request(method, method === "GET" ? undefined : {}, { origin: "https://evil.invalid" }));
    assert.equal(response.status, 403);
  }
  assert.equal((await PUT(request("PUT", "{}", { "content-type": "text/plain" }))).status, 415);
  for (const body of ["broken json", [], {}, { action: "force" }]) assert.equal((await POST(request("POST", body))).status, 400);
  const invalid = await PUT(request("PUT", { repository: "https://private-token@example.invalid/repo", branch: "main", trusted: true }));
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(JSON.stringify(await invalid.json()), /private-token/);
  assert.deepEqual((await readdir(agentDir)).sort(), ["config-sync.json"]);
});
