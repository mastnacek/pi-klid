/**
 * `/klid` menu tests — lock the `--global` prefix support added by the
 * config-cascade work, plus the trailing-space contract.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerKlidCommand } from "../src/command.js";

/** Capture the registered command definition from a minimal fake pi. */
function captureCommand() {
  let def = null;
  const pi = {
    registerCommand(name, commandDef) {
      if (name === "klid") def = commandDef;
    },
  };
  registerKlidCommand(pi, () => {});
  return def;
}

test("root completions include --global and the non-terminal view row", async () => {
  const def = captureCommand();
  assert.ok(def, "klid command was not registered");

  const items = (await def.getArgumentCompletions("")) ?? [];
  const values = items.map((i) => i.value);
  assert.ok(values.includes("--global "), "--global must be offered");
  assert.ok(values.includes("view "), "view is non-terminal");
  assert.ok(values.includes("on"), "on is terminal");
});

test("--global prefix preserves child completions", async () => {
  const def = captureCommand();

  const level1 = (await def.getArgumentCompletions("--global ")) ?? [];
  assert.ok(
    level1.some((i) => i.value === "--global view "),
    `expected "--global view ", got ${JSON.stringify(level1.map((i) => i.value))}`,
  );
  assert.ok(level1.some((i) => i.value === "--global on"));
  assert.ok(
    !level1.some((i) => i.value.startsWith("--global --global")),
    "must not nest --global",
  );

  const level2 = (await def.getArgumentCompletions("--global view ")) ?? [];
  const views = level2.map((i) => i.value);
  assert.ok(views.includes("--global view cover"));
  assert.ok(views.includes("--global view spai"));
  assert.ok(views.includes("--global view kanban"));
});

test("markers never leak into item.value and no ANSI is embedded", async () => {
  const def = captureCommand();
  for (const prefix of ["", "--global ", "--global view "]) {
    for (const item of (await def.getArgumentCompletions(prefix)) ?? []) {
      assert.equal(/[✓●○]/.test(item.value), false, `marker in value: ${item.value}`);
      assert.equal(/\u001b/.test(`${item.value}${item.label}${item.description ?? ""}`), false);
    }
  }
});
