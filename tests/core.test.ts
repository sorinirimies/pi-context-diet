import { describe, it, expect, beforeEach } from "bun:test";
import {
	ARG_TOOLS, COMPACT_COOLDOWN_TURNS, COMPACT_INSTRUCTIONS, Calibrator, DEFAULT_CHARS_PER_TOKEN, DEFAULT_CONFIG, RecoveryMeter, charsOfMessages, describeCandidates, describeElided, shouldCompact, shouldStopWarming, showLines, staleTokens, applyElision, argChars, assistantTurnsAfter, callSignature, decide, describeCall, elideArguments,
	eligible, eligibleArgs, estimateTokens, formatSize, formatTokens, indexCalls, isCold, lastAssistantTimestamp, measure, policyOf, previewOf,
	resolveAgentDir, restoreIds, restoreState, sanitizeConfig, stableStringify, statusLine, stubText, type DietConfig, type Message,
} from "../extensions/context-diet.ts";
import { big, convo, deepFreeze, isStub, resetIds, resultsOf, text, turn, user } from "./helpers.ts";
import { join } from "node:path";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
beforeEach(resetIds);

describe("measure", () => {
	it("sums text parts and counts lines", () => {
		expect(measure([{ type: "text", text: "a\nb\n" }, { type: "text", text: "c" }])).toEqual({ chars: 5, lines: 3, textOnly: true });
	});
	it("handles plain strings and empty content", () => {
		expect(measure("a\nb")).toEqual({ chars: 3, lines: 2, textOnly: true });
		expect(measure("")).toEqual({ chars: 0, lines: 0, textOnly: true });
		expect(measure(null)).toEqual({ chars: 0, lines: 0, textOnly: true });
		expect(measure(undefined)).toEqual({ chars: 0, lines: 0, textOnly: true });
	});
	it("flags anything that is not text (images are never elided)", () => {
		expect(measure([{ type: "text", text: "hi" }, { type: "image", data: "…", mimeType: "image/png" }]).textOnly).toBe(false);
		expect(measure([{ type: "text" }]).textOnly).toBe(false); // a text part without text is junk
		expect(measure([null]).textOnly).toBe(false);
	});
	it("counts a trailing newline as no extra line", () => {
		expect(measure("a\n").lines).toBe(1);
		expect(measure("a").lines).toBe(1);
	});
});

describe("indexCalls and describeCall", () => {
	it("maps tool call ids to the call that made them", () => {
		const m = turn({ tool: "read", args: { path: "src/a.ts" } });
		const calls = indexCalls(m);
		expect([...calls.values()]).toEqual([{ name: "read", args: { path: "src/a.ts" } }]);
	});
	it("ignores non-assistant messages and malformed parts", () => {
		const calls = indexCalls([
			{ role: "user", content: [{ type: "toolCall", id: "u", name: "x" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "no-id" }, { type: "toolCall", id: 5, name: "bad" }, { type: "text", text: "hi" }, null] },
			{ role: "assistant", content: "not an array" },
			{ role: "assistant", content: [{ type: "toolCall", id: "ok", name: "grep" }] },
		] as Message[]);
		expect([...calls.keys()]).toEqual(["ok"]);
		expect(calls.get("ok")).toEqual({ name: "grep", args: {} });
	});
	it("labels by command, path, pattern or query", () => {
		expect(describeCall("bash", { command: "cargo test --all" })).toBe("cargo test --all");
		expect(describeCall("read", { path: "src/a.ts", offset: 1 })).toBe("src/a.ts");
		expect(describeCall("grep", { pattern: "TODO" })).toBe("TODO");
		expect(describeCall("codegraph_search", { query: "applyCompletion" })).toBe("applyCompletion");
		expect(describeCall("fetch", { url: "https://x.dev" })).toBe("https://x.dev");
	});
	it("collapses whitespace, clips long labels, and copes with nothing useful", () => {
		expect(describeCall("bash", { command: "a   b\n  c" })).toBe("a b c");
		const long = describeCall("bash", { command: "x".repeat(200) });
		expect(long).toHaveLength(80);
		expect(long.endsWith("…")).toBe(true);
		expect(describeCall("bash", {})).toBe("");
		expect(describeCall("read", { path: "" })).toBe("");
		expect(describeCall("weird", { n: 5 })).toBe("");
	});
});

describe("formatting", () => {
	it("formatSize", () => {
		expect(formatSize(500)).toBe("500 B");
		expect(formatSize(1500)).toBe("1.5 KB");
		expect(formatSize(2_500_000)).toBe("2.5 MB");
	});
	it("formatTokens and estimateTokens", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(212_000)).toBe("212.0k");
		expect(formatTokens(5_100_000)).toBe("5.10M");
		expect(formatTokens(3_300_000_000)).toBe("3.30B");
		expect(estimateTokens(4000)).toBe(1333); // 3 chars per token until calibrated
		expect(estimateTokens(4000, 4)).toBe(1000);
		expect(DEFAULT_CHARS_PER_TOKEN).toBe(3);
	});
	it("stubText is deterministic and says what was elided", () => {
		const a = stubText("bash", "cargo test", 12_345, 240);
		expect(a).toBe(stubText("bash", "cargo test", 12_345, 240));
		expect(a).toContain("bash cargo test");
		expect(a).toContain("12.3 KB");
		expect(a).toContain("240 lines");
		expect(a).toContain("Re-run it");
		expect(stubText("grep", "", 1, 1)).toContain("output of grep (");
	});
});

describe("assistantTurnsAfter", () => {
	it("counts the assistant messages that follow each message", () => {
		const m: Message[] = [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }, { role: "assistant" }, { role: "toolResult" }];
		expect(assistantTurnsAfter(m)).toEqual([2, 1, 1, 0, 0]);
		expect(assistantTurnsAfter([])).toEqual([]);
	});
});

