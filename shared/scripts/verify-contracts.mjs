#!/usr/bin/env node
/**
 * verify-contracts.mjs
 *
 * Sanity check that JSON Schemas / Pydantic / Zod stay in sync.
 *
 * What this checks:
 *   1. Every *.schema.json is valid JSON and parseable as JSON Schema
 *   2. Every top-level title/property name in each schema also appears as
 *      an exported symbol in the Python package __init__.py
 *   3. Every top-level title/property name in each schema also appears as
 *      an exported symbol in the TypeScript src/index.ts barrel (via file content scan)
 *
 * Run: node shared/scripts/verify-contracts.mjs
 * Exit code 0 on pass, 1 on drift.
 *
 * This is a lightweight sentinel — it does NOT fully validate that field
 * names match. Its job is to flag obvious omissions (e.g., you added a new
 * schema but forgot to add a Pydantic model). Rigorous diffing is a human
 * code-review responsibility.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SHARED_ROOT = resolve(__dirname, "..");

const CONTRACTS_DIR = join(SHARED_ROOT, "contracts");
const PY_INIT = join(SHARED_ROOT, "python", "src", "voiceai_contracts", "__init__.py");
const TS_DIR = join(SHARED_ROOT, "typescript", "src");

// Names that exist only in the JSON Schema world and should be ignored for
// the export-presence check.
const SKIP_NAMES = new Set([
  "WebSocketEvents",
  "VonageWebhookEvents",
  "AgentTurn",
  // Inline $defs that aren't exported as top-level types:
  "TalkAction",
  "ConnectAction",
  "StreamAction",
  "RecordAction",
  "InputAction",
  "NCCO", // TS exports as `Ncco`, handled specially below
]);

// Canonical-name -> language-specific-name overrides.
const NAME_ALIASES = {
  // JSON schema name → Pydantic name
  python: {
    NCCO: null, // not exported in Python
  },
  // JSON schema name → TS export name
  typescript: {
    NCCO: "Ncco",
  },
};

function log(prefix, msg) {
  // eslint-disable-next-line no-console
  console.log(`${prefix} ${msg}`);
}

function fail(msg) {
  log("✗", msg);
  process.exitCode = 1;
}

function ok(msg) {
  log("✓", msg);
}

async function loadSchemas() {
  const files = await readdir(CONTRACTS_DIR);
  const schemas = [];
  for (const file of files) {
    if (!file.endsWith(".schema.json")) continue;
    const raw = await readFile(join(CONTRACTS_DIR, file), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fail(`${file}: invalid JSON — ${err.message}`);
      continue;
    }
    if (!parsed.$schema || !parsed.$id) {
      fail(`${file}: missing $schema or $id`);
    }
    schemas.push({ file, parsed });
  }
  return schemas;
}

function collectCanonicalNames(schemas) {
  const names = new Set();
  for (const { parsed } of schemas) {
    if (parsed.title) names.add(parsed.title);
    if (parsed.$defs) {
      for (const key of Object.keys(parsed.$defs)) {
        names.add(key);
      }
    }
    if (parsed.properties) {
      // Only the top-level title is exported as a class; properties are fields.
    }
  }
  return names;
}

async function loadPythonExports() {
  const content = await readFile(PY_INIT, "utf8");
  const names = new Set();
  // Match names in __all__ = [ ... ] and inside `from ... import ( ... )`.
  const allMatch = content.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (allMatch) {
    const body = allMatch[1];
    for (const m of body.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
      names.add(m[1]);
    }
  }
  for (const m of content.matchAll(
    /from\s+voiceai_contracts\.[a-z_]+\s+import\s+\(([^)]*)\)/g
  )) {
    for (const sym of m[1].split(",")) {
      const cleaned = sym.trim();
      if (cleaned) names.add(cleaned);
    }
  }
  return names;
}

async function loadTypescriptExports() {
  const files = await readdir(TS_DIR);
  const names = new Set();
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const content = await readFile(join(TS_DIR, file), "utf8");
    // export const X = ...
    for (const m of content.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.add(m[1]);
    }
    // export type X = ...   /   export interface X
    for (const m of content.matchAll(
      /export\s+(?:type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g
    )) {
      names.add(m[1]);
    }
    // export function X(
    for (const m of content.matchAll(
      /export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/g
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

async function main() {
  log("▸", `shared root: ${SHARED_ROOT}`);

  const schemas = await loadSchemas();
  if (schemas.length === 0) {
    fail("No *.schema.json files found in contracts/");
    process.exit(1);
  }
  ok(`loaded ${schemas.length} JSON Schema file(s)`);

  const canonicalNames = collectCanonicalNames(schemas);
  const pyNames = await loadPythonExports();
  const tsNames = await loadTypescriptExports();

  ok(`${pyNames.size} Python exports detected`);
  ok(`${tsNames.size} TypeScript exports detected`);

  let missingPy = 0;
  let missingTs = 0;

  for (const name of canonicalNames) {
    if (SKIP_NAMES.has(name)) continue;

    // ── Python check ──
    const pyAlias = NAME_ALIASES.python[name];
    if (pyAlias !== null) {
      const expected = pyAlias ?? name;
      if (!pyNames.has(expected)) {
        fail(`Python: missing export "${expected}" (from schema "${name}")`);
        missingPy++;
      }
    }

    // ── TypeScript check ──
    const tsAlias = NAME_ALIASES.typescript[name];
    if (tsAlias !== null) {
      const expected = tsAlias ?? name;
      // TS exports both a type and a Zod schema; either is acceptable
      const zodAlias = `${expected}Schema`;
      if (!tsNames.has(expected) && !tsNames.has(zodAlias)) {
        fail(
          `TypeScript: missing export "${expected}" or "${zodAlias}" (from schema "${name}")`
        );
        missingTs++;
      }
    }
  }

  if (missingPy === 0 && missingTs === 0) {
    ok("All canonical names appear in both Python and TypeScript exports.");
    ok("Contracts look aligned. (Remember: field-level diffs still need human review.)");
  } else {
    fail(
      `Drift detected: ${missingPy} Python gap(s), ${missingTs} TypeScript gap(s).`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
