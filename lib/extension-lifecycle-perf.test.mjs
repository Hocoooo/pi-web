import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
process.env.PI_WEB_PERF = '1';
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createExtensionLifecycle } = await jiti.import('./extension-lifecycle-perf.ts');
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture(handlers) {
  return { extensions: [{ path: '/SECRET/extension.ts', handlers: new Map(Object.entries(handlers)) }], errors: [] };
}

test('closing drains the active startup, skips later startup/discovery, then shuts down before disposal', async t => {
  t.mock.method(console, 'log', () => {});
  let release;
  const calls = [];
  const lifecycle = createExtensionLifecycle();
  const base = fixture({
    session_start: [async () => { calls.push('start'); await new Promise(r => { release = r; }); calls.push('settled'); }, async () => { calls.push('unwanted connection'); }],
    resources_discover: [async () => { calls.push('unwanted discovery'); }],
    session_shutdown: [async () => { calls.push('shutdown'); }],
  });
  const wrapped = lifecycle.wrap(base);
  const emit = async type => { for (const handler of wrapped.extensions[0].handlers.get(type) ?? []) await handler({ type }, {}); };
  const inner = {
    sessionId: 'fixture', isBashRunning: false,
    bindExtensions: async () => { await emit('session_start'); await emit('resources_discover'); },
    extensionRunner: { emit: event => emit(event.type) },
    dispose: () => calls.push('dispose'),
  };
  const wrapper = new AgentSessionWrapper(inner, { extensionLifecycle: lifecycle });
  wrapper.beginExtensionBinding();
  await nextTurn();
  let finished = false;
  const shutdown = wrapper.shutdown().then(() => { finished = true; });
  await nextTurn();
  assert.equal(finished, false, 'must not dispose/unlink while a started hook can still write');
  assert.deepEqual(calls, ['start']);
  release();
  await shutdown;
  assert.deepEqual(calls, ['start', 'settled', 'shutdown', 'dispose']);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(base.extensions[0].handlers.get('session_start').length, 2, 'does not mutate SDK input');
});

test('open runtimes preserve handler receiver/results/errors; logs omit input/path/error data', async t => {
  const records = [];
  t.mock.method(console, 'log', line => records.push(JSON.parse(line)));
  const lifecycle = createExtensionLifecycle();
  const owner = {};
  const result = {};
  const error = new Error('SECRET failure');
  const base = fixture({ session_start: [async function (input) { assert.equal(this, owner); assert.equal(input, 'SECRET input'); return result; }, async () => { throw error; }] });
  const handlers = lifecycle.wrap(base).extensions[0].handlers.get('session_start');
  assert.equal(await handlers[0].call(owner, 'SECRET input'), result);
  await assert.rejects(handlers[1](), e => e === error);
  assert.equal(records.filter(r => r.event === 'end').length, 2);
  assert.equal(records.at(-1).outcome, 'error');
  assert.ok(!JSON.stringify(records).includes('SECRET'));
  const independent = createExtensionLifecycle();
  lifecycle.close();
  assert.equal(await independent.wrap(base).extensions[0].handlers.get('session_start')[0].call(owner, 'SECRET input'), result);
});