describe("eligible", () => {
	const policy = (over = {}) => policyOf({ ...DEFAULT_CONFIG, keepTurns: 5, minChars: 1000, ...over });

	it("elides results older than keepTurns, exactly at the boundary", () => {
		const m = convo(10, { endTs: NOW });
		const ids = eligible(m, policy(), new Set());
		// result k has (9 - k) assistant messages after it: eligible when > 5, i.e. k = 0..3
		expect(ids).toHaveLength(4);
		const all = resultsOf(m).map((r) => r.toolCallId as string);
		expect(ids).toEqual(all.slice(0, 4));
	});
	it("keeps everything in a short conversation", () => {
		expect(eligible(convo(5, { endTs: NOW }), policy(), new Set())).toEqual([]);
	});
	it("skips small results", () => {
		const m = [user(), ...turn({ chars: 999 }), ...turn({ chars: 1000 }), ...convo(8, { endTs: NOW }).slice(1)];
		const ids = eligible(m, policy(), new Set());
		const r = resultsOf(m);
		expect(ids).not.toContain(r[0].toolCallId as string);
		expect(ids).toContain(r[1].toolCallId as string);
	});
	it("keeps errors unless told otherwise", () => {
		const m = [user(), ...turn({ isError: true }), ...convo(8, { endTs: NOW }).slice(1)];
		const err = resultsOf(m)[0].toolCallId as string;
		expect(eligible(m, policy(), new Set())).not.toContain(err);
		expect(eligible(m, policy({ keepErrors: false }), new Set())).toContain(err);
	});
	it("honours neverElide and never touches images or other roles", () => {
		const img = [{ type: "text", text: big(5000) }, { type: "image", data: "…", mimeType: "image/png" }];
		const m = [user(), ...turn({ tool: "read" }), ...turn({ content: img }), ...convo(8, { endTs: NOW }).slice(1)];
		const [reads, withImage] = resultsOf(m);
		const ids = eligible(m, policy({ neverElide: ["read"] }), new Set());
		expect(ids).not.toContain(reads.toolCallId as string);
		expect(ids).not.toContain(withImage.toolCallId as string);
	});
	it("skips ids already elided and results without a call id", () => {
		const m = convo(10, { endTs: NOW });
		const first = resultsOf(m)[0].toolCallId as string;
		expect(eligible(m, policy(), new Set([first]))).not.toContain(first);
		const broken = [...m, { role: "toolResult", content: text(big(5000)) } as Message];
		expect(() => eligible(broken, policy(), new Set())).not.toThrow();
	});
	it("a tool result with no tool name is still judged by size and age", () => {
		const m = convo(10, { endTs: NOW });
		delete m.find((x) => x.role === "toolResult")!.toolName;
		expect(eligible(m, policy({ neverElide: ["bash"] }), new Set())).toHaveLength(1); // only the nameless one escapes the bash protection
	});
});

describe("cold detection", () => {
	it("finds the last assistant timestamp", () => {
		expect(lastAssistantTimestamp(convo(3, { endTs: NOW }))).toBe(NOW);
		expect(lastAssistantTimestamp([user()])).toBeUndefined();
		expect(lastAssistantTimestamp([{ role: "assistant" }])).toBeUndefined();
	});
	it("is cold only after the ttl, and never in a fresh session", () => {
		const m = convo(3, { endTs: NOW });
		expect(isCold(m, NOW + 4 * MIN, 5 * MIN)).toBe(false);
		expect(isCold(m, NOW + 5 * MIN, 5 * MIN)).toBe(false); // exactly at the ttl is still warm
		expect(isCold(m, NOW + 5 * MIN + 1, 5 * MIN)).toBe(true);
		expect(isCold([user()], NOW, 5 * MIN)).toBe(false);
	});
});

describe("decide", () => {
	const cfg = { ...DEFAULT_CONFIG, keepTurns: 5 };
	const long = convo(30, { endTs: NOW });

	it("does nothing while the cache is warm", () => {
		expect(decide(long, new Set(), cfg, { now: NOW + MIN, force: false })).toEqual({ ids: [], argIds: [], cold: false });
	});
	it("elides stale results when the cache is cold", () => {
		const d = decide(long, new Set(), cfg, { now: NOW + 10 * MIN, force: false });
		expect(d.cold).toBe(true);
		expect(d.ids.length).toBe(24); // 30 results, the newest 6 kept (> keepTurns after them)
	});
	it("can be forced, and `always` mode ignores the cache", () => {
		expect(decide(long, new Set(), cfg, { now: NOW + MIN, force: true }).ids.length).toBe(24);
		expect(decide(long, new Set(), { ...cfg, mode: "always" }, { now: NOW + MIN, force: false }).ids.length).toBe(24);
	});
	it("does nothing when disabled", () => {
		expect(decide(long, new Set(), { ...cfg, enabled: false }, { now: NOW + 10 * MIN, force: true })).toEqual({ ids: [], argIds: [], cold: false });
	});
	it("does not re-pick what is already elided", () => {
		const first = decide(long, new Set(), cfg, { now: NOW + 10 * MIN, force: false }).ids;
		expect(decide(long, new Set(first), cfg, { now: NOW + 10 * MIN, force: false }).ids).toEqual([]);
	});
});

