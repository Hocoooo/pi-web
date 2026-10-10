import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./TaskDashboard.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const reload = useCallback");
const end = source.indexOf("  useEffect(() =>", start);
assert.ok(start >= 0 && end > start);
const callback = source.slice(start, end);
function fixture(requestTask) {
  const state = { board: { tasks: [{ id: "old" }] }, selected: "old", error: null, loading: false };
  const context = vm.createContext({
    useCallback: fn => fn, pendingRef: { current: false }, dragBoard: { current: null },
    requestVersion: { current: 0 }, activeRef: { current: true },
    requestedTask: { id: "new", request: 1 }, handledTaskRequest: { current: null },
    retryMove: null, retryArchive: null, requestTask, t: key => key,
    setBoard: value => { state.board = value; },
    setSelectedTaskId: value => { state.selected = value; },
    setLoading: value => { state.loading = value; },
    setError: value => { state.error = typeof value === "function" ? value(state.error) : value; },
  });
  vm.runInContext(stripTypeScriptTypes(`${callback}\nglobalThis.reload = reload;`), context);
  return { context, state };
}

test("membership navigation resolves against the fresh board, not the retained panel snapshot", async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const reading = f.context.reload();
  assert.equal(f.context.handledTaskRequest.current, null);
  assert.equal(f.state.selected, "old");
  finish({ tasks: [{ id: "old" }, { id: "new" }] });
  await reading;
  assert.equal(f.state.selected, "new");
  assert.equal(f.context.handledTaskRequest.current, 1);
});

test("a deleted navigation target reports unavailable instead of displaying previous task details", async () => {
  const f = fixture(async () => ({ tasks: [{ id: "old" }] }));
  await f.context.reload();
  assert.equal(f.state.selected, null);
  assert.equal(f.state.error, "tasks.taskUnavailable");
  assert.equal(f.context.handledTaskRequest.current, 1);
});

test("failed refresh does not consume navigation and explicit retry selects the task", async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error("unavailable"); return { tasks: [{ id: "new" }] }; });
  await f.context.reload();
  assert.equal(f.context.handledTaskRequest.current, null);
  fail = false;
  await f.context.reload();
  assert.equal(f.state.selected, "new");
  assert.equal(f.state.error, null);
});

test("a response invalidated by a newer read cannot consume navigation", async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const reading = f.context.reload();
  f.context.requestVersion.current++;
  finish({ tasks: [{ id: "new" }] });
  await reading;
  assert.equal(f.context.handledTaskRequest.current, null);
  assert.equal(f.state.selected, "old");
});

test("finishing a mutation refreshes only deferred navigation, not ordinary failure feedback", () => {
  const effectStart = source.indexOf("  const pendingNavigation = useRef");
  const effectEnd = source.indexOf("  function startMutation()", effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  const effect = source.slice(effectStart, effectEnd).replace("  const pendingNavigation = useRef(false);", "");
  let reads = 0;
  const context = vm.createContext({
    pendingNavigation: { current: true }, pending: false, active: true,
    requestedTask: null, handledTaskRequest: { current: null },
    useEffect: fn => fn(), reload: () => { reads++; },
  });
  const run = () => vm.runInContext(stripTypeScriptTypes(effect), context);
  run();
  assert.equal(reads, 0, "a failed ordinary mutation does not immediately clear its error via reload");
  context.pendingNavigation.current = true;
  context.requestedTask = { id: "new", request: 2 };
  run();
  assert.equal(reads, 1, "deferred navigation retries after a mutation");
  context.pendingNavigation.current = true;
  context.handledTaskRequest.current = 2;
  run();
  assert.equal(reads, 1, "already consumed navigation does not erase a later error");
});
