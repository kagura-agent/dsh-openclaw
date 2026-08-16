// Host-half integration test: shim src/index.js (like .selftest.mjs), then
// drive apply() with a mock ctx backed by a REAL temp directory, exercising
// the request routes end to end:
//   - import-memories lands in the session named by body.sessionId (not the
//     oldest live session) when provided, else the legacy fallback;
//   - import-sessions decompresses .jsonl.gz, resolves cwd by sessionId, and
//     is idempotent (a re-run skips already-imported sessions).
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

const src = readFileSync(new URL("./src/index.js", import.meta.url), "utf8");
const shim = src
  .replace('import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";', 'const { readFileSync, readdirSync, statSync, existsSync } = await import("node:fs");')
  .replace('import { join, basename, dirname, relative, isAbsolute, extname } from "node:path";', 'const { join, basename, dirname, relative, isAbsolute, extname } = await import("node:path");')
  .replace('import { homedir } from "node:os";', 'const { homedir } = await import("node:os");')
  .replace('import { randomUUID } from "node:crypto";', 'import { randomUUID, createHash } from "node:crypto";')
  .replace('import { createHash } from "node:crypto";', "")
  .replace("export { name, inject, apply };", "export { name, inject, apply };");
const mod = await import("data:text/javascript;base64," + Buffer.from(shim).toString("base64"));
const { apply } = mod;

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ok  ${label}`);
  else { failures += 1; console.log(`FAIL  ${label}`); }
};

// --- scratch layout (real files under a temp dir) -----------------------------
const root = join(tmpdir(), "dsh-openclaw-e2e-" + randomBytes(4).toString("hex"));
const srcDir = join(root, "openclaw-src");
const wsCurrent = join(root, "ws-current");  // the card's live session workspace
const wsOldest = join(root, "ws-oldest");    // an OLDER live session workspace (list()[0])
for (const d of [join(srcDir, "memories"), join(srcDir, "sessions"), wsCurrent, wsOldest]) mkdirSync(d, { recursive: true });

writeFileSync(join(srcDir, "memories", "约定.md"), "---\ntitle: 约定\ntags: [a]\n---\n# 约定\n\n内容\n");
writeFileSync(join(srcDir, "sessions", "alpha.jsonl"), [
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "你好" }], id: "u1", timestamp: "2026-08-01T10:00:00Z" }, sessionId: "sa", cwd: "/nonexistent/remote" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "收到" }], id: "a1", model: "claude-x", timestamp: "2026-08-01T10:00:01Z" } }),
].join("\n"));
// a REAL gzip-compressed jsonl — the .gz import path must gunzip it
writeFileSync(join(srcDir, "sessions", "beta.jsonl.gz"), gzipSync([
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "压缩会话" }], id: "u1", timestamp: "2026-08-01T11:00:00Z" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "已解压" }], id: "a1", model: "claude-y", timestamp: "2026-08-01T11:00:02Z" } }),
].join("\n")));

// --- mock ctx ------------------------------------------------------------------
const liveSessions = [
  { id: "session-oldest", header: { cwd: wsOldest } },   // list()[0] — the OLDEST
  { id: "session-current", header: { cwd: wsCurrent } }, // the card's session
];
const persisted = new Set(); // ids already in sessionPersistence
const created = [];          // ids created by the plugin

const fsMock = {
  async resolve(rel, opts) { return resolve(opts.cwd, rel); },
  async writeText(target, text) { mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, text); },
  async listDir(target) {
    if (!existsSync(target)) return [];
    return readdirSync(target, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
  },
};
const ctx = {
  get(name) {
    if (name === "webServer") return { register: (route) => { registered.push(route); return () => {}; } };
    if (name === "sessions") return {
      list: () => liveSessions,
      get: (id) => liveSessions.find((s) => s.id === id),
    };
    if (name === "sessionQuery") return { listSessions: () => liveSessions.map((s) => s.header) };
    if (name === "sessionPersistence") return {
      list: async () => [...persisted].map((id) => ({ id })),
      create: async (meta) => {
        if (persisted.has(meta.id)) throw new Error(`session "${meta.id}" already exists in this backend`);
        persisted.add(meta.id);
        created.push(meta.id);
      },
      append: async () => {},
    };
    if (name === "workspaceRegistry") return { create: async () => {} };
    if (name === "fs") return fsMock;
    return void 0;
  },
  effect(fn) { return fn(); },
};
const registered = [];

// --- tiny request/response doubles ---------------------------------------------
function fakeReq(body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  let sent = false;
  return {
    on(ev, cb) {
      if (ev === "data" && !sent) { sent = true; for (const c of chunks) cb(c); }
      if (ev === "end") cb();
      return this;
    },
    destroy() {},
  };
}
function fakeRes() {
  const out = { status: 0, body: null };
  return {
    writeHead(s, h) { out.status = s; out.headers = h; },
    end(p) { out.body = p; },
    out,
  };
}

apply(ctx, { defaultSourceDir: srcDir });
const byPath = (p) => registered.find((r) => r.path === p);
const call = async (path, body) => {
  const res = fakeRes();
  await byPath(path).handler(fakeReq(body), res);
  return { status: res.out.status, body: JSON.parse(res.out.body) };
};

// --- 1. scan ---------------------------------------------------------------------
{
  const r = await call("/api/dsh-openclaw/scan", {});
  check(r.status === 200 && r.body.ok, "scan 200");
  check(r.body.memories.count === 1 && r.body.sessions.count === 2, "scan counts memories=1 sessions=2");
}

// --- 2. import-memories WITHOUT sessionId → legacy fallback (oldest live) ---------
{
  const r = await call("/api/dsh-openclaw/import-memories", {});
  check(r.status === 200 && r.body.ok, "import-memories 200");
  check(r.body.cwd === wsOldest, "memories fall back to OLDEST live session without sessionId");
  check(existsSync(join(wsOldest, "memory", "约定.md")), "memory file written under fallback cwd");
  check(existsSync(join(wsOldest, "memory", "index.md")), "memory index written under fallback cwd");
}

// --- 3. import-memories WITH sessionId → lands in the card's workspace -------------
{
  const r = await call("/api/dsh-openclaw/import-memories", { sessionId: "session-current" });
  check(r.status === 200 && r.body.ok, "import-memories (with sessionId) 200");
  check(r.body.cwd === wsCurrent, "memories land in the session named by sessionId");
  check(existsSync(join(wsCurrent, "memory", "约定.md")), "memory file written under sessionId cwd");
  check(!existsSync(join(wsCurrent, "memory", "memory.md")), "CJK filename kept by slugify (no 'memory.md' fallback)");
}

// --- 4. import-sessions: cwd by sessionId + .gz decompression ----------------------
{
  const r = await call("/api/dsh-openclaw/import-sessions", { sessionId: "session-current" });
  check(r.status === 200 && r.body.ok, "import-sessions 200");
  check(r.body.imported.length === 2, "both plain .jsonl and .jsonl.gz import");
  const alpha = r.body.imported.find((s) => s.source === "alpha.jsonl");
  check(alpha && alpha.cwd === wsCurrent, "session cwd resolved by sessionId (source cwd missing on machine)");
  const beta = r.body.imported.find((s) => s.source === "beta.jsonl.gz");
  check(beta && beta.events > 0 && beta.messages === 2, "gzip session decompressed and converted");
  check(r.body.failed.length === 0, "no failures");
}

// --- 5. idempotent re-import: same ids are skipped, not failed ----------------------
{
  const before = created.length;
  const r = await call("/api/dsh-openclaw/import-sessions", { sessionId: "session-current" });
  check(r.status === 200 && r.body.ok, "re-import 200");
  check(r.body.imported.length === 0, "re-import imports nothing new");
  check(r.body.skipped.length === 2, "re-import skips both already-imported sessions");
  check(created.length === before, "no duplicate persistence.create");
  check(r.body.failed.length === 0, "re-import has no failures");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
rmSync(root, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