describe("applyElision", () => {
	it("replaces chosen results with stubs and leaves everything else alone", () => {
		const m = deepFreeze(convo(10, { endTs: NOW }));
		const ids = new Set(eligible(m, policyOf({ ...DEFAULT_CONFIG, keepTurns: 5 }), new Set()));
		const r = applyElision(m, ids);
		expect(r.count).toBe(4);
		expect(r.savedChars).toBeGreaterThan(4 * 3000);
		const elidedOut = resultsOf(r.messages).filter(isStub);
		expect(elidedOut).toHaveLength(4);
		for (const e of elidedOut) {
			expect(e.role).toBe("toolResult");
			expect(e.toolName).toBe("bash");
			expect(e.isError).toBe(false);
			expect(typeof e.toolCallId).toBe("string");
		}
		// untouched messages are the very same objects
		r.messages.forEach((out, i) => { if (!isStub(out)) expect(out).toBe(m[i]); });
	});
	it("returns the same array when nothing applies", () => {
		const m = convo(3, { endTs: NOW });
		expect(applyElision(m, new Set()).messages).toBe(m);
		expect(applyElision(m, new Set(["no-such-id"])).messages).toBe(m);
	});
	it("is deterministic: the same set gives byte-identical output", () => {
		const m = convo(10, { endTs: NOW });
		const ids = new Set(eligible(m, policyOf({ ...DEFAULT_CONFIG, keepTurns: 5 }), new Set()));
		expect(JSON.stringify(applyElision(m, ids).messages)).toBe(JSON.stringify(applyElision(m, ids).messages));
	});
	it("names the call in the stub", () => {
		const m = [user(), ...turn({ tool: "read", args: { path: "src/big.ts" }, chars: 9000 })];
		const id = resultsOf(m)[0].toolCallId as string;
		const out = applyElision(m, new Set([id])).messages[2];
		expect(JSON.stringify(out.content)).toContain("read src/big.ts");
	});
	it("falls back to the result's own tool name when the call is gone (after compaction)", () => {
		const [, res] = turn({ tool: "grep", chars: 5000 });
		const out = applyElision([res], new Set([res.toolCallId as string])).messages[0];
		expect(JSON.stringify(out.content)).toContain("output of grep (");
		const nameless = { ...res }; delete nameless.toolName;
		expect(JSON.stringify(applyElision([nameless], new Set([res.toolCallId as string])).messages[0].content)).toContain("output of tool (");
	});
	it("never touches a result that is not plain text", () => {
		const img = [{ type: "text", text: big(5000) }, { type: "image", data: "…", mimeType: "image/png" }];
		const m = [user(), ...turn({ content: img })];
		const id = resultsOf(m)[0].toolCallId as string;
		expect(applyElision(m, new Set([id])).messages).toBe(m);
	});
	it("savedChars is never negative for results smaller than their stub", () => {
		const m = [user(), ...turn({ chars: 10 })];
		const id = resultsOf(m)[0].toolCallId as string;
		expect(applyElision(m, new Set([id])).savedChars).toBe(0);
	});
});

describe("restoreIds", () => {
	it("collects ids from this extension's custom entries", () => {
		const entries = [
			{ type: "custom", customType: "context-diet", data: { ids: ["a", "b"] } },
			{ type: "message" },
			{ type: "custom", customType: "other", data: { ids: ["x"] } },
			{ type: "custom", customType: "context-diet", data: { ids: ["b", "c", 7, null] } },
			{ type: "custom", customType: "context-diet", data: { ids: "nope" } },
			{ type: "custom", customType: "context-diet" },
			null,
			undefined,
		];
		expect([...restoreIds(entries)].sort()).toEqual(["a", "b", "c"]);
		expect(restoreIds([]).size).toBe(0);
	});
});

describe("sanitizeConfig", () => {
	it("defaults everything for junk input", () => {
		for (const junk of [undefined, null, 5, "x", [], true]) expect(sanitizeConfig(junk)).toEqual(DEFAULT_CONFIG);
	});
	it("keeps valid values", () => {
		const all: DietConfig = { enabled: false, mode: "always", keepTurns: 7, minChars: 800, cacheTtlMinutes: 60, keepErrors: false, neverElide: ["read"], showStatus: false, stubTailLines: 5, stubErrorLines: 2, elideArgs: false, autoProtect: false, recoveryThreshold: 0.5, warmArbitration: false, expectedTurns: 12, stopWarmingShare: 0.4, compact: true, compactAboveTokens: 90_000 };
		expect(sanitizeConfig(all)).toEqual(all);
	});
	it("clamps numbers and rejects the wrong types", () => {
		const c = sanitizeConfig({ keepTurns: 9999, minChars: 1, cacheTtlMinutes: 0, mode: "sometimes", enabled: "yes", keepErrors: 1 });
		expect(c.keepTurns).toBe(500);
		expect(c.minChars).toBe(200);
		expect(c.cacheTtlMinutes).toBe(1);
		expect(c.mode).toBe("cold");
		expect(c.enabled).toBe(true);
		expect(c.keepErrors).toBe(true);
		expect(sanitizeConfig({ keepTurns: "ten" }).keepTurns).toBe(20);
		expect(sanitizeConfig({ keepTurns: NaN }).keepTurns).toBe(20);
		expect(sanitizeConfig({ keepTurns: 7.6 }).keepTurns).toBe(8);
	});
	it("clamps the preview, args and recovery settings", () => {
		expect(sanitizeConfig({ stubTailLines: 99, stubErrorLines: -4 })).toMatchObject({ stubTailLines: 10, stubErrorLines: 0 });
		expect(sanitizeConfig({ stubTailLines: "x" }).stubTailLines).toBe(3);
		expect(sanitizeConfig({ recoveryThreshold: 5 }).recoveryThreshold).toBe(1);
		expect(sanitizeConfig({ recoveryThreshold: 0 }).recoveryThreshold).toBe(0.05);
		expect(sanitizeConfig({ recoveryThreshold: NaN }).recoveryThreshold).toBe(0.25);
		expect(sanitizeConfig({ recoveryThreshold: "high" }).recoveryThreshold).toBe(0.25);
		expect(sanitizeConfig({ elideArgs: "yes", autoProtect: 1 })).toMatchObject({ elideArgs: true, autoProtect: true });
	});
	it("cleans neverElide: strings only, trimmed, unique, at most 50", () => {
		expect(sanitizeConfig({ neverElide: [" read ", "read", "", 5, null, "bash"] }).neverElide).toEqual(["read", "bash"]);
		expect(sanitizeConfig({ neverElide: Array.from({ length: 80 }, (_, i) => `t${i}`) }).neverElide).toHaveLength(50);
		expect(sanitizeConfig({ neverElide: "read" }).neverElide).toEqual([]);
	});
});

