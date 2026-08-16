// dsh-openclaw host half — OpenClaw → DSH migration.
//
// Scans an OpenClaw data directory (default ~/.openclaw, configurable, and
// usable on a copied export directory for cross-machine migration) and
// imports:
//   - memories  : markdown files → current workspace `memory/*.md` +
//                 regenerated `memory/index.md` (through the `fs` service).
//   - sessions  : Claude-Code-SDK-style JSONL transcripts → native DSH
//                 session logs via ctx.sessionPersistence.create/append, so
//                 the web session list and query engine pick them up; the
//                 original cwd is kept when that path exists on this machine,
//                 otherwise the current session's workspace is used.
//
// Routes (all POST, JSON):
//   /api/dsh-openclaw/scan              {sourceDir?} → inventory
//   /api/dsh-openclaw/import-memories   {sourceDir?, targetDir?} → {imported, skipped, failed}
//   /api/dsh-openclaw/import-sessions   {sourceDir?, sessionIds?, asTranscript?} → {imported, failed}
//   /api/dsh-openclaw/guide             {} → the command to run on the OpenClaw machine
const name = "dsh-openclaw";
const inject = ["webServer", "sessions", "sessionQuery", "sessionPersistence", "workspaceRegistry", "fs"];

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname, relative, isAbsolute, extname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const API_PREFIX = "/api/dsh-openclaw";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 1000;
const DEFAULT_MAX_SESSIONS = 200;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MEMORY_DIR = "memory";
const ARCHIVE_DIR = "archive/openclaw";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function expandHome(path) {
  if (typeof path !== "string" || path.length === 0) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function listFilesRecursive(root, predicate, limit, state) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && predicate(entry.name)) {
        try {
          out.push({ path: full, name: entry.name, size: statSync(full).size });
        } catch {
          /* stat race */
        }
      }
    }
  };
  walk(root);
  state.truncated = out.length >= limit;
  return out;
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function firstLine(text) {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  if (!line) return "";
  const clean = line.replace(/^#+\s*/, "").trim();
  return clean.length > 80 ? clean.slice(0, 80) + "…" : clean;
}

function slugify(name) {
  const base = name.replace(/\.md$/i, "");
  const slug = base
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (slug || "memory") + ".md";
}

function uniqueName(existing, candidate) {
  if (!existing.has(candidate)) return candidate;
  const base = candidate.replace(/\.md$/i, "");
  let n = 2;
  while (existing.has(`${base}-${n}.md`)) n += 1;
  return `${base}-${n}.md`;
}

// ---------------------------------------------------------------------------
// memory frontmatter parsing (defensive; tolerates missing frontmatter)
// ---------------------------------------------------------------------------

function parseMemoryFile(path, size) {
  let text;
  try {
    text = readFileSync(path, "utf8").slice(0, MAX_READ_BYTES);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let title = null;
  let tags = [];
  let body = text;
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fmMatch) {
    const fm = fmMatch[1];
    body = text.slice(fmMatch[0].length);
    const titleMatch = /^title\s*:\s*(.+)$/m.exec(fm);
    if (titleMatch) title = titleMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const tagsMatch = /^tags\s*:\s*(.+)$/m.exec(fm);
    if (tagsMatch) {
      const raw = tagsMatch[1].trim();
      if (raw.startsWith("[")) {
        tags = raw
          .slice(1, -1)
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      } else if (raw.toLowerCase() !== "null" && raw.length > 0) {
        tags = raw
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }
  if (!title) {
    const h1 = /^#\s+(.+)$/m.exec(body);
    title = h1 ? h1[1].trim() : basename(path, ".md").replace(/[-_]+/g, " ");
  }
  return { ok: true, title, tags: tags.slice(0, 20), body, size };
}

function buildMemoryIndex(entries) {
  const lines = [
    "# OpenClaw 记忆索引",
    "",
    "> 由 dsh-openclaw 从 OpenClaw `memories/` 目录导入。共 " + entries.length + " 条记忆。",
    "",
    "| 标题 | 标签 | 文件 | 摘要 |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? entry.tags.join(", ") : "—";
    const excerpt = entry.excerpt.length > 0 ? entry.excerpt.replace(/\|/g, "\\|") : "—";
    lines.push(`| ${entry.title.replace(/\|/g, "\\|")} | ${tags.replace(/\|/g, "\\|")} | \`${entry.rel}\` | ${excerpt} |`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// session conversion: Claude Code SDK JSONL → DSH SessionEvent log
// ---------------------------------------------------------------------------

function parseSdkLine(line) {
  if (!line.trim()) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  // Envelope: { type: "user"|"assistant"|"system"|"summary", message: {...} }
  const envelopeType = typeof raw.type === "string" ? raw.type : null;
  const msg = raw && typeof raw.message === "object" && raw.message !== null ? raw.message : raw;
  const role = msg.role === "user" || msg.role === "assistant" ? msg.role : null;
  if (!role) return null;
  if (envelopeType === "summary") return null; // model-generated compaction noise
  const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
  const id = typeof msg.id === "string" && msg.id.length > 0 ? msg.id : null;
  const model = typeof msg.model === "string" ? msg.model : null;
  const timestamp = typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN;
  return {
    envelopeType,
    role,
    content,
    id,
    model,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
  };
}

/** Normalize an SDK content block into DSH content blocks; returns {blocks, toolUses}. */
function sdkBlocksToDsh(blocks, toolCallIndex) {
  const out = [];
  const toolUses = [];
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    const type = block.type;
    if (type === "text") {
      if (typeof block.text === "string" && block.text.length > 0) out.push({ type: "text", text: block.text });
    } else if (type === "thinking" || type === "reasoning") {
      if (typeof block.text === "string" && block.text.length > 0) out.push({ type: "reasoning", text: block.text });
    } else if (type === "tool_use" || type === "tool-call") {
      const callId = String(block.id || `toolu_${toolCallIndex}`);
      toolCallIndex += 1;
      const args = block.input !== void 0 ? JSON.stringify(block.input) : "{}";
      out.push({ type: "tool-call", id: callId, name: String(block.name || "tool"), arguments: args });
      toolUses.push({ callId, name: String(block.name || "tool"), arguments: args });
    } else if (type === "tool_result" || type === "tool-result") {
      out.push(sdkToolResultToDsh(block));
    } else {
      // unknown block: keep its JSON as text so nothing is silently lost
      const text = typeof block.text === "string" ? block.text : JSON.stringify(block);
      if (text && text.length > 0) out.push({ type: "text", text });
    }
  }
  return { blocks: out, toolUses, toolCallIndex };
}

function sdkToolResultToDsh(block) {
  const toolCallId = String(block.tool_use_id || block.toolCallId || "");
  const inner = Array.isArray(block.content)
    ? block.content
    : typeof block.content === "string"
      ? [{ type: "text", text: block.content }]
      : [];
  const content = inner
    .map((c) => {
      if (c && c.type === "text" && typeof c.text === "string") return { type: "text", text: c.text };
      if (c && c.type === "image") return null; // images not portable; omit
      const text = c && typeof c.text === "string" ? c.text : c ? JSON.stringify(c) : "";
      return text ? { type: "text", text } : null;
    })
    .filter(Boolean);
  return {
    type: "tool-result",
    toolCallId,
    content,
    ...(block.is_error ? { isError: true } : {}),
  };
}

function textOfBlocks(blocks) {
  return blocks
    .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("\n")
    .trim();
}

/**
 * Convert parsed SDK records into a contiguous DSH event log.
 * @param records - parsed lines (already filtered).
 * @param sessionId - target session id (uuid string).
 * @param fallbackCwd - absolute cwd to stamp when the source carries none.
 */
function convertSession(records, sessionId, fallbackCwd) {
  const events = [];
  let seq = 0;
  let turn = 0;
  let step = 0;
  let openTurn = false;
  let openStep = false;
  let lastTime = 0;
  let detectedModel = null;
  let detectedCwd = null;
  let headerEmitted = false;
  let toolCallIndex = 0;
  let title = null;
  let firstUserText = null;

  const push = (type, data, surface) => {
    const event = { type, seq: seq++, time: lastTime, data };
    if (surface) event.surfaceOp = "append";
    events.push(event);
    return event;
  };
  const bumpTime = (candidate) => {
    const t = typeof candidate === "number" && Number.isFinite(candidate) && candidate > lastTime ? candidate : lastTime + 1000;
    lastTime = t;
  };

  const closeTurn = () => {
    if (openStep) {
      push("step/end", { turn, step });
      openStep = false;
    }
    if (openTurn) {
      push("turn/end", { turn, reason: { kind: "completed" } });
      openTurn = false;
    }
  };

  for (const record of records) {
    const t = record.timestamp;
    if (t !== null) bumpTime(t);

    if (record.role === "user") {
      const hasToolResult = record.content.some((b) => b && (b.type === "tool_result" || b.type === "tool-result"));
      if (hasToolResult) {
        // Tool results belong to the open step (or open a synthetic one).
        if (!openStep) {
          if (!openTurn) {
            turn += 1;
            push("turn/start", { turn });
            openTurn = true;
          }
          step += 1;
          push("step/start", { turn, step });
          openStep = true;
        }
        for (const block of record.content) {
          if (block && (block.type === "tool_result" || block.type === "tool-result")) {
            const dshBlock = sdkToolResultToDsh(block);
            const callId = dshBlock.toolCallId;
            if (callId) {
              push("tool/result", {
                turn,
                step,
                callId,
                message: {
                  id: record.id || `toolresult-${seq}`,
                  role: "user",
                  content: [dshBlock],
                  source: { kind: "tool", callId },
                },
              }, true);
            }
          }
        }
        continue;
      }
      // Human prompt: close the previous exchange, open a new turn.
      const text = textOfBlocks(record.content);
      if (text.length === 0) continue;
      if (firstUserText === null) {
        firstUserText = text;
        title = text.length > 60 ? text.slice(0, 60) + "…" : text;
      }
      closeTurn();
      turn += 1;
      step = 1;
      openTurn = true;
      openStep = true;
      push("turn/start", { turn });
      push("user/message", {
        content: record.content
          .map((b) => (b && b.type === "text" && typeof b.text === "string" ? { type: "text", text: b.text } : null))
          .filter(Boolean),
        source: record.envelopeType === "system" ? { kind: "plugin", plugin: "openclaw-import" } : { kind: "user" },
        role: "user",
        id: record.id || randomUUID(),
      }, true);
      if (!headerEmitted) {
        push("request/header", { header: { config: { provider: "openclaw", model: detectedModel || "claude" } }, reason: "initial" });
        headerEmitted = true;
      }
      push("step/start", { turn, step });
      continue;
    }

    if (record.role === "assistant") {
      if (record.model && !detectedModel) detectedModel = record.model;
      if (record.cwd && !detectedCwd) detectedCwd = record.cwd;
      if (!openStep) {
        if (!openTurn) {
          turn += 1;
          push("turn/start", { turn });
          openTurn = true;
        }
        step += 1;
        push("step/start", { turn, step });
        openStep = true;
      }
      const { blocks, toolUses } = sdkBlocksToDsh(record.content, toolCallIndex);
      toolCallIndex += toolUses.length;
      for (const use of toolUses) {
        push("tool/call", { turn, step, callId: use.callId, name: use.name, arguments: use.arguments });
      }
      if (blocks.length > 0) {
        push("assistant/message", {
          turn,
          step,
          message: {
            id: record.id || randomUUID(),
            role: "assistant",
            content: blocks,
            source: { kind: "model", provider: "openclaw", model: record.model || detectedModel || "claude" },
          },
        }, true);
      }
      continue;
    }
    // system / other roles: fold text into the open step as a user-role notice
    if (record.role === "system" || record.envelopeType === "system") {
      const text = textOfBlocks(record.content);
      if (text.length === 0) continue;
      if (!openStep) {
        if (!openTurn) {
          turn += 1;
          push("turn/start", { turn });
          openTurn = true;
        }
        step += 1;
        push("step/start", { turn, step });
        openStep = true;
      }
      push("user/message", {
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "openclaw-import" },
        role: "user",
        id: record.id || randomUUID(),
      }, true);
    }
  }

  closeTurn();
  return {
    events,
    meta: {
      title: title || basename(fallbackCwd || "session"),
      cwd: detectedCwd || fallbackCwd,
      model: detectedModel,
    },
  };
}

/** Render a human-readable markdown transcript of one session (archive copy). */
function renderTranscript(records, title) {
  const lines = [`# ${title}`, "", "> 由 dsh-openclaw 从 OpenClaw 会话导入（Markdown 存档，非 DSH 原生会话）。", ""];
  for (const record of records) {
    if (record.role === "assistant") {
      const text = textOfBlocks(record.content);
      if (text) lines.push(`**assistant**${record.model ? ` · ${record.model}` : ""}`, "", text, "");
    } else if (record.role === "user") {
      const hasToolResult = record.content.some((b) => b && (b.type === "tool_result" || b.type === "tool-result"));
      if (hasToolResult) {
        for (const block of record.content) {
          if (block && (block.type === "tool_result" || block.type === "tool-result")) {
            const inner = Array.isArray(block.content) ? block.content : [{ type: "text", text: String(block.content || "") }];
            const text = inner.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n").trim();
            lines.push(`**tool_result**${block.is_error ? " ⚠️" : ""}`, "```", text || "(empty)", "```", "");
          }
        }
      } else {
        const text = textOfBlocks(record.content);
        if (text) lines.push(`**user**`, "", text, "");
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// source dir scanning
// ---------------------------------------------------------------------------

function scanSource(sourceDir) {
  const dir = expandHome(sourceDir);
  const report = {
    sourceDir: dir,
    exists: existsSync(dir) && statSync(dir).isDirectory(),
    memories: { count: 0, sizeBytes: 0, truncated: false },
    sessions: { count: 0, sizeBytes: 0, truncated: false, unsupported: [] },
    config: null,
    plugins: { count: 0, dirs: [] },
  };
  if (!report.exists) return report;

  const memoriesState = { truncated: false };
  const memoryFiles = listFilesRecursive(join(dir, "memories"), (n) => /\.md$/i.test(n), MAX_SCAN_FILES, memoriesState);
  report.memories.count = memoryFiles.length;
  report.memories.sizeBytes = memoryFiles.reduce((sum, f) => sum + f.size, 0);
  report.memories.truncated = memoriesState.truncated;

  const sessionsState = { truncated: false };
  const sessionFiles = listFilesRecursive(join(dir, "sessions"), (n) => /\.jsonl$/i.test(n) || /\.jsonl\.gz$/i.test(n), MAX_SCAN_FILES, sessionsState);
  report.sessions.count = sessionFiles.length;
  report.sessions.sizeBytes = sessionFiles.reduce((sum, f) => sum + f.size, 0);
  report.sessions.truncated = sessionsState.truncated;

  // .jsonl.zstd (or bare .zstd) sessions exist in some setups — report, don't import.
  const unsupportedState = { truncated: false };
  const zstdFiles = listFilesRecursive(join(dir, "sessions"), (n) => /\.(zstd|zst)$/i.test(n), 50, unsupportedState);
  report.sessions.unsupported = zstdFiles.map((f) => f.name);

  for (const cfgName of ["config.yaml", "config.yml", "config.json", "settings.json"]) {
    const cfgPath = join(dir, cfgName);
    if (existsSync(cfgPath)) {
      try {
        report.config = { name: cfgName, path: cfgPath, size: statSync(cfgPath).size };
      } catch {
        /* ignore */
      }
      break;
    }
  }

  const pluginsDir = join(dir, "plugins");
  if (existsSync(pluginsDir)) {
    try {
      const dirs = readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .slice(0, 200);
      report.plugins.count = dirs.length;
      report.plugins.dirs = dirs;
    } catch {
      /* ignore */
    }
  }
  return report;
}

function resolveCwdForImport(ctx, sourceCwd) {
  const cwd = typeof sourceCwd === "string" && sourceCwd.length > 0 ? sourceCwd : null;
  if (cwd !== null && existsSync(cwd) && statSync(cwd).isDirectory()) return cwd;
  // fall back to the current session's workspace
  const sessions = ctx.get("sessions");
  const sessionQuery = ctx.get("sessionQuery");
  if (sessions !== void 0) {
    const list = sessions.list();
    if (list.length > 0) {
      const header = list[0].header;
      if (header && typeof header.cwd === "string") return header.cwd;
    }
  }
  if (sessionQuery !== void 0) {
    // best effort: any stored session's cwd
    try {
      const headers = sessionQuery.listSessions ? sessionQuery.listSessions() : [];
      if (Array.isArray(headers) && headers.length > 0) {
        for (const h of headers) {
          if (h && typeof h.cwd === "string" && existsSync(h.cwd)) return h.cwd;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) return;
  const cfg = config !== null && typeof config === "object" ? config : {};
  const defaultSourceDir = typeof cfg.defaultSourceDir === "string" && cfg.defaultSourceDir.length > 0 ? cfg.defaultSourceDir : "~/.openclaw";
  const maxSessions = Number.isInteger(cfg.maxSessionsPerImport) && cfg.maxSessionsPerImport > 0 ? cfg.maxSessionsPerImport : DEFAULT_MAX_SESSIONS;

  const routes = [
    { path: `${API_PREFIX}/scan`, handler: scan },
    { path: `${API_PREFIX}/import-memories`, handler: importMemories },
    { path: `${API_PREFIX}/import-sessions`, handler: importSessions },
    { path: `${API_PREFIX}/guide`, handler: guide },
  ];
  for (const route of routes) {
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: route.path,
      handler: async (req, res) => {
        try {
          await route.handler(ctx, req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }), `dsh-openclaw: ${route.path}`);
  }

  async function scan(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const sourceDir = body !== null && typeof body.sourceDir === "string" && body.sourceDir.length > 0 ? body.sourceDir : defaultSourceDir;
    const report = scanSource(sourceDir);
    report.memories.sizeLabel = sizeLabel(report.memories.sizeBytes);
    report.sessions.sizeLabel = sizeLabel(report.sessions.sizeBytes);
    if (report.config) report.config.sizeLabel = sizeLabel(report.config.size);
    sendJson(res, 200, { ok: true, ...report });
  }

  async function importMemories(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const sourceDir = body !== null && typeof body.sourceDir === "string" && body.sourceDir.length > 0 ? body.sourceDir : defaultSourceDir;
    const report = scanSource(sourceDir);
    if (!report.exists) {
      sendJson(res, 400, { ok: false, error: `source directory not found: ${report.sourceDir}` });
      return;
    }
    const fs = ctx.get("fs");
    if (fs === void 0) {
      sendJson(res, 500, { ok: false, error: "fs service unavailable" });
      return;
    }
    const sessions = ctx.get("sessions");
    let cwd = null;
    if (sessions !== void 0) {
      const list = sessions.list();
      if (list.length > 0 && list[0].header && typeof list[0].header.cwd === "string") cwd = list[0].header.cwd;
    }
    if (cwd === null) {
      sendJson(res, 400, { ok: false, error: "no active session workspace" });
      return;
    }

    const targetRel = body !== null && typeof body.targetDir === "string" && body.targetDir.length > 0 ? body.targetDir.replace(/^\.?\//, "").replace(/\/+$/, "") : MEMORY_DIR;
    let target;
    try {
      target = await fs.resolve(targetRel, { cwd });
    } catch {
      target = null;
    }
    if (target === null) {
      sendJson(res, 400, { ok: false, error: `cannot resolve target dir ${targetRel}` });
      return;
    }

    const memoryFiles = listFilesRecursive(join(report.sourceDir, "memories"), (n) => /\.md$/i.test(n), MAX_SCAN_FILES, {});
    const imported = [];
    const skipped = [];
    const failed = [];
    const existingNames = new Set();
    try {
      const entries = await fs.listDir(target).catch(() => []);
      for (const entry of entries) {
        if (entry.type === "file") existingNames.add(entry.name);
      }
    } catch {
      /* no target yet */
    }

    for (const file of memoryFiles) {
      const parsed = parseMemoryFile(file.path, file.size);
      if (!parsed.ok) {
        failed.push({ name: file.name, error: parsed.error });
        continue;
      }
      if (parsed.body.trim().length === 0) {
        skipped.push({ name: file.name, reason: "empty body" });
        continue;
      }
      const name = uniqueName(existingNames, slugify(file.name));
      existingNames.add(name);
      const rel = `${targetRel}/${name}`;
      try {
        const targetFile = await fs.resolve(rel, { cwd });
        await fs.writeText(targetFile, parsed.body.trimEnd() + "\n");
        imported.push({
          name,
          title: parsed.title,
          tags: parsed.tags,
          rel,
          excerpt: firstLine(parsed.body),
          size: parsed.size,
        });
      } catch (error) {
        failed.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // regenerate index.md
    let indexWrote = false;
    try {
      const indexRel = `${targetRel}/index.md`;
      const indexFile = await fs.resolve(indexRel, { cwd });
      await fs.writeText(indexFile, buildMemoryIndex(imported));
      indexWrote = true;
    } catch {
      /* index write is best-effort */
    }

    sendJson(res, 200, {
      ok: true,
      sourceDir: report.sourceDir,
      targetDir: targetRel,
      imported: imported.length,
      skipped: skipped.length,
      failed: failed,
      indexWrote,
      files: imported.slice(0, 200),
    });
  }

  async function importSessions(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const sourceDir = body !== null && typeof body.sourceDir === "string" && body.sourceDir.length > 0 ? body.sourceDir : defaultSourceDir;
    const report = scanSource(sourceDir);
    if (!report.exists) {
      sendJson(res, 400, { ok: false, error: `source directory not found: ${report.sourceDir}` });
      return;
    }
    const persistence = ctx.get("sessionPersistence");
    if (persistence === void 0) {
      sendJson(res, 500, { ok: false, error: "sessionPersistence service unavailable" });
      return;
    }
    const workspaceRegistry = ctx.get("workspaceRegistry");
    const fs = ctx.get("fs");
    const requested = body !== null && Array.isArray(body.sessionIds) ? body.sessionIds.map(String).filter(Boolean) : null;
    const asTranscript = body !== null && body.asTranscript === true;

    const allFiles = listFilesRecursive(join(report.sourceDir, "sessions"), (n) => /\.jsonl$/i.test(n) || /\.jsonl\.gz$/i.test(n), MAX_SCAN_FILES, {});
    let files = allFiles;
    if (requested !== null && requested.length > 0) {
      const wanted = new Set(requested);
      files = allFiles.filter((f) => wanted.has(f.name) || wanted.has(f.path));
    }
    files = files.slice(0, maxSessions);

    const imported = [];
    const failed = [];
    let sessionIndex = 0;
    let archiveCwd = null;
    let archiveTarget = null;

    if (asTranscript && fs !== void 0) {
      const sessions = ctx.get("sessions");
      if (sessions !== void 0) {
        const list = sessions.list();
        if (list.length > 0 && list[0].header && typeof list[0].header.cwd === "string") archiveCwd = list[0].header.cwd;
      }
      if (archiveCwd !== null) {
        try {
          archiveTarget = await fs.resolve(ARCHIVE_DIR, { cwd: archiveCwd });
        } catch {
          archiveTarget = null;
        }
      }
    }

    for (const file of files) {
      let records = [];
      try {
        const raw = readFileSync(file.path, "utf8").slice(0, MAX_READ_BYTES);
        for (const line of raw.split("\n")) {
          const parsed = parseSdkLine(line);
          if (parsed !== null) records.push(parsed);
        }
      } catch (error) {
        failed.push({ name: file.name, error: `read failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (records.length === 0) {
        failed.push({ name: file.name, error: "no parseable messages" });
        continue;
      }

      const sourceSessionId = records.find((r) => r.sessionId)?.sessionId || basename(file.path, extname(file.path));
      const id = `session-openclaw-${createHash("sha1").update(file.path).digest("hex").slice(0, 8)}-${sessionIndex}`;
      sessionIndex += 1;
      const fallbackCwd = resolveCwdForImport(ctx, records.find((r) => r.cwd)?.cwd || null);
      if (fallbackCwd === null) {
        failed.push({ name: file.name, error: "no workspace cwd available" });
        continue;
      }
      const createdAt = records.find((r) => r.timestamp !== null)?.timestamp || Math.round(statSync(file.path).mtimeMs) || Date.now();

      let converted;
      try {
        converted = convertSession(records, id, fallbackCwd);
      } catch (error) {
        failed.push({ name: file.name, error: `convert failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (converted.events.length < 2) {
        failed.push({ name: file.name, error: "too few convertible messages" });
        continue;
      }

      try {
        await persistence.create({
          version: 0,
          id,
          createdAt,
          cwd: converted.meta.cwd || fallbackCwd,
          delegationDepth: 0,
        });
        await persistence.append(id, converted.events);
      } catch (error) {
        failed.push({ name: file.name, error: `persist failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }

      if (workspaceRegistry !== void 0) {
        try {
          await workspaceRegistry.create(converted.meta.cwd || fallbackCwd, converted.meta.title);
        } catch {
          /* workspace may already exist or path invalid — session is still imported */
        }
      }

      let transcriptWrote = false;
      if (asTranscript && archiveTarget !== null && archiveCwd !== null) {
        try {
          const transcriptName = `${basename(file.name, extname(file.name))}.md`;
          const targetFile = await fs.resolve(`${ARCHIVE_DIR}/${transcriptName}`, { cwd: archiveCwd });
          const text = renderTranscript(records, converted.meta.title);
          if (text.length <= MAX_TRANSCRIPT_BYTES) {
            await fs.writeText(targetFile, text);
            transcriptWrote = true;
          }
        } catch {
          /* transcript write is best-effort */
        }
      }

      imported.push({
        id,
        source: file.name,
        sourceSessionId,
        title: converted.meta.title,
        cwd: converted.meta.cwd || fallbackCwd,
        events: converted.events.length,
        messages: records.length,
        model: converted.meta.model,
        transcriptWrote,
      });
    }

    sendJson(res, 200, {
      ok: true,
      sourceDir: report.sourceDir,
      imported,
      failed,
      requested: files.length,
      note: "导入的会话由 sessionPersistence 写入；若新会话未立即出现在 Web 会话列表，刷新页面即可。",
    });
  }

  async function guide(ctx, req, res) {
    const steps = [
      "1. 在 OpenClaw 机器上导出（任选其一）：",
      "   a) openclaw memories export   （若有该子命令）",
      "   b) 直接打包数据目录： tar czf openclaw-export.tgz -C ~ .openclaw",
      "2. 把 openclaw-export.tgz（或解压出的目录）传输到本机（scp/rsync/U盘/网盘均可）。",
      "3. 在本插件卡片把「源目录」指向该目录（默认 ~/.openclaw），点「扫描」→「导入」。",
      "提示：OpenClaw 会话为 .jsonl（Claude Code SDK 格式）；.jsonl.zstd 会话当前不导入（见 README 限制）。",
    ];
    sendJson(res, 200, { ok: true, steps, defaultSourceDir });
  }
}

export { name, inject, apply };
