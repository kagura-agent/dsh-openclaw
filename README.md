# dsh-openclaw

**OpenClaw → DeepSeek Harness 迁移插件**：扫描 OpenClaw 数据目录，把长期记忆和会话历史搬进 DSH。
装在 dsh web profile 上，设置页出现「dsh-openclaw」卡片，全程浏览器操作，无需命令行。

## 功能

| 内容 | 迁移后去向 | 保真度 |
|------|-----------|--------|
| 记忆（`memories/*.md`） | 当前工作区 `memory/*.md` + 自动生成的 `memory/index.md` 索引 | 无损（本质就是 Markdown） |
| 会话（`sessions/*.jsonl`，Claude Code SDK 格式） | DSH 原生会话日志（`sessionPersistence` 写入），Web 会话列表可见 | 文本消息 100%；工具调用尽量映射；token 用量/推理内容不还原 |
| 会话（可选 Markdown 存档） | 工作区 `archive/openclaw/*.md` | 人读全文 |
| 配置 / 插件 | 仅扫描报告，不迁移（格式不通用） | — |

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-openclaw
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: openclaw
      name: 'dsh-openclaw'
      config:
        # 默认扫描的源目录（界面可临时改）
        defaultSourceDir: '~/.openclaw'
        # 单次会话导入上限
        # maxSessionsPerImport: 200
```

配置 HMR 实时生效，无需重启。

## 使用

1. 打开 dsh Web → 设置 → 插件配置 → **dsh-openclaw**。
2. 确认源目录（默认 `~/.openclaw`；跨机器迁移时指向拷贝过来的导出目录）。
3. **扫描** → 查看发现了多少记忆/会话。
4. **导入记忆** → 记忆进入工作区 `memory/`，索引 `memory/index.md` 生成。
5. **导入会话** → 历史会话写入 DSH 会话库；勾选「同时生成 Markdown 存档」则在 `archive/openclaw/` 留一份人读全文。
6. 结果卡片回报成功/跳过/失败明细（失败可定位到具体文件）。

导入后 DSH agent 即可读取 `memory/index.md` 检索长期记忆（文件就是记忆）。

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

- **记忆**：解析 Markdown（含 frontmatter 的 `title`/`tags`，缺失时回退到首个 H1/文件名），
  经 dsh `fs` 服务写入工作区（尊重工作区路径规则）。
- **会话**：逐行解析 SDK 风格 JSONL（`{type, message}` 信封或裸消息对象都支持），
  把 `tool_use`/`tool_result` 映射为 DSH 的 `tool-call`/`tool-result` 块，
  生成连续的 typed 事件日志（`turn/start` … `turn/end`），经
  `ctx.sessionPersistence.create/append` 写入——查询引擎会自动摄入，Web 会话列表可见。
  原 cwd 在本机存在时保留（自动归入对应工作区），否则落到当前会话工作区。

## 已知限制

- **`.jsonl.zstd` 会话不导入**（扫描会报告但跳过）；请先在 OpenClaw 侧导出为普通 `.jsonl`。
- 会话导入是**有损转换**：token 用量、模型推理细节、图片附件不还原；续聊时 DSH 使用当前配置的模型。
- 单次导入上限：记忆 1000 条、会话 200 个（`maxSessionsPerImport` 可调）。
- 导入的会话若未立即出现在会话列表，刷新页面即可（查询引擎摄入是异步的）。

## 开发

```sh
node --check src/index.js && node --check src/client.js
node .selftest.mjs     # 会话转换/记忆解析自测
```

## License

[MIT](LICENSE) © 2026 kagura-agent