describe("paths and status", () => {
	it("resolveAgentDir: PI_CODING_AGENT_DIR, then XDG, then ~/.pi/agent", () => {
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/a", XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/a");
		expect(resolveAgentDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe(join("/x", "pi", "agent"));
		expect(resolveAgentDir({}, "/h")).toBe(join("/h", ".pi", "agent"));
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "", XDG_CONFIG_HOME: "" }, "/h")).toBe(join("/h", ".pi", "agent"));
	});
	it("statusLine reports settings and savings", () => {
		const s = statusLine(DEFAULT_CONFIG, { requests: 24, cumulativeChars: 20_400_000, lastChars: 850_000, lastCount: 37, lastArgCount: 0, coldStarts: 3 });
		expect(s).toContain("on · mode cold · keep last 20 turns · cache ttl 5 min · min 1.5 KB · write/edit args elided");
		expect(s).toContain("37 results elided (~283.3k tokens kept out of every request)");
		expect(s).toContain("~6.80M tokens saved over 24 requests · 3 cold starts");
		const none = { requests: 0, cumulativeChars: 0, lastChars: 0, lastCount: 0, lastArgCount: 0, coldStarts: 1 };
		expect(statusLine({ ...DEFAULT_CONFIG, enabled: false }, none)).toContain("off ·");
		expect(statusLine({ ...DEFAULT_CONFIG, elideArgs: false }, none)).toContain("write/edit args kept");
		expect(statusLine(DEFAULT_CONFIG, none)).toContain("1 cold start");
		expect(statusLine(DEFAULT_CONFIG, { ...none, lastCount: 3, lastArgCount: 4 })).toContain("3 results + 4 write/edit arguments elided");
	});
});

describe("stub preview", () => {
	const log = ["Compiling a", "Compiling b", "error[E0432]: unresolved import `x`", "  --> src/lib.rs:1:5", "warning: unused", "BUILD FAILED in 4s", "exit code 1"].join("\n");

	it("keeps the last lines", () => {
		expect(previewOf(text(log), 2, 0)).toEqual({ tail: ["BUILD FAILED in 4s", "exit code 1"], errors: [] });
	});
	it("keeps error lines that are not already in the tail, in order, and only the last N", () => {
		const p = previewOf(text(log), 1, 5);
		expect(p.tail).toEqual(["exit code 1"]);
		expect(p.errors).toEqual(["error[E0432]: unresolved import `x`", "BUILD FAILED in 4s"]);
		expect(previewOf(text(log), 0, 1).errors).toEqual(["BUILD FAILED in 4s"]);
	});
	it("does nothing when both are 0, and copes with strings, junk and empty output", () => {
		expect(previewOf(text(log), 0, 0)).toEqual({ tail: [], errors: [] });
		expect(previewOf("a\nb\nc", 2, 0).tail).toEqual(["b", "c"]);
		expect(previewOf(null, 3, 3)).toEqual({ tail: [], errors: [] });
		expect(previewOf([{ type: "image" }, { type: "text" }], 3, 3)).toEqual({ tail: [], errors: [] });
		expect(previewOf("", 3, 3)).toEqual({ tail: [], errors: [] });
	});
	it("trims blank lines and clips very long lines", () => {
		const p = previewOf("\n\n  ok  \n\n" + "x".repeat(300) + "\n", 2, 0);
		expect(p.tail[0]).toBe("ok");
		expect(p.tail[1]).toHaveLength(160);
		expect(p.tail[1].endsWith("…")).toBe(true);
	});
	it("recognises errors, failures and exceptions (TypeError, AssertionError, ...)", () => {
		const out = previewOf("Error: boom\nTypeError: x is not a function\nTraceback (most recent call last)\nAssertionError\nUnhandledException\ntest failed\nall good", 0, 10).errors;
		expect(out).toEqual(["Error: boom", "TypeError: x is not a function", "Traceback (most recent call last)", "AssertionError", "UnhandledException", "test failed"]);
	});
	it("does not treat an all-clear summary as an error line", () => {
		expect(previewOf("12 passed, 0 failed\n0 errors\n0 failures found\nBuild ok", 0, 10).errors).toEqual([]);
		expect(previewOf("3 failed, 9 passed", 0, 10).errors).toEqual(["3 failed, 9 passed"]);
	});
	it("stubText shows the preview: errors first, then the tail", () => {
		const out = stubText("bash", "cargo test", 5000, 120, previewOf(text(log), 2, 2));
		expect(out.startsWith("[pi-context-diet: the output of bash cargo test (5.0 KB, 120 lines)")).toBe(true);
		expect(out).toContain("error lines:\n  error[E0432]");
		expect(out).toContain("last lines:\n  BUILD FAILED in 4s\n  exit code 1");
		expect(out.indexOf("error lines:")).toBeLessThan(out.indexOf("last lines:"));
		expect(out.endsWith("]")).toBe(true);
		expect(stubText("x", "", 1, 1, { tail: [], errors: [] })).toBe(stubText("x", "", 1, 1));
	});
	it("applyElision puts the preview into the stub, deterministically, and still saves most of the output", () => {
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\nerror: link failed\nexit 2";
		const m = [user(), ...turn({ content: text(body) })];
		const id = resultsOf(m)[0].toolCallId as string;
		const a = applyElision(m, new Set([id]), { preview: { tail: 2, errors: 2 } });
		const b = applyElision(m, new Set([id]), { preview: { tail: 2, errors: 2 } });
		expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
		const stub = JSON.stringify(a.messages[2].content);
		expect(stub).toContain("error: link failed");
		expect(stub).toContain("exit 2");
		expect(a.savedChars).toBeGreaterThan(body.length * 0.8);
	});
});

