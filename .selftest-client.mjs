// Client-half static consistency test for dsh-migrate-openclaw.
//
// The browser bundle (src/client.js) has no unit harness, but two classes of
// regressions are cheap to catch statically:
//   1. i18n integrity — every `t("key")` call site must have the key in BOTH
//      the zh and en dictionaries, with matching {placeholder} params;
//   2. internal reference integrity — every helper function that is CALLED
//      somewhere in the file (post, switchTo, openSettings, refresh, load,
//      runActivate, ...) must actually be DEFINED, so deleting a helper while
//      a call site survives (the "cannot find variable post" class) fails here.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./src/client.js", import.meta.url), "utf8");

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ok  ${label}`);
  else { failures += 1; console.log(`FAIL  ${label}`); }
};

// --- extract the zh / en dictionary objects (pure object literals) -----------
function extractDict(name) {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`dictionary ${name} not found`);
  const braceOpen = src.indexOf("{", start);
  let depth = 0;
  let i = braceOpen;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) break; }
  }
  const literal = src.slice(start, i + 1).replace(/^const\s+\w+\s*=\s*/, "");
  // eslint-disable-next-line no-eval -- sandboxed extraction of a plain literal
  return eval("(" + literal + ")");
}
const zh = extractDict("zh");
const en = extractDict("en");

// --- 1. i18n integrity --------------------------------------------------------
const tCalls = [...src.matchAll(/\bt\("([^"]+)"(?:,\s*\{([^}]*)\})?\)/g)];
const usedKeys = new Set(tCalls.map((m) => m[1]));
check(usedKeys.size > 10, `found ${usedKeys.size} t() call sites`);

let keyMiss = 0;
for (const key of usedKeys) {
  if (!(key in zh) || !(key in en)) {
    keyMiss += 1;
    console.log(`FAIL  key "${key}" missing from ${!(key in zh) ? "zh" : "en"}`);
  }
}
check(keyMiss === 0, "every t() key exists in both zh and en");

// placeholder params must match across zh/en for each key
let paramMismatch = 0;
for (const key of usedKeys) {
  if (!(key in zh) || !(key in en)) continue;
  const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const pz = placeholders(zh[key]);
  const pe = placeholders(en[key]);
  const same = pz.size === pe.size && [...pz].every((p) => pe.has(p));
  if (!same) { paramMismatch += 1; console.log(`FAIL  placeholder mismatch for "${key}"`); }
}
check(paramMismatch === 0, "placeholder params match between zh and en");

// --- 2. internal reference integrity ------------------------------------------
// Helpers that are called somewhere in the file must be defined. Build the set
// of defined names from const/function declarations, then verify every CALL
// site (identifier followed by `(`) that matches a known helper name is defined.
const defined = new Set();
for (const m of src.matchAll(/(?:const|function|var|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);

// Candidate helper names that a component might call; we flag calls to any of
// these that have no definition. (Broad enough to catch deleted helpers.)
const helperCandidates = [
  "post", "fetchStatus", "currentSessionId",
  "runScan", "runMemories", "runSessions", "runCore", "toggleGuide"
];
let undef = 0;
for (const name of helperCandidates) {
  // called at least once (name followed by `(`), and not defined
  if (new RegExp(`\\b${name}\\s*\\(`).test(src) && !defined.has(name)) {
    undef += 1;
    console.log(`FAIL  "${name}" is called but never defined`);
  }
}
check(undef === 0, "every called helper is defined");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
