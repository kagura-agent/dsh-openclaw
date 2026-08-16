// dsh-openclaw client half — migration card in the settings plugin list.
//
// A single card with: source-directory input (default ~/.openclaw), 扫描 /
// 导入记忆 / 导入会话 actions, a per-run result summary, and a collapsible
// cross-machine export guide. All work happens through the host half's
// /api/dsh-openclaw/* routes; a dsh-web-auth deployment gates those routes
// behind the password cookie like every other /api route.
window.__ModuleLoader__.load({
	id: "dsh-openclaw",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-openclaw-client";
		const inject = ["slots", "sessions"];

		const API = "/api/dsh-openclaw";
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
			const [result, setResult] = react.useState(null); // { kind, ok, text }
			const [showGuide, setShowGuide] = react.useState(false);
			const [guide, setGuide] = react.useState(null);
			const [asTranscript, setAsTranscript] = react.useState(true);

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
					throw new Error((data && data.error) || `HTTP ${res.status}`);
				}
				return data;
			};

			const runScan = async () => {
				setBusy("scan");
				setResult(null);
				try {
					const data = await post("/scan", { sourceDir });
					setInventory(data);
					setResult({
						kind: "ok",
						text:
							`记忆 ${data.memories.count} 个（${data.memories.sizeLabel}）` +
							` · 会话 ${data.sessions.count} 个（${data.sessions.sizeLabel}）` +
							(data.core.count > 0 ? ` · 人格核心 ${data.core.count} 个（${data.core.files.map((f) => f.name.replace(/\.md$/i, "")).join("/")}）` : "") +
							(data.config ? ` · 配置 ${data.config.name}` : "") +
							(data.plugins.count > 0 ? ` · 插件 ${data.plugins.count} 个（仅清单）` : "")
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
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
							`导入记忆 ${data.imported} 条 → ${data.cwd || ""}/${data.targetDir}/（索引${data.indexWrote ? "已生成" : "生成失败"}）` +
							(data.skipped > 0 ? `，跳过 ${data.skipped} 条` : "") +
							(data.failed.length > 0 ? `\n失败 ${data.failed.length} 条：\n${failures}` : "")
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
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
							`导入会话 ${data.imported.length} 个` +
							(data.skipped.length > 0 ? `，跳过 ${data.skipped.length} 个（已导入过）` : "") +
							(data.failed.length > 0 ? `，失败 ${data.failed.length} 个` : "") +
							(data.imported.length > 0 ? `\n${first}${data.imported.length > 5 ? "\n…" : ""}` : "") +
							(data.skipped.length > 0 ? `\n已跳过：${data.skipped.map((s) => s.name).join(", ")}` : "") +
							(data.failed.length > 0 ? `\n失败详情：\n${failures}` : "") +
							`\n${data.note || ""}`
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
			};

			const runCore = async () => {
				setBusy("core");
				setResult(null);
				try {
					const data = await post("/import-core", { sourceDir });
					setResult({
						kind: "ok",
						text:
							`导入人格核心 ${data.files.length} 个 → ${data.target}` +
							`（${data.bytes} 字节${data.backedUp ? "，旧文件已备份" : ""}）` +
							`\n${data.note || ""}`
					});
				} catch (error) {
					setResult({ kind: "err", text: error.message });
				}
				setBusy(null);
			};

			const toggleGuide = async () => {
				const next = !showGuide;
				setShowGuide(next);
				if (next && guide === null) {
					try {
						const data = await post("/guide", {});
						setGuide(data.steps.join("\n"));
					} catch (error) {
						setGuide(`获取失败：${error.message}`);
					}
				}
			};

			const busyLabel = busy === "scan" ? "扫描中…" : busy === "memories" ? "导入记忆中…" : busy === "sessions" ? "导入会话中…" : busy === "core" ? "导入人格中…" : null;

			return react.createElement("li", { style: styles.li },
				react.createElement("article", { style: styles.article },
					react.createElement("button", {
						type: "button",
						"aria-label": `${open ? "收起" : "展开"}: dsh-openclaw`,
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						style: styles.headerBtn
					},
						react.createElement("div", { style: { flex: 1, minWidth: 0 } },
							react.createElement("div", { style: { fontSize: 15, fontWeight: 600 } }, "dsh-openclaw"),
							react.createElement("div", { style: { fontSize: 13, color: "#8a94a3", marginTop: 2 } }, "OpenClaw → DSH 迁移：记忆 + 会话导入")),
						react.createElement("span", {
							style: {
								color: "#8a94a3",
								fontSize: 12,
								transition: "transform .14s",
								transform: open ? "rotate(180deg)" : "none"
							}
						}, "▾")),
					open && react.createElement("div", { style: styles.body },
						react.createElement("div", { style: { fontWeight: 500, color: "#1c2024", margin: "4px 0 6px" } }, "OpenClaw 数据目录"),
						react.createElement("div", { style: styles.row },
							react.createElement("input", {
								style: styles.input,
								value: sourceDir,
								placeholder: "~/.openclaw 或导出目录路径",
								onChange: (e) => setSourceDir(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") void runScan(); }
							}),
							react.createElement("button", { style: styles.btn, onClick: runScan, disabled: busy !== null }, "扫描")),
						react.createElement("div", { style: styles.row },
							react.createElement("button", { style: styles.btnPrimary, onClick: runCore, disabled: busy !== null }, "导入人格 → ~/.dsh/AGENTS.md"),
							react.createElement("button", { style: styles.btnPrimary, onClick: runMemories, disabled: busy !== null }, "导入记忆"),
							react.createElement("button", { style: styles.btnPrimary, onClick: runSessions, disabled: busy !== null }, "导入会话"),
							react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12 } },
								react.createElement("input", {
									type: "checkbox",
									checked: asTranscript,
									onChange: (e) => setAsTranscript(e.target.checked)
								}),
								"同时生成 Markdown 存档")),
						busy !== null &&
							react.createElement("p", { style: { ...styles.msg, color: "#1c2024" } }, busyLabel),
						result !== null &&
							react.createElement("p", { style: { ...styles.msg, ...(result.kind === "ok" ? styles.ok : styles.err) } }, result.text),
						inventory !== null &&
							react.createElement("div", { style: { marginTop: 8, fontSize: 12, color: "#8a94a3" } },
								`源：${inventory.sourceDir}` +
								(inventory.sessions.unsupported.length > 0 ? `；不支持：${inventory.sessions.unsupported.join(", ")}` : "")),
						react.createElement("button", {
							type: "button",
							onClick: toggleGuide,
							style: { ...styles.btn, marginTop: 10, display: "block" }
						}, showGuide ? "收起导出指引" : "跨机器迁移：导出指引"),
						showGuide && guide !== null &&
							react.createElement("pre", { style: { fontSize: 12, background: "#f6f8fa", border: "1px solid #e4e8ee", borderRadius: 8, padding: 10, overflowX: "auto", whiteSpace: "pre-wrap" } }, guide))));
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === void 0) return;
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
