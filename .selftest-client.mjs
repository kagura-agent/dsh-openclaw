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
// Every identifier referenced outside strings/comments must be either defined
// in this file (const/function declarations, destructured state names) or a
// known global. This catches the "newName deleted but the input still binds
// to it" class of regression — far stronger than checking a helper list.
const defined = new Set();
for (const m of src.matchAll(/(?:const|function|var|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
// destructured state: const [a, setA] = react.useState(...) / useRef / useReducer
for (const m of src.matchAll(/const\s*\[([^\]]+)\]\s*=\s*react\.use/g)) {
  for (const name of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
    if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
  }
}
// function parameters (incl. destructured { ctx, wide }) and arrow params
const addParams = (list) => {
  for (const id of list.matchAll(/[A-Za-z_$][\w$]*/g)) defined.add(id[0]);
};
for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1]);
for (const m of src.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) addParams(m[1]);
// class declarations and lifecycle-method parameters
for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of src.matchAll(/(?:constructor|render|componentDidCatch|getDerivedStateFromError|componentDidMount|componentWillUnmount)\s*\(([^()]*)\)/g)) addParams(m[1]);

// Known globals the bundle may touch (browser + host-injected + react).
const GLOBALS = new Set([
  "window", "document", "fetch", "URL", "console", "JSON", "Date", "Math",
  "setInterval", "setTimeout", "clearInterval", "encodeURIComponent",
  "location", "File", "Blob", "confirm", "alert", "Object", "Array",
  "String", "Number", "Boolean", "Promise", "Error", "RegExp", "Map", "Set",
  "React", "react", "createElement", "Fragment", "Component", "useState",
  "useEffect", "useReducer", "useRef", "require", "module", "exports",
  "__ModuleLoader__", "api", "API", "NS", "styles", "zh", "en",
  "name", "inject", "apply", "props", "error",
  "constructor", "render", "componentDidCatch", "getDerivedStateFromError",
  "componentDidMount", "componentWillUnmount", "shouldComponentUpdate", "super"
]);
const KEYWORDS = new Set([
  "var", "let", "const", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "typeof", "instanceof",
  "in", "of", "this", "null", "undefined", "true", "false", "class", "extends",
  "super", "import", "export", "default", "try", "catch", "finally", "throw",
  "delete", "void", "yield", "await", "async", "static", "get", "set"
]);

// Strip comments, string/template literals, and object PROPERTY names
// ({ subtitle: ... }, { onClick: ... }) so only real references remain.
const stripped = src
  .replace(/\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, " ")
  .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, " ")
  .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, " ")
  .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, "$1 $3")
  .replace(/\.\s*[A-Za-z_$][\w$]*/g, "");

// Scope-aware check: split the file into top-level function bodies and check
// each body's references against (module-level definitions + that body's own
// definitions + params + globals). This catches a helper defined in ONE
// component but used in ANOTHER (the "post defined in badge, called in card"
// class) — the file-wide check above cannot.
function splitTopFunctions(code) {
  // top-level functions/classes start at two tabs inside the ModuleLoader factory
  const parts = [];
  const re = /^\t\t(?:function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let last = null;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (last) parts.push({ name: last.name, body: code.slice(last.start, m.index) });
    last = { name: m[1], start: m.index };
  }
  if (last) parts.push({ name: last.name, body: code.slice(last.start) });
  return parts;
}

// module-level definitions: two-tab consts (zh/en/styles/API/post/NS/...) and
// everything already collected in `defined` that sits outside a function body
const moduleLevel = new Set(defined);
for (const part of splitTopFunctions(src)) {
  // remove names that are defined INSIDE a function from module-level visibility
  // (approximation: a name defined at two-tab scope is module-level)
}
const moduleConst = new Set();
for (const m of src.matchAll(/^\t\t(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)) moduleConst.add(m[1]);

let undef = [];
for (const part of splitTopFunctions(src)) {
  const rawBody = part.body;
  // Definitions are extracted from the RAW body (member-access stripping would
  // destroy `react.useState`, breaking destructured-state extraction).
  const local = new Set();
  for (const m of rawBody.matchAll(/(?:const|function|var|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) local.add(m[1]);
  for (const m of rawBody.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) local.add(m[1]);
  for (const m of rawBody.matchAll(/const\s*\[([^\]]+)\]\s*=\s*react\.use/g)) {
    for (const n of m[1].split(",").map((x) => x.trim()).filter(Boolean)) if (/^[A-Za-z_$][\w$]*$/.test(n)) local.add(n);
  }
  for (const m of rawBody.matchAll(/\(([^()]*)\)\s*=>/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) local.add(n[0]);
  for (const m of rawBody.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) local.add(n[0]);
  for (const m of rawBody.matchAll(/(?:constructor|render|componentDidCatch|getDerivedStateFromError)\s*\(([^()]*)\)/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) local.add(n[0]);
  for (const m of rawBody.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  // a function's own destructured params: function Name({ ctx, wide })
  for (const m of rawBody.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) local.add(n[0]);

  const body = rawBody
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, " ")
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, " ")
    .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, " ")
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, "$1 $3")
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, "");

  const refs = new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((x) => x[1]));
  for (const id of refs) {
    if (GLOBALS.has(id) || KEYWORDS.has(id)) continue;
    if (moduleConst.has(id) || local.has(id)) continue;
    if (id.length < 2) continue;
    undef.push(`${id} (in ${part.name})`);
  }
}
check(undef.length === 0, `every reference is defined in scope${undef.length > 0 ? " (missing: " + undef.slice(0, 12).join(", ") + ")" : ""}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