describe("write / edit arguments", () => {
	const writeArgs = (n: number) => ({ path: "src/a.ts", content: big(n) });
	const editArgs = (n: number) => ({ path: "src/a.ts", edits: [{ oldText: big(n / 2), newText: big(n / 2, "y") }, { oldText: "a", newText: "b" }] });

	it("argChars counts file content only", () => {
		expect(argChars("write", writeArgs(900))).toBe(900);
		expect(argChars("edit", editArgs(1000))).toBe(1000 + 2);
		expect(argChars("edit", { oldText: "abc", newText: "de" })).toBe(5); // the older single-edit shape
		expect(argChars("write", {})).toBe(0);
		expect(argChars("write", undefined)).toBe(0);
		expect(argChars("edit", { edits: [null, { oldText: 5 }] })).toBe(0);
		expect([...ARG_TOOLS].sort()).toEqual(["edit", "write"]);
	});

	it("elideArguments replaces content with a short placeholder and keeps the structure", () => {
		const w = elideArguments("write", writeArgs(5000));
		expect(w.path).toBe("src/a.ts");
		expect(String(w.content)).toContain("pi-context-diet");
		expect(String(w.content)).toContain("src/a.ts");
		expect(String(w.content).length).toBeLessThan(200);
		const e = elideArguments("edit", editArgs(4000)) as any;
		expect(e.edits).toHaveLength(2);
		expect(e.edits[0].oldText).toContain("pi-context-diet");
		expect(e.edits[0].newText).toContain("pi-context-diet");
		expect(elideArguments("edit", { path: "f", oldText: "abc", newText: "def" })).toMatchObject({ path: "f" });
		expect(elideArguments("write", { path: "p" })).toEqual({ path: "p" }); // nothing to elide: same shape
		expect(elideArguments("edit", { edits: [null, "x", { oldText: 5 }] })).toEqual({ edits: [null, "x", { oldText: 5 }] });
		expect(elideArguments("write", { file_path: "z.ts", content: "a\nb" })).toMatchObject({ file_path: "z.ts" });
		expect(String(elideArguments("write", { content: "x" }).content)).toContain("the file");
	});

	const policy = (over = {}) => policyOf({ ...DEFAULT_CONFIG, keepTurns: 5, minChars: 1000, ...over });
	const session = () => {
		const m: Message[] = [user()];
		m.push(...turn({ tool: "write", args: writeArgs(5000), chars: 50 }));
		m.push(...turn({ tool: "edit", args: editArgs(3000), chars: 50 }));
		m.push(...turn({ tool: "write", args: writeArgs(300), chars: 50 })); // too small
		m.push(...turn({ tool: "write", args: writeArgs(5000), chars: 50, isError: true })); // failed: may be retried
		m.push(...convo(8, { endTs: NOW }).slice(1));
		return m;
	};
	const callIds = (m: Message[]) => m.filter((x) => x.role === "assistant").flatMap((x) => (x.content as any[]).filter((p) => p.type === "toolCall").map((p) => p.id as string));

	it("eligibleArgs: old, big, successful write/edit calls only", () => {
		const m = session();
		const [w, e] = callIds(m);
		expect(eligibleArgs(m, policy(), new Set())).toEqual([w, e]);
	});
	it("eligibleArgs: skips assistant messages with thinking blocks (signed, must stay byte-identical)", () => {
		for (const type of ["thinking", "redacted_thinking"]) {
			const m = session();
			const [w, e] = callIds(m);
			const first = m.find((x) => x.role === "assistant") as Message;
			(first.content as any[]).unshift({ type, thinking: "hmm", thinkingSignature: "sig" });
			expect(eligibleArgs(m, policy(), new Set())).toEqual([e]);
			expect(w).toBeDefined();
		}
	});
	it("applyElision never rewrites an assistant message that has thinking blocks", () => {
		const m = session();
		const [w] = callIds(m);
		const first = m.find((x) => x.role === "assistant") as Message;
		(first.content as any[]).unshift({ type: "thinking", thinking: "hmm", thinkingSignature: "sig" });
		const [, e] = callIds(m);
		const r = applyElision(deepFreeze(m), new Set(), { argIds: new Set([w, e]) });
		expect(r.argCount).toBe(1); // only the edit call (no thinking) was elided
		expect(r.messages.filter((x) => x.role === "assistant" && JSON.stringify(x.content).includes("pi-context-diet:"))).toHaveLength(1);
		expect(r.messages[m.indexOf(first)]).toBe(first);
	});
	it("eligibleArgs: skips young calls, protected tools and already-elided ones", () => {
		const m = session();
		const [w, e] = callIds(m);
		expect(eligibleArgs(m.slice(0, 7), policy(), new Set())).toEqual([]); // nothing is old enough yet
		expect(eligibleArgs(m, policy({ neverElide: ["write"] }), new Set())).toEqual([e]);
		expect(eligibleArgs(m, policy(), new Set([w]))).toEqual([e]);
	});
	it("eligibleArgs: ignores other tools, unanswered calls and junk parts", () => {
		const m: Message[] = [
			user(),
			{ role: "assistant", content: [{ type: "toolCall", id: "bashy", name: "bash", arguments: { command: big(5000) } }, { type: "toolCall", id: "noanswer", name: "write", arguments: writeArgs(5000) }, { type: "toolCall", name: "write" }, null, { type: "text", text: "hi" }] },
			{ role: "toolResult", toolCallId: "bashy", content: text("ok") },
			{ role: "toolResult", content: text("no id") },
			...convo(8, { endTs: NOW }).slice(1),
		] as Message[];
		expect(eligibleArgs(m, policy(), new Set())).toEqual([]);
	});

	it("applyElision elides the chosen arguments, counts them, and never mutates the originals", () => {
		const m = deepFreeze(session());
		const [w, e] = callIds(m);
		const r = applyElision(m, new Set(), { argIds: new Set([w, e]) });
		expect(r.argCount).toBe(2);
		expect(r.count).toBe(0);
		expect(r.savedChars).toBeGreaterThan(7000);
		const out = r.messages.filter((x) => x.role === "assistant").flatMap((x) => x.content as any[]).filter((p) => p.type === "toolCall");
		expect(JSON.stringify(out[0].arguments)).toContain("pi-context-diet");
		expect(out[0].id).toBe(w);
		expect(out[2].arguments).toEqual(m.filter((x) => x.role === "assistant")[2].content![0 as never] && (m.filter((x) => x.role === "assistant")[2].content as any[])[0].arguments); // the small one is untouched
		expect(JSON.stringify(applyElision(m, new Set(), { argIds: new Set([w, e]) }).messages)).toBe(JSON.stringify(r.messages)); // deterministic
	});
	it("applyElision returns the same array when no argument actually changes", () => {
		const m = [user(), ...turn({ tool: "write", args: { path: "p" }, chars: 10 })];
		const id = callIds(m)[0];
		expect(applyElision(m, new Set(), { argIds: new Set([id]) }).messages).toBe(m);
		expect(applyElision(m, new Set(), { argIds: new Set(["unknown"]) }).messages).toBe(m);
	});
	it("applyElision handles assistant messages without parts and non-object arguments", () => {
		const m: Message[] = [{ role: "assistant", content: "plain" }, { role: "assistant", content: [{ type: "toolCall", id: "x", name: "write" }] }];
		expect(applyElision(m, new Set(), { argIds: new Set(["x"]) }).messages).toBe(m);
	});
	it("decide picks up arguments at a cold start, and only when elideArgs is on", () => {
		const m = session();
		const cfg = { ...DEFAULT_CONFIG, keepTurns: 5, minChars: 1000 };
		expect(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }).argIds).toHaveLength(2);
		expect(decide(m, new Set(), { ...cfg, elideArgs: false }, { now: NOW + 10 * MIN, force: false }).argIds).toEqual([]);
		expect(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }, { protectedTools: ["write"] }).argIds).toHaveLength(1);
		const done = new Set(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }).argIds);
		expect(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }, { elidedArgs: done }).argIds).toEqual([]);
	});
});

