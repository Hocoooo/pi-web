import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ConfigSync.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);

test("Config sync panel copy exists in all three locales", async () => {
  const keys = new Set([...source.matchAll(/"((?:configSync\.|settings\.configSync|skills\.scope\.global)[\w.]*)"/g)].map(match => match[1]));
  assert.ok(keys.size > 15);
  for (const id of ["en", "zh-CN", "zh-TW"]) {
    const locale = Object.values(await jiti.import(`../lib/i18n/messages/${id}.ts`))[0];
    for (const key of keys) assert.ok(locale.messages[key], `${id}: ${key}`);
  }
});

test("minimal layout keeps risk consent but removes secondary labels and repeated instructions", async () => {
  const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
  assert.match(enLocale.messages["configSync.trust"], /replace shared settings and run plugins/);
  assert.match(enLocale.messages["configSync.trust"], /resource files contain no secrets/);
  assert.doesNotMatch(source, /ConfigScopeTag|ConfigDetailGrid|ConfigFooterStatus|configSync\.help|configSync\.repositoryHelp/);
  assert.ok(source.includes('(!status.repository || dirty) && <label'));
  assert.ok(source.includes('status.lastSync.commit.slice(0, 8)'));
});
