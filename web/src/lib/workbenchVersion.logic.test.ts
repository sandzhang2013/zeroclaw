import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_VERSION_BASE_COMMITS,
  workbenchVersionLabel,
} from "./workbenchVersion.ts";

test("workbench version stays 0.6.2 at the baseline commit", () => {
  assert.equal(workbenchVersionLabel(WORKBENCH_VERSION_BASE_COMMITS), "0.6.2");
  assert.equal(workbenchVersionLabel(null), "0.6.2");
  assert.equal(workbenchVersionLabel(undefined), "0.6.2");
  assert.equal(workbenchVersionLabel(WORKBENCH_VERSION_BASE_COMMITS - 1), "0.6.2");
});

test("workbench version increments once per commit after the baseline", () => {
  assert.equal(workbenchVersionLabel(WORKBENCH_VERSION_BASE_COMMITS + 1), "0.6.3");
  assert.equal(workbenchVersionLabel(WORKBENCH_VERSION_BASE_COMMITS + 8), "0.6.10");
});