describe("call signatures", () => {
	it("stableStringify sorts keys and handles every JSON type", () => {
		expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
		expect(stableStringify("x")).toBe('"x"');
		expect(stableStringify(undefined)).toBe("null");
		expect(stableStringify([])).toBe("[]");
	});
	it("callSignature is the same for the same call whatever the key order", () => {
		expect(callSignature("read", { path: "a", limit: 5 })).toBe(callSignature("read", { limit: 5, path: "a" }));
		expect(callSignature("read", { path: "a" })).not.toBe(callSignature("read", { path: "b" }));
		expect(callSignature("read", { path: "a" })).not.toBe(callSignature("bash", { path: "a" }));
		expect(callSignature("x", undefined)).toBe("x:{}");
	});
});

describe("RecoveryMeter", () => {
	const info = (id: string, tool = "bash", cmd = id, chars = 4000) => ({ id, tool, sig: callSignature(tool, { command: cmd }), chars });

	it("counts a re-fetch once, with its cost, and attributes it to the tool", () => {
		const m = new RecoveryMeter();
		m.track([info("a"), info("b", "read")]);
		expect(m.elided()).toBe(2);
		const hit = m.onCall("bash", { command: "a" });
		expect(hit?.id).toBe("a");
		expect(m.recovered).toBe(1);
		expect(m.recoveredChars).toBe(4000);
		expect(m.perTool.get("bash")).toEqual({ elided: 1, recovered: 1 });
		expect(m.perTool.get("read")).toEqual({ elided: 1, recovered: 0 });
		expect(m.onCall("bash", { command: "a" })).toBeUndefined(); // already counted
	});
	it("ignores calls that match nothing that was elided", () => {
		const m = new RecoveryMeter();
		m.track([info("a")]);
		expect(m.onCall("bash", { command: "other" })).toBeUndefined();
		expect(m.onCall("read", { command: "a" })).toBeUndefined();
		expect(m.recovered).toBe(0);
	});
	it("track is idempotent", () => {
		const m = new RecoveryMeter();
		m.track([info("a")]);
		m.track([info("a")]);
		expect(m.elided()).toBe(1);
		expect(m.perTool.get("bash")!.elided).toBe(1);
	});
	it("one re-fetch answers every elided copy of the same output", () => {
		const m = new RecoveryMeter();
		m.track([info("a1", "bash", "ls"), info("a2", "bash", "ls")]);
		expect(m.onCall("bash", { command: "ls" })).toBeDefined();
		expect(m.recovered).toBe(1);
		expect(m.onCall("bash", { command: "ls" })).toBeUndefined();
	});
	it("shouldProtect needs enough samples and a high enough share", () => {
		const m = new RecoveryMeter();
		m.track(Array.from({ length: 8 }, (_, i) => info(`i${i}`, "bash", `c${i}`)));
		expect(m.shouldProtect("bash", 0.25)).toBe(false); // nothing re-fetched
		for (const c of ["c0", "c1"]) m.onCall("bash", { command: c });
		expect(m.shouldProtect("bash", 0.25)).toBe(false); // 2/8 = 25%: not above the threshold
		m.onCall("bash", { command: "c2" });
		expect(m.shouldProtect("bash", 0.25)).toBe(true); // 3/8
		expect(m.shouldProtect("bash", 0.5)).toBe(false);
		expect(m.shouldProtect("bash", 0.1, 20)).toBe(false); // too few samples
		expect(m.shouldProtect("read", 0.1)).toBe(false); // unknown tool
	});
});

describe("restoreState", () => {
	it("rebuilds results, arguments and protected tools from custom entries", () => {
		const s = restoreState([
			{ type: "custom", customType: "context-diet", data: { ids: ["r1", "r2", 5], argIds: ["a1", null] } },
			{ type: "custom", customType: "context-diet", data: { ids: ["r3"] } },
			{ type: "custom", customType: "context-diet-protect", data: { tool: "bash" } },
			{ type: "custom", customType: "context-diet-protect", data: { tool: 7 } },
			{ type: "custom", customType: "context-diet", data: { ids: "no", argIds: "no" } },
			{ type: "message" },
			null,
		]);
		expect([...s.ids].sort()).toEqual(["r1", "r2", "r3"]);
		expect([...s.argIds]).toEqual(["a1"]);
		expect([...s.protectedTools]).toEqual(["bash"]);
	});
	it("statusLine includes the recovery summary", () => {
		const base = { requests: 4, cumulativeChars: 400_000, lastChars: 100_000, lastCount: 5, lastArgCount: 0, coldStarts: 1 };
		const line = statusLine(DEFAULT_CONFIG, base, { recovered: 2, elided: 40, recoveredChars: 36_000, protectedTools: ["bash", "read"] });
		expect(line).toContain("recovery: 2 of 40 elided results re-fetched (5%, ~12.0k tokens to re-fetch, once)");
		expect(line).toContain("protected: bash, read");
		expect(statusLine(DEFAULT_CONFIG, base, { recovered: 0, elided: 0, recoveredChars: 0, protectedTools: [] })).toContain("0 of 0 elided results re-fetched (0%");
	});
});

