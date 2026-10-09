import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectServiceHealth, checkReadablePaths } from './service-health.ts';

function healthy(overrides = {}) {
  return { userInfo: () => ({ username: 'fixture' }), lookup: async () => ({ address: '127.0.0.1' }),
    child: async () => ({ user: true, dns: true }), readable: async () => true, env: {}, home: '/fixture', ...overrides };
}

test('runtime health detects the historical user lookup / DNS failure even when HTTP could respond', async () => {
  const health = await inspectServiceHealth(healthy({ userInfo: () => { throw new Error('getpwuid'); }, lookup: async () => { throw new Error('ENOTFOUND'); }, child: async () => ({ user: false, dns: false }) }));
  assert.equal(health.status, 'unhealthy');
  assert.equal(health.checks.user, false);
  assert.equal(health.checks.dns, false);
  assert.equal(health.checks.childUser, false);
});

test('network-only failure is degraded, while user/path failures are unhealthy; no restart or permission mutation', async () => {
  assert.equal((await inspectServiceHealth(healthy())).status, 'healthy');
  assert.equal((await inspectServiceHealth(healthy({ lookup: async () => { throw new Error(); } }))).status, 'degraded');
  assert.equal((await inspectServiceHealth(healthy({ readable: async () => false }))).status, 'unhealthy');
  assert.equal((await inspectServiceHealth(healthy({ child: async () => ({ user: false, dns: true }) }))).status, 'unhealthy');
});

test('diagnostics return only bounded boolean checks, never usernames, credentials, DNS addresses or path names', async () => {
  const paths = [];
  const result = await inspectServiceHealth(healthy({ env: { PI_WEB_PASSWORD: 'secret', PI_WEB_HEALTH_PATHS: '["/private-file"]' }, readable: async input => { paths.push(...input); return true; } }));
  assert.deepEqual(paths, ['/fixture', '/private-file']);
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'status']);
  assert.equal(Object.values(result.checks).every(value => typeof value === 'boolean'), true);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('private-file'));
});

test('read-only path probe rejects missing paths, relative paths and excessive input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample');
  fs.writeFileSync(file, 'unchanged');
  assert.equal(await checkReadablePaths([root, file]), true);
  assert.equal(await checkReadablePaths([path.join(root, 'missing')]), false);
  assert.equal(await checkReadablePaths(['relative']), false);
  assert.equal(await checkReadablePaths(Array(9).fill(root)), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged');
});

test('actual runtime and child system probes succeed with localhost without an external network dependency', async () => {
  const original = process.env.PI_WEB_HEALTH_DNS_HOST;
  const originalPaths = process.env.PI_WEB_HEALTH_PATHS;
  process.env.PI_WEB_HEALTH_DNS_HOST = 'localhost';
  delete process.env.PI_WEB_HEALTH_PATHS;
  try {
    const result = await inspectServiceHealth();
    assert.equal(result.status, 'healthy');
  } finally {
    if (original === undefined) delete process.env.PI_WEB_HEALTH_DNS_HOST;
    else process.env.PI_WEB_HEALTH_DNS_HOST = original;
    if (originalPaths !== undefined) process.env.PI_WEB_HEALTH_PATHS = originalPaths;
  }
});
