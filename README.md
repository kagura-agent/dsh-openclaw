# dsh-migrate-openclaw

**OpenClaw → DeepSeek Harness migration plugin**: scan an OpenClaw data directory and move long-term memory and session history into DSH. Installed on the dsh web profile, it adds a "dsh-migrate-openclaw" card to the settings page — fully browser-driven, no CLI needed.

[中文版](README.zh.md)

## Features

| Content | Destination | Fidelity |
|---------|-------------|----------|
| Persona core (`IDENTITY.md` / `SOUL.md` / `USER.md` / `AGENTS.md` / `MEMORY.md`) | **`~/.dsh/AGENTS.md` (the DSH global instruction layer — injected into every workspace's sessions)** | verbatim merge + an environment-adaptation header |
| Daily notes (`memories/*.md` or `memory/*.md`) | current workspace `memory/*.md` + a generated `memory/index.md` index | lossless (it's Markdown) |
| Sessions (`sessions/*.jsonl`, OpenClaw event format **or** Claude Code SDK format) | native DSH session logs (written via `sessionPersistence`), queryable by the query engine | text 100%; `toolCall`→tool-call, `thinking`→reasoning mapped as best as possible; token usage / reasoning details not restored |
| Sessions (optional Markdown transcript) | workspace `archive/openclaw/*.md` | human-readable full text |
| Config / plugins | scanned and reported only, not migrated (formats are not portable) | — |

> Imported sessions land in persistent storage (`~/.dsh/sessions/…`). The Web session list only shows **live** sessions, so imported history does not appear there automatically (see [Known limitations](#known-limitations)).

## Why the layered import (persona → global layer)

In OpenClaw, an agent's "chemistry" lives mostly in the workspace files `SOUL.md` (persona/tone), `IDENTITY.md` (identity), `USER.md` (the human model), `AGENTS.md` (operating discipline) and `MEMORY.md` (long-term memory), which are **injected at the start of every session**. DSH's equivalent is `~/.dsh/AGENTS.md`: the `dsh-agent-instructions` service injects it at the start of every session **in every workspace** (same bootstrap behavior as OpenClaw). So the persona core goes to the global layer and **survives across workspaces**, while daily-note memories go to the workspace `memory/` for on-demand retrieval.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-migrate-openclaw
```

Then append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: openclaw
      name: 'dsh-migrate-openclaw'
      config:
        # Default source directory to scan (the card can override it per run)
        defaultSourceDir: '~/.openclaw'
        # Per-run session import cap
        # maxSessionsPerImport: 200
```

Config changes apply live via HMR — no restart needed for config.

## Usage

1. Open dsh Web → Settings → plugin config → **dsh-migrate-openclaw**.
2. Confirm the source directory (default `~/.openclaw`; point it at a copied export directory for cross-machine migration).
3. **Scan** → see how many daily notes / sessions / persona core files were found.
4. **① Import persona → `~/.dsh/AGENTS.md`** → persona core goes to the DSH global instruction layer, injected into every new workspace session.
5. **② Import daily notes** → notes go to the current workspace `memory/`, and `memory/index.md` is generated.
6. **③ Import sessions** → history is written to the DSH session store; tick "Also write Markdown transcripts" to keep a human-readable copy in `archive/openclaw/`.
7. The result card reports imported / skipped / failed per file, so failures can be traced to specific files.

After migration the agent can read `memory/index.md` to retrieve daily notes; the persona and long-term memory are injected automatically at the start of every session.

## Cross-machine migration (OpenClaw and DSH on different machines)

Nothing needs to be installed on the OpenClaw side:

```sh
# On the OpenClaw machine
openclaw memories export          # if the subcommand exists; or just:
tar czf openclaw-export.tgz -C ~ .openclaw
```

Copy `openclaw-export.tgz` (or its extracted directory) to the DSH machine (scp/rsync/USB/cloud drive), point the card's source directory at it, and follow the same flow. The card has a built-in export guide.

## How it works

- **Persona core**: locates `IDENTITY.md` / `SOUL.md` / `USER.md` / `AGENTS.md` / `MEMORY.md` in the source root (or in a `workspace/` / `core/` / `openclaw-core/` subdirectory), merges them in a fixed order (with an environment-adaptation header and a generated marker), and writes `~/.dsh/AGENTS.md`. If the target exists and does **not** carry the marker (i.e. it was hand-edited), it is backed up as `.bak-<ts>` first.
- **Memory**: parses Markdown (frontmatter `title`/`tags`, falling back to the first H1 or the file name), writes into the workspace through the dsh `fs` service (respecting workspace path rules).
- **Sessions**: parses JSONL line by line — **OpenClaw event format** (`{type:"message", message:{role, content}}` with `toolCall`/`thinking` blocks; `compaction`/`model_change` events are skipped) **or** Claude Code SDK format (`{type, message}` envelopes or bare messages; `.jsonl.gz` is gunzipped automatically) — maps `tool_use`/`toolCall` → `tool-call`, `thinking` → `reasoning`, `tool_result`/`toolResult` → `tool-result`, produces a contiguous typed event log (`turn/start` … `turn/end`) and writes it via `ctx.sessionPersistence.create/append` — the query engine discovers it by directory scan. The target workspace is chosen in priority order: the requesting session's workspace (the browser sends its session id automatically) → the source cwd (when it exists on this machine) → any stored session's cwd → the current session workspace.

## Known limitations

- **`.jsonl.zstd` sessions are not imported** (scanned, reported, skipped); `.jsonl.gz` is supported, plain `.jsonl` needs no processing.
- Session import is **lossy**: token usage, model reasoning details and image attachments are not restored; continuing a chat uses DSH's currently configured model.
- Imported sessions **do not appear in the Web session list automatically**: the list shows only live sessions; imported sessions live in persistent storage for the query engine — load them through a history/restore entry point if the deployment provides one.
- Re-importing the same directory is **idempotent**: already-imported sessions are skipped (the backend is append-only, no overwrite).
- Re-importing the persona core **overwrites** `~/.dsh/AGENTS.md` (no backup when it already carries the marker; hand-edited targets are backed up first).
- Per-run caps: 1000 notes, 200 sessions (`maxSessionsPerImport` is configurable).

## Development

```sh
node --check src/index.js && node --check src/client.js
node .selftest.mjs       # session conversion (SDK + OpenClaw formats) / memory parsing
node .selftest-e2e.mjs   # route-level integration tests (mocked ctx + real temp filesystem)
```

## License

[MIT](LICENSE) © 2026 kagura-agent
