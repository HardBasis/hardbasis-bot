#!/usr/bin/env node
/**
 * Refresh the vendored OpenAPI spec from the live public URL. The bot's types
 * (src/types.ts) are hand-derived from this file — run this to diff the spec
 * after a gateway release. Build-from-docs provenance: nothing here reads the
 * monorepo.
 */
import { writeFileSync } from "node:fs";

const url = process.env.HB_SPEC_URL ?? "https://docs.hardbasis.com/openapi.json";
const res = await fetch(url);
if (!res.ok) {
  console.error(`fetch-spec: ${url} → ${res.status}`);
  process.exit(1);
}
const text = await res.text();
JSON.parse(text); // fail loudly if it isn't valid JSON
writeFileSync(new URL("../spec/openapi.json", import.meta.url), text);
console.log(`fetch-spec: wrote spec/openapi.json (${text.length} bytes) from ${url}`);
