import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parsePdfPageFragment, shouldOpenLocalFileInApp } = await jiti.import("../lib/file-links.ts");
const source = ts.createSourceFile("LocalFileLink.tsx", readFileSync(new URL("./LocalFileLink.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findClick(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "onClick") return node.initializer.expression;
  return ts.forEachChild(node, findClick);
}
const clickSource = ts.transpileModule(`(${findClick(source).getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function click(href, overrides = {}) {
  const opened = [];
  let prevented = false;
  const handler = new Script(clickSource).runInNewContext({
    parsePdfPageFragment, shouldOpenLocalFileInApp, props: { href }, filePath: "/project/report.pdf",
    onOpenFile: (...args) => opened.push(args),
  });
  handler({ button: 0, currentTarget: { getAttribute: () => null }, preventDefault: () => { prevented = true; }, ...overrides });
  return { opened, prevented };
}

test("desktop file links retain upstream PDF page navigation", () => {
  assert.deepEqual(click("report.pdf#page=12"), { opened: [["/project/report.pdf", 12]], prevented: true });
  assert.deepEqual(click("report.pdf#L42"), { opened: [["/project/report.pdf", undefined]], prevented: true });
});

test("primary modifiers still preview files while other modified clicks retain native behavior", () => {
  for (const overrides of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.deepEqual(click("report.pdf#page=12", overrides), { opened: [["/project/report.pdf", 12]], prevented: true });
  }
  for (const overrides of [{ shiftKey: true }, { altKey: true }, { button: 1 }, { currentTarget: { getAttribute: () => "_blank" } }]) {
    assert.deepEqual(click("report.pdf#page=12", overrides), { opened: [], prevented: false });
  }
});
