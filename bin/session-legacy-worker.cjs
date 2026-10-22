/* eslint-disable @typescript-eslint/no-require-imports -- Native Node worker shipped without a TS loader. */
// Internal read-only worker. Paths arrive only from the server's deletion plan.
const { parentPort } = require('node:worker_threads');
const { scanLegacyEntry, createLegacyScanMetrics } = require('./session-legacy-scan.cjs');
if (!parentPort) throw new Error('Session relation worker requires a parent');
parentPort.on('message', async ({ key, node }) => {
  const metrics = createLegacyScanMetrics();
  try {
    const entry = await scanLegacyEntry(node, metrics);
    parentPort.postMessage({ key, entry, metrics });
  } catch (error) {
    parentPort.postMessage({ key, metrics, error: { code: error?.code,
      message: error?.code ? 'Cannot read a session relation file.' : error instanceof Error ? error.message : 'Cannot scan session relations.' } });
  }
});
