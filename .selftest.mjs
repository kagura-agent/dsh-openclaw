// Self-test for the dsh-openclaw session converter: feed realistic
// Claude Code SDK JSONL and check the emitted DSH event log invariants.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync(new URL("./src/index.js", import.meta.url), "utf8");

// The module is a Cordis entry; we can't import it directly. Extract the
// converter functions by evaluating a shimmed copy that exports them.
const shim = src
  .replace('import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, copyFileSync } from "node:fs";', 'const { readFileSync, readdirSync, statSync, existsSync, writeFileSync, copyFileSync } = await import("node:fs");')
  .replace('import { join, basename, dirname, relative, isAbsolute, extname } from "node:path";', 'const { join, basename, dirname, relative, isAbsolute, extname } = await import("node:path");')
  .replace('import { homedir } from "node:os";', 'const { homedir } = await import("node:os");')
  .replace('import { randomUUID } from "node:crypto";', 'import { randomUUID, createHash } from "node:crypto";')
  .replace('import { createHash } from "node:crypto";', "")
  .replace('import { gunzipSync } from "node:zlib";', 'const { gunzipSync } = await import("node:zlib");')
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
import { writeFileSync, mkdirSync } from "node:fs";
const memDir = join(tmpdir(), "dsh-openclaw-selftest-" + Date.now());
mkdirSync(memDir, { recursive: true });
const mem = parseMemoryFile(join(memDir, "README.md"), 0);
writeFileSync(join(memDir, "README.md"), "# 测试 README\n\n内容");
check(mem.ok === false, "absent file reports not-ok (parsed before write)");
const memText = "---\ntitle: 测试记忆\ntags: [a, b, c]\n---\n# 标题\n\n正文内容";
writeFileSync(join(memDir, ".memtest.md"), memText);
const mem3 = parseMemoryFile(join(memDir, ".memtest.md"), 0);
check(mem3.ok && mem3.title === "测试记忆", "frontmatter title parsed");
check(Array.isArray(mem3.tags) && mem3.tags.join(",") === "a,b,c", "frontmatter tags parsed");
const index = buildMemoryIndex([{ title: "T1", tags: ["x"], rel: "memory/t1.md", excerpt: "first line" }]);
check(index.includes("| T1 | x | `memory/t1.md` | first line |"), "index row rendered");

// --- OpenClaw event format ----------------------------------------------------
// OpenClaw sessions are NOT Claude Code SDK JSONL: {type:"message", id, timestamp,
// message:{role, content}} with thinking/toolCall blocks and model on the message.
const openclawLines = [
  JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-08-15T14:30:01.993Z", cwd: "/home/kagura/.openclaw/workspace" }),
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-15T14:30:02.124Z", message: { role: "user", content: "你好" } }),
  JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-15T14:30:03.000Z", message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "[Reasoning redacted]", redacted: true },
      { type: "text", text: "我来看看" },
      { type: "toolCall", id: "call_01", name: "exec", arguments: { command: "ls" } },
    ],
    model: "deepseek-v4-flash", timestamp: "2026-08-15T14:30:03.000Z",
  } }),
  JSON.stringify({ type: "compaction", id: "c1" }),
  JSON.stringify({ type: "model_change", id: "mc1", modelId: "deepseek-v4-flash" }),
];
const ocRecords = openclawLines.map(parseSdkLine).filter(Boolean);
check(ocRecords.length === 2, "openclaw: session/compaction/model_change skipped, 2 messages parsed");
check(ocRecords[0].role === "user" && ocRecords[0].content[0].text === "你好", "openclaw: user text parsed");
check(ocRecords[1].model === "deepseek-v4-flash", "openclaw: model detected from message");
check(ocRecords[1].timestamp === Date.parse("2026-08-15T14:30:03.000Z"), "openclaw: timestamp from message/raw");
const ocEvents = convertSession(ocRecords, "session-oc", "/tmp/x").events;
check(ocEvents.some((e) => e.type === "tool/call" && e.data.name === "exec"), "openclaw: toolCall mapped to tool/call");
check(ocEvents.some((e) => e.type === "assistant/message" && e.data.message.content.some((b) => b.type === "reasoning")), "openclaw: thinking block mapped to reasoning");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