describe("config: warming and compaction settings", () => {
	it("clamps them and falls back to defaults", () => {
		expect(sanitizeConfig({ expectedTurns: 9999, stopWarmingShare: 5, compactAboveTokens: 1 })).toMatchObject({ expectedTurns: 500, stopWarmingShare: 0.9, compactAboveTokens: 20_000 });
		expect(sanitizeConfig({ expectedTurns: 0, stopWarmingShare: 0, compactAboveTokens: 9e9 })).toMatchObject({ expectedTurns: 1, stopWarmingShare: 0.05, compactAboveTokens: 2_000_000 });
		expect(sanitizeConfig({ stopWarmingShare: NaN, expectedTurns: "x", compact: "yes", warmArbitration: 1 })).toMatchObject({ stopWarmingShare: 0.2, expectedTurns: 30, compact: false, warmArbitration: true });
		expect(DEFAULT_CONFIG).toMatchObject({ warmArbitration: true, compact: false, compactAboveTokens: 150_000 });
	});
});

describe("charsOfMessages and Calibrator", () => {
	it("counts the characters of message content", () => {
		expect(charsOfMessages([{ role: "user", content: "abcd" }, { role: "user", content: [{ type: "text", text: "xy" }] }, { role: "x" }, { role: "y", content: null }])).toBe(4 + JSON.stringify([{ type: "text", text: "xy" }]).length);
		expect(charsOfMessages([])).toBe(0);
	});
	it("uses the default until it has 6 samples", () => {
		const c = new Calibrator();
		for (let i = 1; i <= 5; i++) c.add(i * 1000, 20_000 + i * 400);
		expect(c.samples()).toBe(5);
		expect(c.charsPerToken()).toBe(DEFAULT_CHARS_PER_TOKEN);
	});
	it("recovers the real ratio, ignoring the fixed system prompt (the intercept), and says it measured it", () => {
		const c = new Calibrator();
		expect(c.isMeasured()).toBe(false);
		for (let i = 1; i <= 12; i++) c.add(i * 10_000, 20_000 + (i * 10_000) / 2.5);
		expect(c.charsPerToken()).toBeCloseTo(2.5, 5);
		expect(c.isMeasured()).toBe(true);
	});
	it("clamps to 1.5..8 and ignores junk", () => {
		const lo = new Calibrator();
		for (let i = 1; i <= 8; i++) lo.add(i * 1000, i * 1000 * 5);
		expect(lo.charsPerToken()).toBe(1.5);
		const hi = new Calibrator();
		for (let i = 1; i <= 8; i++) hi.add(i * 100_000, 20_000 + i * 1000);
		expect(hi.charsPerToken()).toBe(8);
		const c = new Calibrator();
		c.add(0, 100);
		c.add(100, 0);
		c.add(-5, 5);
		expect(c.samples()).toBe(0);
	});
	it("falls back when there is no variation or no positive slope", () => {
		const flat = new Calibrator();
		for (let i = 0; i < 8; i++) flat.add(5000, 25_000 + i);
		expect(flat.charsPerToken()).toBe(DEFAULT_CHARS_PER_TOKEN);
		expect(flat.isMeasured()).toBe(false);
		const down = new Calibrator();
		for (let i = 1; i <= 8; i++) down.add(i * 1000, 50_000 - i * 1000);
		expect(down.charsPerToken()).toBe(DEFAULT_CHARS_PER_TOKEN);
		const constant = new Calibrator(); // tokens never change with size (a provider that reports a fixed number)
		for (let i = 1; i <= 8; i++) constant.add(i * 1000, 5200);
		expect(constant.isMeasured()).toBe(false);
	});
	it("keeps a rolling window of the latest 200 samples", () => {
		const c = new Calibrator();
		for (let i = 1; i <= 250; i++) c.add(i * 100, i * 40);
		expect(c.samples()).toBe(200);
	});
});

describe("show", () => {
	const policy = policyOf({ ...DEFAULT_CONFIG, keepTurns: 5, minChars: 1000 });
	const session = (): Message[] => [
		user(),
		...turn({ tool: "read", args: { path: "src/big.ts" }, chars: 9000 }),
		...turn({ tool: "bash", args: { command: "cargo test" }, chars: 3000 }),
		...turn({ tool: "write", args: { path: "a.ts", content: big(4000) }, chars: 50 }),
		...convo(6, { endTs: NOW }).slice(1),
	];
	const ids = (m: Message[]) => resultsOf(m).map((r) => r.toolCallId as string);

	it("describeElided lists results and write/edit arguments, biggest first, measured from the originals", () => {
		const m = session();
		const calls = m.filter((x) => x.role === "assistant").flatMap((x) => (x.content as any[]).filter((p) => p.type === "toolCall"));
		const shown = describeElided(m, new Set(ids(m).slice(0, 2)), new Set([calls[2].id]));
		expect(shown.map((x) => `${x.kind}:${x.tool}`)).toEqual(["result:read", "args:write", "result:bash"]);
		expect(shown[0]).toMatchObject({ label: "src/big.ts", chars: 9000 });
		expect(shown[2].label).toBe("cargo test");
	});
	it("describeElided copes with results whose call is gone", () => {
		const [, res] = turn({ tool: "grep", chars: 2000 });
		expect(describeElided([res], new Set([res.toolCallId as string]), new Set())).toEqual([{ kind: "result", tool: "grep", label: "", chars: 2000 }]);
		const nameless = { ...res }; delete nameless.toolName;
		expect(describeElided([nameless], new Set([res.toolCallId as string]), new Set())[0].tool).toBe("tool");
		expect(describeElided([null as any, { role: "assistant", content: [{ type: "toolCall", id: 5 }, null, { type: "text" }] }], new Set(), new Set())).toEqual([]);
	});
	it("describeCandidates lists what the next cold start would take", () => {
		const m = session();
		const next = describeCandidates(m, policy, new Set(), new Set(), true);
		expect(next.map((x) => `${x.kind}:${x.tool}`).sort()).toEqual(["args:write", "result:bash", "result:read"]);
		expect(describeCandidates(m, policy, new Set(ids(m)), new Set(), false)).toEqual([]);
	});
	it("showLines formats a titled, limited list with a token estimate", () => {
		const items = Array.from({ length: 4 }, (_, i) => ({ kind: (i === 0 ? "args" : "result") as "args" | "result", tool: "bash", label: `cmd ${i}`, chars: 3000 }));
		const lines = showLines("elided now", items, 2, 3);
		expect(lines[0]).toBe("elided now: 4 (~4.0k tokens)");
		expect(lines[1]).toBe("  args bash cmd 0  3.0 KB");
		expect(lines[2]).toBe("  bash cmd 1  3.0 KB");
		expect(lines[3]).toBe("  … and 2 more");
		expect(showLines("x", [], 5, 3)).toEqual(["x: none"]);
		expect(showLines("y", [{ kind: "result", tool: "read", label: "", chars: 100 }], 5, 3)[1]).toBe("  read  100 B");
	});
	it("staleTokens estimates the tokens a cold start would drop", () => {
		const m = session();
		const t = staleTokens(m, policy, new Set(), new Set(), true, 3);
		expect(t).toBe(Math.round((9000 + 3000 + 4000) / 3));
		expect(staleTokens(m, policy, new Set(), new Set(), false, 3)).toBe(Math.round((9000 + 3000) / 3));
		expect(staleTokens(m, policy, new Set(ids(m)), new Set(), true, 3)).toBe(Math.round(4000 / 3));
	});
});

