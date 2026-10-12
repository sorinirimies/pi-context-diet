import { describe, it, expect, beforeEach } from "bun:test";
import {
	DEFAULT_CONFIG, applyElision, assistantTurnsAfter, decide, describeCall, eligible, estimateTokens, formatSize, formatTokens,
	indexCalls, isCold, lastAssistantTimestamp, measure, policyOf, resolveAgentDir, restoreIds, sanitizeConfig, stubText, statusLine,
	type Message,
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
		expect(estimateTokens(4000)).toBe(1000);
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
		expect(decide(long, new Set(), cfg, { now: NOW + MIN, force: false })).toEqual({ ids: [], cold: false });
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
		expect(decide(long, new Set(), { ...cfg, enabled: false }, { now: NOW + 10 * MIN, force: true })).toEqual({ ids: [], cold: false });
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
		const c = sanitizeConfig({ enabled: false, mode: "always", keepTurns: 7, minChars: 800, cacheTtlMinutes: 60, keepErrors: false, neverElide: ["read"], showStatus: false });
		expect(c).toEqual({ enabled: false, mode: "always", keepTurns: 7, minChars: 800, cacheTtlMinutes: 60, keepErrors: false, neverElide: ["read"], showStatus: false });
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
		const s = statusLine(DEFAULT_CONFIG, { requests: 24, cumulativeChars: 20_400_000, lastChars: 850_000, lastCount: 37, coldStarts: 3 });
		expect(s).toContain("on · mode cold · keep last 20 turns · cache ttl 5 min · min 1.5 KB");
		expect(s).toContain("37 results elided (~212.5k tokens kept out of every request)");
		expect(s).toContain("~5.10M tokens saved over 24 requests · 3 cold starts");
		expect(statusLine({ ...DEFAULT_CONFIG, enabled: false }, { requests: 0, cumulativeChars: 0, lastChars: 0, lastCount: 0, coldStarts: 1 })).toContain("off ·");
		expect(statusLine(DEFAULT_CONFIG, { requests: 0, cumulativeChars: 0, lastChars: 0, lastCount: 0, coldStarts: 1 })).toContain("1 cold start");
	});
});
