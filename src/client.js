// dsh-openclaw client half — migration card in the settings plugin list.
//
// A single card with: source-directory input (default ~/.openclaw), persona /
// memory / session import actions, a per-run result summary, and a collapsible
// cross-machine export guide. All work happens through the host half's
// /api/dsh-openclaw/* routes; a dsh-web-auth deployment gates those routes
// behind the password cookie like every other /api route.
// UI copy is localized through the host locale service (en + zh dictionaries).
window.__ModuleLoader__.load({
	id: "dsh-openclaw",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-openclaw-client";
		const inject = ["slots", "sessions", "locale"];

		const API = "/api/dsh-openclaw";
		/** Locale namespace owning this card's copy. */
		const NS = "dsh-openclaw";
		/** Simplified Chinese copy. */
		const zh = {
			subtitle: "OpenClaw → DSH 迁移：人格 + 记忆 + 会话导入",
			expand: "展开",
			collapse: "收起",
			sourceDirLabel: "OpenClaw 数据目录",
			sourceDirPlaceholder: "~/.openclaw 或导出目录路径",
			scan: "扫描",
			importCore: "① 导入人格",
			importMemories: "② 导入日记",
			importSessions: "③ 导入会话",
			asTranscript: "同时生成 Markdown 存档",
			busyScan: "扫描中…",
			busyCore: "导入人格中…",
			busyMemories: "导入日记中…",
			busySessions: "导入会话中…",
			scanResult: "记忆 {memories} 个（{memSize}） · 会话 {sessions} 个（{sesSize}）{core}{config}{plugins}",
			scanCore: " · 人格核心 {count} 个（{names}）",
			scanConfig: " · 配置 {name}",
			scanPlugins: " · 插件 {count} 个（仅清单）",
			statusCore: "人格 {state}（{total}）",
			statusCoreDone: "✓",
			statusCorePending: "未导入",
			statusCoreNone: "—",
			statusMemories: "日记 {imported}/{total}",
			statusSessions: "会话 {imported}/{total}",
			statusSessionsNoSource: "会话 {imported}（源无会话记录）",
			stepsHint: "迁移顺序：① 人格（全局注入，所有工作区生效）→ ② 日记（当前工作区 memory/）→ ③ 会话（DSH 会话库）",
			coreDone: "导入人格核心 {count} 个 → {target}（{bytes} 字节{backedUp}）\n{note}",
			coreBackedUp: "，旧文件已备份",
			memoriesDone: "导入日记 {imported} 条 → {cwd}/{targetDir}/（索引{index}）",
			memoriesIndexOk: "已生成",
			memoriesIndexFail: "生成失败",
			memoriesSkipped: "，跳过 {count} 条",
			failures: "\n失败 {count} 条：\n{detail}",
			sessionsDone: "导入会话 {imported} 个{skipped}{failed}{first}{note}",
			sessionsSkipped: "，跳过 {count} 个（已导入过）",
			sessionsFailed: "，失败 {count} 个",
			sessionsFirst: "\n{list}",
			sessionsEllipsis: "\n…",
			sessionsSkippedDetail: "\n已跳过：{names}",
			sessionsFailedDetail: "\n失败详情：\n{detail}",
			sourceLine: "源：{source}{unsupported}",
			sourceUnsupported: "；不支持：{names}",
			guideToggle: "跨机器迁移：导出指引",
			guideToggleClose: "收起导出指引",
			guideFetchFail: "获取失败：{error}",
			errFallback: "HTTP {status}",
		};
		/** English copy (default for open-source use). */
		const en = {
			subtitle: "OpenClaw → DSH migration: persona + memories + sessions",
			expand: "Expand",
			collapse: "Collapse",
			sourceDirLabel: "OpenClaw data directory",
			sourceDirPlaceholder: "~/.openclaw or an exported directory",
			scan: "Scan",
			importCore: "① Import persona",
			importMemories: "② Import daily notes",
			importSessions: "③ Import sessions",
			asTranscript: "Also write Markdown transcripts",
			busyScan: "Scanning…",
			busyCore: "Importing persona…",
			busyMemories: "Importing daily notes…",
			busySessions: "Importing sessions…",
			scanResult: "{memories} memories ({memSize}) · {sessions} sessions ({sesSize}){core}{config}{plugins}",
			scanCore: " · persona core {count} ({names})",
			scanConfig: " · config {name}",
			scanPlugins: " · {count} plugins (inventory only)",
			statusCore: "Persona {state} ({total})",
			statusCoreDone: "✓",
			statusCorePending: "pending",
			statusCoreNone: "—",
			statusMemories: "Notes {imported}/{total}",
			statusSessions: "Sessions {imported}/{total}",
			statusSessionsNoSource: "Sessions {imported} (source has none)",
			stepsHint: "Order: ① persona (global injection, every workspace) → ② notes (current workspace memory/) → ③ sessions (DSH session store)",
			coreDone: "Imported persona core {count} → {target} ({bytes} bytes{backedUp})\n{note}",
			coreBackedUp: ", previous file backed up",
			memoriesDone: "Imported {imported} notes → {cwd}/{targetDir}/ (index {index})",
			memoriesIndexOk: "written",
			memoriesIndexFail: "failed",
			memoriesSkipped: ", {count} skipped",
			failures: "\n{count} failed:\n{detail}",
			sessionsDone: "Imported {imported} sessions{skipped}{failed}{first}{note}",
			sessionsSkipped: ", {count} skipped (already imported)",
			sessionsFailed: ", {count} failed",
			sessionsFirst: "\n{list}",
			sessionsEllipsis: "\n…",
			sessionsSkippedDetail: "\nSkipped: {names}",
			sessionsFailedDetail: "\nFailures:\n{detail}",
			sourceLine: "Source: {source}{unsupported}",
			sourceUnsupported: "; unsupported: {names}",
			guideToggle: "Cross-machine migration: export guide",
			guideToggleClose: "Hide export guide",
			guideFetchFail: "Failed to load: {error}",
			errFallback: "HTTP {status}",
		};
		const styles = {
			li: { listStyle: "none" },
			article: {
				border: "1px solid #d4d9e0",
				borderRadius: 12,
				background: "#fff",
				color: "#1c2024",
				overflow: "hidden"
			},
			headerBtn: {
				width: "100%",
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "14px 16px",
				border: 0,
				background: "none",
				cursor: "pointer",
				textAlign: "left",
				font: "inherit",
				color: "inherit"
			},
			body: {
				borderTop: "1px solid #e4e8ee",
				padding: "12px 16px 14px",
				fontSize: 13,
				color: "#5a6472",
				lineHeight: 1.6
			},
			row: { display: "flex", gap: 8, margin: "10px 0", flexWrap: "wrap" },
			input: {
				flex: 1,
				minWidth: 200,
				boxSizing: "border-box",
				padding: "8px 10px",
				border: "1px solid #d4d9e0",
				borderRadius: 8,
				fontSize: 13,
				outline: "none"
			},
			btn: {
				padding: "8px 14px",
				border: "1px solid #c9d1dc",
				borderRadius: 8,
				background: "#f6f8fa",
				color: "#1c2024",
				fontSize: 13,
				cursor: "pointer"
			},
			btnPrimary: {
				padding: "8px 14px",
				border: 0,
				borderRadius: 8,
				background: "#1f6feb",
				color: "#ffffff",
				fontSize: 13,
				fontWeight: 600,
				cursor: "pointer"
			},
			msg: { margin: "8px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word" },
			ok: { color: "#1a7f37" },
			err: { color: "#c0392b" },
			muted: { color: "#8a94a3", fontSize: 12 }
		};

		function OpenClawCard({ ctx }) {
			const [open, setOpen] = react.useState(false);
			const [sourceDir, setSourceDir] = react.useState("~/.openclaw");
			const [busy, setBusy] = react.useState(null); // null | 'scan' | 'memories' | 'sessions' | 'core'
			const [inventory, setInventory] = react.useState(null);
			const [status, setStatus] = react.useState(null); // migration completion status
			const [result, setResult] = react.useState(null); // { kind, ok, text }
			const [showGuide, setShowGuide] = react.useState(false);
			const [guide, setGuide] = react.useState(null);
			const [asTranscript, setAsTranscript] = react.useState(true);

			// Localized copy: bind our namespace and re-render when the locale
			// changes (the host locale service notifies subscribers on revision).
			const t = ctx.locale.bind(NS);
			const [, forceRender] = react.useReducer((x) => x + 1, 0);
			react.useEffect(() => ctx.locale.subscribe(() => forceRender()), [ctx]);

			// The id of the session this card is running in, so imports land in
			// THIS session's workspace (the host falls back to a heuristic when
			// absent, e.g. for direct API calls without a browser session).
			const currentSessionId = () => {
				try {
					const sessions = ctx && typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
					if (sessions && sessions.currentProvideInfo) {
						const info = sessions.currentProvideInfo.getSnapshot();
						if (info && info.sessionId) return info.sessionId;
					}
				} catch {
					/* ignore — host-side fallback applies */
				}
				return null;
			};

			const post = async (path, payload) => {
				const sessionId = currentSessionId();
				const body = sessionId !== null ? { ...payload, sessionId } : payload;
				const res = await fetch(API + path, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) {
					throw new Error((data && data.error) || t("errFallback", { status: res.status }));
				}
				return data;
			};

			// Refresh the migration completion status (guards against a stale
			// host that has no /status route yet — pre-restart compatibility).
			const fetchStatus = async () => {
				try {
					const data = await post("/status", { sourceDir });
					setStatus(data);
				} catch {
					setStatus(null);
				}
			};

			const runScan = async () => {
				setBusy("scan");
				setResult(null);
				try {
					const data = await post("/scan", { sourceDir });
					setInventory(data);
					// `core` may be absent when talking to an older host (pre-restart);
					// guard every field so a stale host cannot break the card.
					const core = data.core && typeof data.core === "object" ? data.core : null;
					setResult({
						kind: "ok",
						text:
							t("scanResult", {
								memories: data.memories.count,
								memSize: data.memories.sizeLabel,
								sessions: data.sessions.count,
								sesSize: data.sessions.sizeLabel,
								core: core && core.count > 0 ? t("scanCore", { count: core.count, names: core.files.map((f) => f.name.replace(/\.md$/i, "")).join("/") }) : "",
								config: data.config ? t("scanConfig", { name: data.config.name }) : "",
								plugins: data.plugins.count > 0 ? t("scanPlugins", { count: data.plugins.count }) : ""
							})
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
				void fetchStatus();
			};

			const runMemories = async () => {
				setBusy("memories");
				setResult(null);
				try {
					const data = await post("/import-memories", { sourceDir });
					const failures = (data.failed || []).map((f) => `${f.name}: ${f.error}`).join("\n");
					setResult({
						kind: "ok",
						text:
							t("memoriesDone", {
								imported: data.imported,
								cwd: data.cwd || "",
								targetDir: data.targetDir,
								index: data.indexWrote ? t("memoriesIndexOk") : t("memoriesIndexFail")
							}) +
							(data.skipped > 0 ? t("memoriesSkipped", { count: data.skipped }) : "") +
							(data.failed.length > 0 ? t("failures", { count: data.failed.length, detail: failures }) : "")
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
				void fetchStatus();
			};

			const runSessions = async () => {
				setBusy("sessions");
				setResult(null);
				try {
					const data = await post("/import-sessions", { sourceDir, asTranscript });
					const failures = (data.failed || []).map((f) => `${f.name}: ${f.error}`).join("\n");
					const first = (data.imported || []).slice(0, 5).map((s) => `· ${s.title}（${s.events} 事件）`).join("\n");
					setResult({
						kind: "ok",
						text:
							t("sessionsDone", {
								imported: data.imported.length,
								skipped: data.skipped.length > 0 ? t("sessionsSkipped", { count: data.skipped.length }) : "",
								failed: data.failed.length > 0 ? t("sessionsFailed", { count: data.failed.length }) : "",
								first: data.imported.length > 0 ? t("sessionsFirst", { list: first + (data.imported.length > 5 ? t("sessionsEllipsis") : "") }) : "",
								note: data.note ? `\n${data.note}` : ""
							}) +
							(data.skipped.length > 0 ? t("sessionsSkippedDetail", { names: data.skipped.map((s) => s.name).join(", ") }) : "") +
							(data.failed.length > 0 ? t("sessionsFailedDetail", { detail: failures }) : "")
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
				void fetchStatus();
			};

			const runCore = async () => {
				setBusy("core");
				setResult(null);
				try {
					const data = await post("/import-core", { sourceDir });
					setResult({
						kind: "ok",
						text:
							t("coreDone", {
								count: data.files.length,
								target: data.target,
								bytes: data.bytes,
								backedUp: data.backedUp ? t("coreBackedUp") : "",
								note: data.note || ""
							})
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
				void fetchStatus();
			};

			const toggleGuide = async () => {
				const next = !showGuide;
				setShowGuide(next);
				if (next && guide === null) {
					try {
						const data = await post("/guide", {});
						setGuide(data.steps.join("\n"));
					} catch (error) {
						setGuide(t("guideFetchFail", { error: error.message }));
					}
				}
			};

			const busyLabel = busy === "scan" ? t("busyScan") : busy === "memories" ? t("busyMemories") : busy === "sessions" ? t("busySessions") : busy === "core" ? t("busyCore") : null;

			return react.createElement("li", { style: styles.li },
				react.createElement("article", { style: styles.article },
					react.createElement("button", {
						type: "button",
						"aria-label": `${open ? t("collapse") : t("expand")}: dsh-openclaw`,
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						style: styles.headerBtn
					},
						react.createElement("div", { style: { flex: 1, minWidth: 0 } },
							react.createElement("div", { style: { fontSize: 15, fontWeight: 600 } }, "dsh-openclaw"),
							react.createElement("div", { style: { fontSize: 13, color: "#8a94a3", marginTop: 2 } }, t("subtitle"))),
						react.createElement("span", {
							style: {
								color: "#8a94a3",
								fontSize: 12,
								transition: "transform .14s",
								transform: open ? "rotate(180deg)" : "none"
							}
						}, "▾")),
					open && react.createElement("div", { style: styles.body },
						react.createElement("div", { style: { fontWeight: 500, color: "#1c2024", margin: "4px 0 6px" } }, t("sourceDirLabel")),
						react.createElement("div", { style: styles.row },
							react.createElement("input", {
								style: styles.input,
								value: sourceDir,
								placeholder: t("sourceDirPlaceholder"),
								onChange: (e) => setSourceDir(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") void runScan(); }
							}),
							react.createElement("button", { style: styles.btn, onClick: runScan, disabled: busy !== null }, t("scan"))),
						status !== null && inventory !== null &&
							react.createElement("div", { style: { margin: "10px 0 2px", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, fontWeight: 500 } },
								react.createElement("span", { style: { color: status.core.imported ? "#1a7f37" : "#c0392b" } },
									t("statusCore", {
										state: status.core.imported ? t("statusCoreDone") : status.core.total > 0 ? t("statusCorePending") : t("statusCoreNone"),
										total: status.core.total
									})),
								react.createElement("span", { style: { color: status.memories.imported >= status.memories.total && status.memories.total > 0 ? "#1a7f37" : "#c0392b" } },
									t("statusMemories", { imported: status.memories.imported, total: status.memories.total })),
								react.createElement("span", { style: { color: status.sessions.total > 0 ? (status.sessions.imported >= status.sessions.total ? "#1a7f37" : "#c0392b") : status.sessions.imported > 0 ? "#1a7f37" : "#8a94a3" } },
									status.sessions.total > 0
										? t("statusSessions", { imported: status.sessions.imported, total: status.sessions.total })
										: t("statusSessionsNoSource", { imported: status.sessions.imported }))),
						react.createElement("div", { style: { fontSize: 12, color: "#8a94a3", margin: "2px 0 8px" } },
							t("stepsHint")),
						react.createElement("div", { style: styles.row },
							react.createElement("button", { style: styles.btnPrimary, onClick: runCore, disabled: busy !== null },
								`${t("importCore")}${status && status.core.imported ? " ✓" : ""}`),
							react.createElement("button", { style: styles.btnPrimary, onClick: runMemories, disabled: busy !== null },
								`${t("importMemories")}${status && status.memories.total > 0 && status.memories.imported >= status.memories.total ? " ✓" : ""}`),
							react.createElement("button", { style: styles.btnPrimary, onClick: runSessions, disabled: busy !== null },
								`${t("importSessions")}${status && status.sessions.total > 0 && status.sessions.imported >= status.sessions.total ? " ✓" : ""}`),
							react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12 } },
								react.createElement("input", {
									type: "checkbox",
									checked: asTranscript,
									onChange: (e) => setAsTranscript(e.target.checked)
								}),
								t("asTranscript"))),
						busy !== null &&
							react.createElement("p", { style: { ...styles.msg, color: "#1c2024" } }, busyLabel),
						result !== null &&
							react.createElement("p", { style: { ...styles.msg, ...(result.kind === "ok" ? styles.ok : styles.err) } }, result.text),
						inventory !== null &&
							react.createElement("div", { style: { marginTop: 8, fontSize: 12, color: "#8a94a3" } },
								t("sourceLine", {
									source: inventory.sourceDir,
									unsupported: inventory.sessions.unsupported.length > 0 ? t("sourceUnsupported", { names: inventory.sessions.unsupported.join(", ") }) : ""
								})),
						react.createElement("button", {
							type: "button",
							onClick: toggleGuide,
							style: { ...styles.btn, marginTop: 10, display: "block" }
						}, showGuide ? t("guideToggleClose") : t("guideToggle")),
						showGuide && guide !== null &&
							react.createElement("pre", { style: { fontSize: 12, background: "#f6f8fa", border: "1px solid #e4e8ee", borderRadius: 8, padding: 10, overflowX: "auto", whiteSpace: "pre-wrap" } }, guide))));
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === void 0) return;
			const locale = ctx.get("locale");
			if (locale !== void 0) {
				ctx.effect(() => locale.register(NS, { zh, en }), "dsh-openclaw: card dictionaries");
			}
			slots.inject("settings.plugin.item", () => slots.register(
				{ name: "settings.plugin.item", id: "dsh-openclaw", order: 40, label: "dsh-openclaw" },
				() => react.createElement(OpenClawCard, { ctx })
			));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
