# Contributing to dsh-migrate-openclaw

Thanks for considering a contribution! This is a small, focused plugin, so the
bar is: **working code, honest tests, clean copy.**

## Project shape

- `src/index.js` — host half: the `/api/dsh-migrate-openclaw/*` routes (scan, status,
  import-core / import-memories / import-sessions, guide) and the OpenClaw /
  Claude Code SDK JSONL converters.
- `src/client.js` — browser half: the settings-page migration card. All
  user-facing copy lives in the `zh` / `en` dictionaries registered through
  the host locale service (`ctx.locale.register(NS, { zh, en })`); the card
  renders via `t("key", params)` with `{placeholder}` interpolation.
- `.selftest.mjs` — unit tests for the converters and memory parsing.
- `.selftest-e2e.mjs` — route-level integration tests against a mocked ctx on
  a real temp filesystem (including a fake `$HOME` so `import-core` never
  touches your real `~/.dsh`).

## Development

```sh
node --check src/index.js && node --check src/client.js
node .selftest-client.mjs  # client static checks (i18n keys, helper references)
node .selftest.mjs         # session conversion (SDK + OpenClaw formats), memory parsing
node .selftest-e2e.mjs   # route-level integration tests
```

Both test suites must pass before a PR is ready.

## Conventions

- **Code and comments in English.** The only CJK that belongs in source is
  *data content*, not UI copy: the `~/.dsh/AGENTS.md` generated marker, the
  generated `memory/index.md`, and the persona-archive header.
- **No hardcoded UI strings.** Any text the card shows goes into both the
  `zh` and `en` dictionaries in `src/client.js`, keyed by a stable key.
- **Host API messages are English.** The client owns presentation; the API
  returns English notes/errors (open-source API convention).
- **Tests travel with behavior changes.** Converter changes → extend
  `.selftest.mjs`; route/behavior changes → extend `.selftest-e2e.mjs`.
- **Commit messages** describe the *why* (see the git history for the style).

## Pull requests

1. Fork the repo, create a branch (`fix/…`, `feat/…`).
2. Make the change with tests, run both suites locally.
3. Open the PR against `main` with a short description of the change and the
   test results. CI runs the same two suites on Node 22.

## Reporting issues

Include: the DSH version (`dsh --version`), the profile (`web` / `headless`),
what you scanned (source dir shape: `memories/` vs `memory/`, session file
formats present), and the exact API response or card error. Screenshots of the
card help for UI issues.

## License

[MIT](LICENSE) © 2026 kagura-agent
