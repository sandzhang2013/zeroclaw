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
  assert.equal(workbenchVersionLabel("0.8.705"), "0.8.705");
  assert.equal(workbenchVersionLabel(" 0.8.705\n"), "0.8.705");
  assert.equal(workbenchVersionLabel(null), WORKBENCH_VERSION_FALLBACK);
  assert.equal(workbenchVersionLabel(undefined), WORKBENCH_VERSION_FALLBACK);
  assert.equal(workbenchVersionLabel(""), WORKBENCH_VERSION_FALLBACK);
  assert.equal(workbenchVersionLabel("0.8"), WORKBENCH_VERSION_FALLBACK);
});

test("workbench version follows the kernel patch band", () => {
  assert.equal(bumpWorkbenchVersion("0.8.705", "0.8.7"), "0.8.706");
  assert.equal(bumpWorkbenchVersion("0.6.705", "0.8.7"), "0.8.700");
  assert.equal(bumpWorkbenchVersion("0.8.705", "0.8.8"), "0.8.800");
  assert.equal(bumpWorkbenchVersion("0.8.800", "0.8.8"), "0.8.801");
  assert.equal(bumpWorkbenchVersion("0.8.799", "0.8.7"), "0.8.800");
  assert.equal(bumpWorkbenchVersion("nope", "0.8.7"), null);
  assert.equal(bumpWorkbenchVersion("0.8.705", "0.8"), null);
});