describe("shouldStopWarming", () => {
	const base = { action: "warm" as const, warmCost: 0.1, missCost: 1.2, continuationProbability: 0.8, staleTokens: 100_000, contextTokens: 300_000, prices: { cacheRead: 0.3, cacheWrite: 3.75 }, expectedTurns: 30, shareFallback: 0.2 };

	it("stops warming when dropping the stale output is worth more than the avoided rewrite", () => {
		// 0.1 + 0.8 * 100k * (0.3e-6*30 + 3.75e-6) = 0.1 + 0.8*1.275 = 1.12  >  0.8 * 1.2 = 0.96
		expect(shouldStopWarming(base)).toBe(true);
	});
	it("keeps warming when little is stale", () => {
		expect(shouldStopWarming({ ...base, staleTokens: 10_000 })).toBe(false);
		expect(shouldStopWarming({ ...base, staleTokens: 0 })).toBe(false);
	});
	it("a sure return makes warming worth more; a likely no-show makes stopping free", () => {
		expect(shouldStopWarming({ ...base, staleTokens: 60_000, continuationProbability: 1 })).toBe(false);
		expect(shouldStopWarming({ ...base, staleTokens: 60_000, continuationProbability: 0.05 })).toBe(true);
		expect(shouldStopWarming({ ...base, staleTokens: 1, continuationProbability: 0 })).toBe(true); // nothing to lose, the refresh is saved
		expect(shouldStopWarming({ ...base, continuationProbability: 7 })).toBe(shouldStopWarming({ ...base, continuationProbability: 1 }));
	});
	it("more expected turns make eliding worth more", () => {
		const mid = { ...base, staleTokens: 60_000, continuationProbability: 1 };
		expect(shouldStopWarming({ ...mid, expectedTurns: 5 })).toBe(false);
		expect(shouldStopWarming({ ...mid, expectedTurns: 500 })).toBe(true);
	});
	it("never turns pi's stop into a warm", () => {
		expect(shouldStopWarming({ ...base, action: "stop" })).toBe(false);
	});
	it("without prices or sane numbers it falls back to the stale share of the context", () => {
		const noPrices = { ...base, prices: undefined };
		expect(shouldStopWarming({ ...noPrices, staleTokens: 60_000 })).toBe(true); // 20%
		expect(shouldStopWarming({ ...noPrices, staleTokens: 59_000 })).toBe(false);
		expect(shouldStopWarming({ ...noPrices, contextTokens: null })).toBe(false);
		expect(shouldStopWarming({ ...base, missCost: 0, staleTokens: 70_000 })).toBe(true);
		expect(shouldStopWarming({ ...base, warmCost: NaN, staleTokens: 10_000 })).toBe(false);
		expect(shouldStopWarming({ ...base, prices: { cacheRead: 0, cacheWrite: 3.75 }, staleTokens: 10_000 })).toBe(false);
		expect(shouldStopWarming({ ...base, continuationProbability: NaN, staleTokens: 70_000 })).toBe(true);
	});
});

describe("shouldCompact", () => {
	const ok = { enabled: true, compact: true, tokens: 200_000, threshold: 150_000, turnsSinceCompaction: COMPACT_COOLDOWN_TURNS, idle: true, pending: false, inFlight: false };
	it("compacts an idle, big session when the feature is on", () => {
		expect(shouldCompact(ok)).toBe(true);
		expect(shouldCompact({ ...ok, tokens: 150_000 })).toBe(true);
	});
	it("never when off, disabled, small, unknown, busy, queued, already running, or just compacted", () => {
		for (const bad of [{ compact: false }, { enabled: false }, { tokens: 149_999 }, { tokens: null }, { idle: false }, { pending: true }, { inFlight: true }, { turnsSinceCompaction: COMPACT_COOLDOWN_TURNS - 1 }]) {
			expect(shouldCompact({ ...ok, ...bad }), JSON.stringify(bad)).toBe(false);
		}
	});
	it("asks pi's summariser to keep what the work needs", () => {
		expect(COMPACT_INSTRUCTIONS).toContain("file paths");
		expect(COMPACT_INSTRUCTIONS).toContain("open tasks");
		expect(COMPACT_INSTRUCTIONS).toContain("Drop: raw tool output");
	});
});
