// Self-test for the dsh-openclaw session converter: feed realistic
// Claude Code SDK JSONL and check the emitted DSH event log invariants.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./src/index.js", import.meta.url), "utf8");

// The module is a Cordis entry; we can't import it directly. Extract the
// converter functions by evaluating a shimmed copy that exports them.
const shim = src
  .replace('import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";', 'const { readFileSync, readdirSync, statSync, existsSync } = await import("node:fs");')
  .replace('import { join, basename, dirname, relative, isAbsolute, extname } from "node:path";', 'const { join, basename, dirname, relative, isAbsolute, extname } = await import("node:path");')
  .replace('import { homedir } from "node:os";', 'const { homedir } = await import("node:os");')
  .replace('import { randomUUID } from "node:crypto";', 'import { randomUUID, createHash } from "node:crypto";')
  .replace('import { createHash } from "node:crypto";', "")
  .replace("export { name, inject, apply };", "export { name, inject, apply, parseSdkLine, convertSession, renderTranscript, sdkBlocksToDsh, parseMemoryFile, buildMemoryIndex, slugify };");

const mod = await import("data:text/javascript;base64," + Buffer.from(shim).toString("base64"));
const { parseSdkLine, convertSession, renderTranscript, parseMemoryFile, buildMemoryIndex, slugify } = mod;

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ok  ${label}`);
  else { failures += 1; console.log(`FAIL  ${label}`); }
};

// --- fixture: one exchange with a tool call loop --------------------------
const sdkLines = [
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "请列出 /tmp 下的文件" }], id: "u1", timestamp: "2026-08-01T10:00:00.000Z" }, sessionId: "sess-abc", cwd: "/home/me/proj" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "我用 Bash 看一下。" },
    { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls /tmp" } }
  ], id: "a1", model: "claude-sonnet-4-5", timestamp: "2026-08-01T10:00:03.000Z" } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "file1\nfile2" }], is_error: false }
  ], id: "t1", timestamp: "2026-08-01T10:00:05.000Z" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "共有 2 个文件。" }], id: "a2", model: "claude-sonnet-4-5", timestamp: "2026-08-01T10:00:07.000Z" } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "好的，谢谢" }], id: "u2", timestamp: "2026-08-01T10:00:20.000Z" } }),
  JSON.stringify({ type: "summary", message: { role: "user", content: "compaction" } }),
];

const records = sdkLines.map(parseSdkLine).filter(Boolean);
console.log(`parsed records: ${records.length}`);
check(records.length === 5, "summary line skipped");

const { events, meta } = convertSession(records, "session-test", "/home/me/proj");
console.log(`events: ${events.length}`);
const types = events.map((e) => e.type);
check(types[0] === "turn/start", "log opens with turn/start");
check(types[types.length - 1] === "turn/end", "log closes with turn/end");
check(types.includes("user/message"), "has user/message");
check(types.includes("assistant/message"), "has assistant/message");
check(types.includes("tool/call"), "has tool/call");
check(types.includes("tool/result"), "has tool/result");
check(types.includes("request/header"), "has request/header");
check(events.every((e, i) => e.seq === i), "seq contiguous 0..n");
check(events.every((e, i) => i === 0 || e.time >= events[i - 1].time), "time monotonic");
const surface = events.filter((e) => ["user/message", "assistant/message", "tool/result"].includes(e.type));
check(surface.every((e) => e.surfaceOp === "append"), "surface events carry surfaceOp append");

const toolResult = events.find((e) => e.type === "tool/result");
check(toolResult && toolResult.data.callId === "toolu_01", "tool result correlated by call id");
check(toolResult && toolResult.data.message.content[0].type === "tool-result", "tool-result block shape");
check(meta.model === "claude-sonnet-4-5", "model detected");
check(meta.cwd === "/home/me/proj", "cwd detected");
check(meta.title.includes("请列出"), "title from first user text");

// request/header carries the pre-scanned model, not the default placeholder
const header = events.find((e) => e.type === "request/header");
check(header && header.data.header.config.model === "claude-sonnet-4-5", "request/header uses pre-scanned model");

// --- slugify keeps CJK ------------------------------------------------------
check(slugify("项目约定.md") === "项目约定.md", "slugify keeps CJK filename");
check(slugify("Preferences.md") === "Preferences.md", "slugify keeps ascii filename");
check(slugify("###.md") === "memory.md", "slugify falls back on non-word name");

// two human prompts → two turns
const turnStarts = events.filter((e) => e.type === "turn/start").length;
check(turnStarts === 2, `two turns for two human prompts (got ${turnStarts})`);

// --- transcript rendering --------------------------------------------------
const transcript = renderTranscript(records, meta.title);
check(transcript.includes("**user**") && transcript.includes("**assistant**") && transcript.includes("**tool_result**"), "transcript has user/assistant/tool_result sections");

// --- memory parsing ---------------------------------------------------------
const mem = parseMemoryFile("/tmp/stage-repo/plugins/dsh-openclaw/README.md", 0);
check(mem.ok === true, "readme parses as memory");
const memText = "---\ntitle: 测试记忆\ntags: [a, b, c]\n---\n# 标题\n\n正文内容";
const mem2 = parseMemoryFile("/dev/stdin", 0);
// parseMemoryFile reads from path; use a temp file instead
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/stage-repo/.memtest.md", memText);
const mem3 = parseMemoryFile("/tmp/stage-repo/.memtest.md", 0);
check(mem3.ok && mem3.title === "测试记忆", "frontmatter title parsed");
check(Array.isArray(mem3.tags) && mem3.tags.join(",") === "a,b,c", "frontmatter tags parsed");
const index = buildMemoryIndex([{ title: "T1", tags: ["x"], rel: "memory/t1.md", excerpt: "first line" }]);
check(index.includes("| T1 | x | `memory/t1.md` | first line |"), "index row rendered");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
