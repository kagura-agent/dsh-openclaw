# dsh-migrate-openclaw

[English](README.md)

**OpenClaw → DeepSeek Harness 迁移插件**：扫描 OpenClaw 数据目录，把长期记忆和会话历史搬进 DSH。
装在 dsh web profile 上，设置页出现「dsh-migrate-openclaw」卡片，全程浏览器操作，无需命令行。

## 功能

| 内容 | 迁移后去向 | 保真度 |
|------|-----------|--------|
| 人格核心（`IDENTITY.md`/`SOUL.md`/`USER.md`/`AGENTS.md`/`MEMORY.md`） | **`~/.dsh/AGENTS.md`（DSH 全局指令层，所有 workspace 的会话自动注入）** | 原样合并 + 环境适配头 |
| 记忆（`memories/*.md` 或 `memory/*.md`） | 当前工作区 `memory/*.md` + 自动生成的 `memory/index.md` 索引 | 无损（本质就是 Markdown） |
| 会话（`sessions/*.jsonl`，OpenClaw 事件格式 **或** Claude Code SDK 格式） | DSH 原生会话日志（`sessionPersistence` 写入），查询引擎可检索 | 文本消息 100%；`toolCall`→tool-call、`thinking`→reasoning 尽量映射；token 用量/推理细节不还原 |
| 会话（可选 Markdown 存档） | 工作区 `archive/openclaw/*.md` | 人读全文 |
| 配置 / 插件 | 仅扫描报告，不迁移（格式不通用） | — |

> 会话导入后落在持久化存储（`~/.dsh/sessions/…`），Web 会话列表只显示**当前活跃会话**，导入的历史会话不会自动出现（见[已知限制](#已知限制)）。

## 为什么分层导入（人格 → 全局层）

OpenClaw 里一个 agent 的"默契"主要由 workspace 的 `SOUL.md`（人格/语气）、`IDENTITY.md`（身份）、`USER.md`（人类模型）、`AGENTS.md`（操作纪律）、`MEMORY.md`（长期记忆）承载，它们在**每个会话开始注入**。DSH 的等价位置是 `~/.dsh/AGENTS.md`——DSH 的 `dsh-agent-instructions` 会在**每个 workspace** 的会话开始注入它（与 OpenClaw 的 bootstrap 行为一致）。所以人格核心放到全局层，**迁移后 kagura 活在所有 workspace**；日记类记忆进工作区 `memory/` 供按需检索。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-migrate-openclaw
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: openclaw
      name: 'dsh-migrate-openclaw'
      config:
        # 默认扫描的源目录（界面可临时改）
        defaultSourceDir: '~/.openclaw'
        # 单次会话导入上限
        # maxSessionsPerImport: 200
```

配置 HMR 实时生效，无需重启。

## 使用

1. 打开 dsh Web → 设置 → 插件配置 → **dsh-migrate-openclaw**。
2. 确认源目录（默认 `~/.openclaw`；跨机器迁移时指向拷贝过来的导出目录）。
3. **扫描** → 查看发现了多少记忆/会话/人格核心。
4. **导入人格 → `~/.dsh/AGENTS.md`** → 人格核心写入 DSH 全局指令层，所有 workspace 的新会话自动注入。
5. **导入记忆** → 日记进入工作区 `memory/`，索引 `memory/index.md` 生成。
6. **导入会话** → 历史会话写入 DSH 会话库；勾选「同时生成 Markdown 存档」则在 `archive/openclaw/` 留一份人读全文。
7. 结果卡片回报成功/跳过/失败明细（失败可定位到具体文件）。

导入后 DSH agent 即可读取 `memory/index.md` 检索日记记忆；人格与长期记忆已在每个会话开始时自动注入。

## 跨机器迁移（OpenClaw 与 DSH 不在同一台机器）

OpenClaw 侧无需安装任何东西：

```sh
# 在 OpenClaw 机器上
openclaw memories export          # 若有该子命令；或直接：
tar czf openclaw-export.tgz -C ~ .openclaw
```

把 `openclaw-export.tgz`（或解压目录）传到 DSH 机器（scp/rsync/U盘/网盘），
在卡片把「源目录」指向它，其余流程相同。卡片内置「导出指引」可直接查看。

## 工作原理

- **人格核心**：识别源目录（或其 `workspace/`/`core/`/`openclaw-core/` 子目录）下的
  `IDENTITY.md`/`SOUL.md`/`USER.md`/`AGENTS.md`/`MEMORY.md`，按固定顺序聚合（含环境适配头与生成标记），
  写入 `~/.dsh/AGENTS.md`。目标已存在且**不含**生成标记（即人工编辑过）时先备份为 `.bak-<ts>`。
- **记忆**：解析 Markdown（含 frontmatter 的 `title`/`tags`，缺失时回退到首个 H1/文件名），
  经 dsh `fs` 服务写入工作区（尊重工作区路径规则）。
- **会话**：逐行解析 JSONL——**OpenClaw 事件格式**（`{type:"message", message:{role, content}}`，
  `toolCall`/`thinking` block、`compaction`/`model_change` 事件跳过）**或** Claude Code SDK 格式
  （`{type, message}` 信封/裸消息；`.jsonl.gz` 自动解压），
  把 `tool_use`/`toolCall` 映射为 `tool-call` 块、`thinking` 映射为 `reasoning`、
  `tool_result`/`toolResult` 映射为 `tool-result` 块，
  生成连续的 typed 事件日志（`turn/start` … `turn/end`），经
  `ctx.sessionPersistence.create/append` 写入——查询引擎按目录扫描自动发现。
  落点工作区按优先级取：卡片所在会话的工作区（浏览器自动携带）→ 原 cwd（本机存在时）
  → 任意已存会话的工作区 → 当前会话工作区。

## 已知限制

- **`.jsonl.zstd` 会话不导入**（扫描会报告但跳过）；`.jsonl.gz` 支持导入，普通 `.jsonl` 无需处理。
- 会话导入是**有损转换**：token 用量、模型推理细节、图片附件不还原；续聊时 DSH 使用当前配置的模型。
- 导入的会话**不会自动出现在 Web 会话列表**：列表只显示当前活跃会话，导入的会话只进入持久化存储，
  供查询引擎检索；若部署提供历史/恢复入口可从那里加载。
- 重复导入同一目录是**幂等**的：已导入过的会话会跳过（后端是 append-only，不支持覆盖）。
- 人格核心重复导入会**覆盖** `~/.dsh/AGENTS.md`（已含生成标记时不备份；人工编辑过先备份）。
- 单次导入上限：记忆 1000 条、会话 200 个（`maxSessionsPerImport` 可调）。

## 开发

```sh
node --check src/index.js && node --check src/client.js
node .selftest.mjs       # 会话转换（SDK + OpenClaw 格式）/记忆解析自测
node .selftest-e2e.mjs   # 路由级集成测试（mock ctx + 真实临时文件系统）
```

## License

[MIT](LICENSE) © 2026 kagura-agent
