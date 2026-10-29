import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  WORKBENCH_VERSION_FALLBACK,
  bumpWorkbenchVersion,
  workbenchVersionLabel,
} from "./workbenchVersion.ts";

test("workbench version file is MAJOR.MINOR.PATCH", () => {
  const raw = readFileSync(new URL("../../WORKBENCH_VERSION", import.meta.url), "utf8");
  assert.equal(workbenchVersionLabel(raw), raw.trim());
});

test("workbench version keeps a valid string and falls back otherwise", () => {
  assert.equal(workbenchVersionLabel("0.6.704"), "0.6.704");
  assert.equal(workbenchVersionLabel(" 0.6.704\n"), "0.6.704");
  assert.equal(workbenchVersionLabel(null), WORKBENCH_VERSION_FALLBACK);
  assert.equal(workbenchVersionLabel(undefined), WORKBENCH_VERSION_FALLBACK);
  assert.equal(workbenchVersionLabel(""), WORKBENCH_VERSION_FALLBACK);
  assert.equal(workbenchVersionLabel("0.6"), WORKBENCH_VERSION_FALLBACK);
});

test("workbench version patch increments by one", () => {
  assert.equal(bumpWorkbenchVersion("0.6.704"), "0.6.705");
  assert.equal(bumpWorkbenchVersion("0.6.9"), "0.6.10");
  assert.equal(bumpWorkbenchVersion("nope"), null);
});
