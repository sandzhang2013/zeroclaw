import { readFileSync } from "node:fs";
import { WORKBENCH_VERSION_FALLBACK } from "./workbenchVersion.ts";

function readVersion(): string {
  try {
    const text = readFileSync(new URL("../../WORKBENCH_VERSION", import.meta.url), "utf8").trim();
    if (/^\d+\.\d+\.\d+$/.test(text)) return text;
  } catch {
    /* the vite plugin covers the browser; this stub is for node tests */
  }
  return WORKBENCH_VERSION_FALLBACK;
}

/** Badge text. Vite replaces this module with the contents of `web/WORKBENCH_VERSION`. */
export const workbenchVersion = readVersion();
