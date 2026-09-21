import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

const guard = fileURLToPath(new URL("../bin/stdio-guard.js", import.meta.url));

function launch(source) {
  return spawn(process.execPath, ["--require", guard, "--eval", source], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

for (const stream of ["stdout", "stderr"]) {
  test(`closed ${stream} pipe does not feed uncaughtException logging`, { timeout: 10_000 }, async (t) => {
    const child = launch(`
      let exceptions = 0;
      process.on('uncaughtException', (error) => {
        if (++exceptions > 5) process.exit(2);
        console.error(error);
      });
      process.on('message', () => {
        process.${stream}.write('first write after reader closed\\n');
        setTimeout(() => {
          process.${stream}.write('second write after reader closed\\n');
          setTimeout(() => {
            process.send({ exceptions });
            process.disconnect();
          }, 50);
        }, 50);
      });
      process.send('ready');
    `);
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const exited = once(child, "exit");
    const ready = await Promise.race([
      once(child, "message"),
      exited.then(([code]) => { throw new Error(`child exited before ready: ${code}`); }),
    ]);
    assert.equal(ready[0], "ready");
    const closed = once(child[stream], "close");
    child[stream].destroy();
    await closed;
    const reply = once(child, "message");
    child.send("write");
    const [result] = await Promise.race([
      reply,
      exited.then(([code]) => { throw new Error(`child exited before reply: ${code}`); }),
    ]);
    assert.deepEqual(result, { exceptions: 0 });
    assert.deepEqual(await exited, [0, null]);
  });
}

test("normal stdout and stderr are unchanged", async () => {
  const child = launch("console.log('normal output'); console.error('normal error'); process.disconnect();");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.equal(stdout.trim(), "normal output");
  assert.equal(stderr.trim(), "normal error");
});

test("non-EPIPE output errors are not swallowed", async () => {
  const child = launch("process.stderr.emit('error', Object.assign(new Error('disk failure'), { code: 'EIO' }));");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.notEqual(code, 0);
  assert.match(stderr, /disk failure/);
});
