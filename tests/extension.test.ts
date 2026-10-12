import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextDiet, { COMPACT_COOLDOWN_TURNS, charsOfMessages, timing, type Message } from "../extensions/context-diet.ts";
import { big, convo, isStub, resetIds, resultsOf, text, turn, user } from "./helpers.ts";

const MIN = 60_000;
const START = 1_800_000_000_000;

describe("extension wiring", () => {
	let dir: string;
	let clock: number;
	const realNow = Date.now;
	let prevEnv: string | undefined;

	const realDelay = timing.compactDelayMs;
	beforeEach(() => {
		timing.compactDelayMs = 5;
		resetIds();
		dir = mkdtempSync(join(tmpdir(), "pi-diet-"));
		prevEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		clock = START;
		Date.now = () => clock;
	});
	afterEach(() => {
		timing.compactDelayMs = realDelay;
		Date.now = realNow;
		if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevEnv;
		rmSync(dir, { recursive: true, force: true });
	});

	const writeConfig = (c: object) => writeFileSync(join(dir, "context-diet.json"), JSON.stringify(c));
	const readConfig = () => JSON.parse(readFileSync(join(dir, "context-diet.json"), "utf8"));

	/** A fake pi plus a fake context. `entries` is what the session already holds (a resumed session). */
	async function boot(opts: { config?: object; entries?: unknown[]; hasUI?: boolean; uiBroken?: boolean; tokens?: number | null; idle?: boolean; pending?: boolean; model?: unknown } = {}) {
		if (opts.config) writeConfig(opts.config);
		const handlers: Record<string, Function> = {};
		const appended: unknown[] = [];
		let command: any;
		const statuses: string[] = [];
		const notes: string[] = [];
		const pi = {
			on: (e: string, f: Function) => (handlers[e] = f),
			registerCommand: (_: string, c: any) => (command = c),
			appendEntry: (customType: string, data: unknown) => appended.push({ type: "custom", customType, data }),
		};
		const live = { tokens: opts.tokens ?? null, idle: opts.idle ?? true, pending: opts.pending ?? false, model: opts.model };
		const compactCalls: any[] = [];
		const ctx: any = {
			hasUI: opts.hasUI ?? true,
			getContextUsage: () => (live.tokens === null ? undefined : { tokens: live.tokens, contextWindow: 200_000, percent: null }),
			isIdle: () => live.idle,
			hasPendingMessages: () => live.pending,
			compact: (o: unknown) => compactCalls.push(o),
			get model() {
				return live.model;
			},
			sessionManager: { getEntries: () => opts.entries ?? [] },
			ui: {
				theme: { fg: (_c: string, t: string) => t },
				setStatus: (_k: string, v: string) => {
					if (opts.uiBroken) throw new Error("ui down");
					statuses.push(v);
				},
				notify: (m: string) => notes.push(m),
			},
		};
		contextDiet(pi as any);
		await handlers.session_start({}, ctx);
		const request = (messages: Message[]) => handlers.context({ type: "context", messages }, ctx) as { messages: Message[] } | undefined;
		return { handlers, appended, command, statuses, notes, ctx, request, live, compactCalls };
	}

	/** 30 turns that ended `agoMs` ago. */
	const longConvo = (agoMs: number) => convo(30, { endTs: clock - agoMs });

	it("loads the config file at session start", async () => {
		const t = await boot({ config: { enabled: false } });
		expect(t.request(longConvo(10 * MIN))).toBeUndefined();
	});

	it("does nothing while the prompt cache is warm", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		expect(t.request(longConvo(MIN))).toBeUndefined();
		expect(t.appended).toEqual([]);
	});

	it("elides stale results when the cache has gone cold, and records the decision", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		const messages = longConvo(10 * MIN);
		const out = t.request(messages)!;
		expect(resultsOf(out.messages).filter(isStub)).toHaveLength(24);
		expect(resultsOf(messages).some(isStub)).toBe(false); // the original conversation is untouched
		expect(t.appended).toHaveLength(1);
		const entry = t.appended[0] as any;
		expect(entry.customType).toBe("context-diet");
		expect(entry.data.ids).toHaveLength(24);
		expect(entry.data.cold).toBe(true);
		expect(t.statuses.at(-1)).toContain("🥗");
	});

	it("applies the SAME set on later (warm) requests, and does not add to it until the next cold start", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		const messages = longConvo(10 * MIN);
		const first = t.request(messages)!;

		// the conversation grows and more results age past keepTurns, but the cache is warm now
		clock += MIN;
		const grown = [...messages, ...turn({ chars: 4000, ts: clock }), ...turn({ chars: 4000, ts: clock }), ...turn({ chars: 4000, ts: clock })];
		const second = t.request(grown)!;
		expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages); // byte-stable prefix
		expect(resultsOf(second.messages).filter(isStub)).toHaveLength(24); // no new elision while warm
		expect(t.appended).toHaveLength(1);

		// ...a long pause: now the newly stale results are elided too
		clock += 20 * MIN;
		const third = t.request(grown)!;
		expect(resultsOf(third.messages).filter(isStub).length).toBeGreaterThan(24);
		expect(t.appended).toHaveLength(2);
	});

	it("simulated long session: the prefix only changes at cold starts, and the context shrinks a lot", async () => {
		const t = await boot({ config: { keepTurns: 10 } });
		const conversation: Message[] = [user("start", clock)];
		let prev: Message[] = [];
		let prevEntries = 0;
		let sent = 0;
		let baseline = 0;
		let coldStarts = 0;
		const chars = (ms: Message[]) => ms.reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0);

		for (let i = 0; i < 120; i++) {
			if (i === 50 || i === 100) clock += 15 * MIN; // the user walked away
			clock += 20_000;
			const snapshot = [...conversation];
			const out = t.request(snapshot)?.messages ?? snapshot;
			const decided = t.appended.length > prevEntries;
			prevEntries = t.appended.length;
			if (decided) coldStarts++;
			if (!decided && prev.length > 0) {
				expect(JSON.stringify(out.slice(0, prev.length)), `step ${i}`).toBe(JSON.stringify(prev)); // cache-stable
			}
			sent += chars(out);
			baseline += chars(snapshot);
			prev = out;
			conversation.push(...turn({ chars: 4000, ts: clock }));
		}
		expect(coldStarts).toBe(2);
		expect(sent).toBeLessThan(baseline * 0.7); // well over 30% less re-sent context
	});

	it("a resumed session keeps the same elided set, so the prefix stays stable across restarts", async () => {
		const a = await boot({ config: { keepTurns: 5 } });
		const messages = longConvo(10 * MIN);
		const first = a.request(messages)!;

		clock += MIN; // the user comes back within the cache lifetime: warm
		const b = await boot({ entries: a.appended });
		const resumed = b.request(messages)!;
		expect(resumed.messages).toEqual(first.messages);
	});

	it("/context-diet now elides on the next request even when warm, once", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		const messages = longConvo(MIN);
		expect(t.request(messages)).toBeUndefined();
		await t.command.handler("now", t.ctx);
		expect(t.notes.at(-1)).toContain("next request");
		expect(resultsOf(t.request(messages)!.messages).filter(isStub)).toHaveLength(24);
		// forced only once: a later warm request adds nothing new
		const grown = [...messages, ...turn({ chars: 4000, ts: clock }), ...turn({ chars: 4000, ts: clock }), ...turn({ chars: 4000, ts: clock })];
		expect(resultsOf(t.request(grown)!.messages).filter(isStub)).toHaveLength(24);
	});

	it("mode always elides without waiting for a cold cache", async () => {
		const t = await boot({ config: { keepTurns: 5, mode: "always" } });
		expect(resultsOf(t.request(longConvo(MIN))!.messages).filter(isStub)).toHaveLength(24);
	});

	it("when off, the full history is sent", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		expect(t.request(longConvo(10 * MIN))).toBeDefined();
		await t.command.handler("off", t.ctx);
		expect(t.request(longConvo(10 * MIN))).toBeUndefined();
		expect(readConfig().enabled).toBe(false);
		expect(t.statuses.at(-1)).toBe("");
		await t.command.handler("on", t.ctx);
		expect(t.request(longConvo(10 * MIN))).toBeDefined();
	});

	it("never throws on junk messages, and sends the conversation unchanged", async () => {
		const t = await boot();
		for (const junk of [[null], [{}], ["text"], [{ role: "toolResult" }, undefined], undefined as any, 5 as any]) {
			expect(() => t.request(junk)).not.toThrow();
			expect(t.request(junk)).toBeUndefined();
		}
	});

	it("a broken UI never changes what is sent: the results are still elided", async () => {
		const t = await boot({ config: { keepTurns: 5 }, uiBroken: true });
		const messages = longConvo(10 * MIN);
		expect(resultsOf(t.request(messages)!.messages).filter(isStub)).toHaveLength(24);
		expect(resultsOf(t.request(messages)!.messages).filter(isStub)).toHaveLength(24);
	});

	it("without a UI there are no status calls; with showStatus off the status line stays empty", async () => {
		const quiet = await boot({ config: { keepTurns: 5 }, hasUI: false });
		quiet.request(longConvo(10 * MIN));
		expect(quiet.statuses).toEqual([]);
		const hidden = await boot({ config: { keepTurns: 5, showStatus: false } });
		hidden.request(longConvo(10 * MIN));
		expect(hidden.statuses.every((s) => s === "")).toBe(true);
	});

	it("session start survives a broken UI", async () => {
		await expect(boot({ uiBroken: true })).resolves.toBeDefined();
	});

	it("/context-diet status reports the savings", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		t.request(longConvo(10 * MIN));
		await t.command.handler("", t.ctx);
		const text = t.notes.at(-1)!;
		expect(text).toContain("pi-context-diet: on · mode cold · keep last 5 turns");
		expect(text).toContain("24 results elided");
		expect(text).toContain("1 cold start");
	});

	it("keep, ttl and mode are applied and remembered", async () => {
		const t = await boot();
		await t.command.handler("keep 7", t.ctx);
		await t.command.handler("ttl 60", t.ctx);
		await t.command.handler("mode always", t.ctx);
		expect(readConfig()).toMatchObject({ keepTurns: 7, cacheTtlMinutes: 60, mode: "always" });
		expect(t.notes.slice(-3).join("\n")).toContain("last 7 assistant turns");
		expect(t.notes.slice(-3).join("\n")).toContain("60 min");
		expect(t.notes.at(-1)).toContain("only without prompt caching");
		await t.command.handler("mode cold", t.ctx);
		expect(t.notes.at(-1)).toContain("already cold (free)");
	});

	it("a longer ttl keeps the cache warm for longer", async () => {
		const t = await boot({ config: { keepTurns: 5, cacheTtlMinutes: 60 } });
		expect(t.request(longConvo(30 * MIN))).toBeUndefined();
		expect(t.request(longConvo(61 * MIN))).toBeDefined();
	});

	it("bad input prints usage instead of failing", async () => {
		const t = await boot();
		for (const bad of ["keep", "keep x", "keep 0", "ttl 0", "ttl 5000", "mode sometimes", "bogus"]) {
			await t.command.handler(bad, t.ctx);
			expect(t.notes.at(-1), bad).toContain("Usage");
		}
	});

	// -- stub preview ----------------------------------------------------------------------------------------

	it("stubs keep the last lines and the error lines of what they replace", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		const log = [...Array.from({ length: 300 }, (_, i) => `compiling crate ${i}`), "error[E0308]: mismatched types", "BUILD FAILED in 4s"].join("\n");
		const messages = [user("go"), ...turn({ chars: 10, content: text(log), ts: clock - 30 * MIN }), ...convo(30, { endTs: clock - 10 * MIN }).slice(1)];
		const out = t.request(messages)!.messages;
		const stub = JSON.stringify(resultsOf(out)[0].content);
		expect(stub).toContain("error[E0308]: mismatched types");
		expect(stub).toContain("BUILD FAILED in 4s");
		expect(stub.length).toBeLessThan(600);
	});

	it("stubTailLines and stubErrorLines of 0 leave a bare one-line stub", async () => {
		const t = await boot({ config: { keepTurns: 5, stubTailLines: 0, stubErrorLines: 0 } });
		const messages = [user("go"), ...turn({ chars: 10, content: text("error: x\nlast line"), ts: clock - 30 * MIN }), ...convo(30, { endTs: clock - 10 * MIN }).slice(1)];
		const out = t.request(messages)!.messages;
		expect(JSON.stringify(out[2].content)).not.toContain("last lines");
	});

	// -- write / edit arguments -------------------------------------------------------------------------------

	const withWrites = (agoMs: number): Message[] => [
		user("go", clock - agoMs - 3_000_000),
		...turn({ tool: "write", args: { path: "src/a.ts", content: big(6000) }, chars: 40, ts: clock - agoMs - 2_000_000 }),
		...turn({ tool: "edit", args: { path: "src/a.ts", edits: [{ oldText: big(2500), newText: big(2500, "y") }] }, chars: 40, ts: clock - agoMs - 1_000_000 }),
		...convo(30, { endTs: clock - agoMs }).slice(1),
	];
	const toolCalls = (ms: Message[]) => ms.filter((m) => m.role === "assistant").flatMap((m) => m.content as any[]).filter((p) => p.type === "toolCall");

	it("elides stale write content and edit text at a cold start, and records the decision", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		const out = t.request(withWrites(10 * MIN))!.messages;
		const [w, e] = toolCalls(out);
		expect(w.arguments.path).toBe("src/a.ts");
		expect(w.arguments.content).toContain("pi-context-diet");
		expect(e.arguments.edits[0].oldText).toContain("pi-context-diet");
		expect((t.appended[0] as any).data.argIds).toHaveLength(2);
		expect(t.statuses.at(-1)).toContain("🥗");
	});

	it("the elided arguments stay elided, byte-stable, on later warm requests", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		const messages = withWrites(10 * MIN);
		const first = t.request(messages)!;
		clock += MIN;
		const grown = [...messages, ...turn({ chars: 4000, ts: clock }), ...turn({ chars: 4000, ts: clock })];
		const second = t.request(grown)!;
		expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
		expect(t.appended).toHaveLength(1);
	});

	it("/context-diet args off keeps write/edit arguments in the context", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		await t.command.handler("args off", t.ctx);
		expect(readConfig().elideArgs).toBe(false);
		expect(t.notes.at(-1)).toContain("stay in the context");
		const out = t.request(withWrites(10 * MIN))!.messages;
		expect(JSON.stringify(toolCalls(out))).not.toContain("pi-context-diet");
		await t.command.handler("args on", t.ctx);
		expect(t.notes.at(-1)).toContain("be elided too");
	});

	it("simulated session with writes and edits: the prefix only changes at cold starts", async () => {
		const t = await boot({ config: { keepTurns: 8, minChars: 400 } });
		const conversation: Message[] = [user("start", clock)];
		let prev: Message[] = [];
		let prevEntries = 0;
		let argsSent = 0;
		for (let i = 0; i < 90; i++) {
			if (i === 40 || i === 75) clock += 15 * MIN;
			clock += 20_000;
			const snapshot = [...conversation];
			const out = t.request(snapshot)?.messages ?? snapshot;
			const decided = t.appended.length > prevEntries;
			prevEntries = t.appended.length;
			if (!decided && prev.length > 0) expect(JSON.stringify(out.slice(0, prev.length)), `step ${i}`).toBe(JSON.stringify(prev));
			argsSent = toolCalls(out).filter((p) => JSON.stringify(p.arguments).includes("pi-context-diet")).length;
			prev = out;
			conversation.push(...(i % 3 === 0
				? turn({ tool: "write", args: { path: `src/f${i}.ts`, content: big(3000) }, chars: 40, ts: clock })
				: turn({ chars: 3000, ts: clock })));
		}
		expect(t.appended).toHaveLength(2);
		expect(argsSent).toBeGreaterThan(5);
	});

	// -- recovery meter and auto-protection -----------------------------------------------------------------

	const refetch = (t: Awaited<ReturnType<typeof boot>>, n: number) => {
		for (let i = 1; i <= n; i++) expect(t.handlers.tool_call({ toolName: "bash", input: { command: `echo step ${i}` } }, t.ctx)).toBeUndefined();
	};

	it("notices when the agent re-issues an elided call, and reports the cost", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		t.request(longConvo(10 * MIN)); // turns 1..24 are elided
		refetch(t, 1);
		expect(t.statuses.at(-1)).toContain("↺1");
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("recovery: 1 of 24 elided results re-fetched (4%");
	});

	it("does not count calls that differ from what was elided, or calls to results that were kept", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		t.request(longConvo(10 * MIN));
		expect(t.handlers.tool_call({ toolName: "bash", input: { command: "echo something else" } }, t.ctx)).toBeUndefined();
		expect(t.handlers.tool_call({ toolName: "read", input: { command: "echo step 1" } }, t.ctx)).toBeUndefined();
		expect(t.handlers.tool_call({ toolName: "bash", input: { command: "echo step 30" } }, t.ctx)).toBeUndefined(); // kept, not elided
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("recovery: 0 of 24");
	});

	it("protects a tool whose results keep being re-fetched, tells you, and stops eliding it", async () => {
		const t = await boot({ config: { keepTurns: 5, recoveryThreshold: 0.1 } });
		const base = longConvo(10 * MIN);
		t.request(base);
		refetch(t, 2);
		expect(t.appended.filter((e: any) => e.customType === "context-diet-protect")).toHaveLength(0);
		refetch(t, 3); // 3 of 24 = 12.5% > 10%
		const protect = t.appended.filter((e: any) => e.customType === "context-diet-protect") as any[];
		expect(protect).toHaveLength(1);
		expect(protect[0].data.tool).toBe("bash");
		expect(t.notes.at(-1)).toContain("protecting bash results for the rest of the session");
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("protected: bash");

		// the next cold start elides no more bash results; the ones already elided stay elided (the prefix stays stable)
		clock += 30 * MIN;
		const grown = [...base, ...convo(30, { endTs: clock - 20 * MIN }).slice(1)];
		const out = t.request(grown)!.messages;
		expect(resultsOf(out).filter(isStub)).toHaveLength(24);
	});

	it("autoProtect off: re-fetches are counted but nothing is protected", async () => {
		const t = await boot({ config: { keepTurns: 5, recoveryThreshold: 0.1, autoProtect: false } });
		t.request(longConvo(10 * MIN));
		refetch(t, 6);
		expect(t.appended.filter((e: any) => e.customType === "context-diet-protect")).toHaveLength(0);
		expect(t.statuses.at(-1)).toContain("↺6");
	});

	it("a resumed session remembers which tools are protected", async () => {
		const a = await boot({ config: { keepTurns: 5, recoveryThreshold: 0.1 } });
		const base = longConvo(10 * MIN);
		a.request(base);
		refetch(a, 3);
		const b = await boot({ config: { keepTurns: 5 }, entries: a.appended.filter((e: any) => e.customType === "context-diet-protect") });
		expect(b.request(base)).toBeUndefined(); // every result is a bash result and bash is protected: nothing to elide
	});

	it("the recovery observer never blocks a tool and survives junk and a broken UI", async () => {
		const t = await boot({ config: { keepTurns: 5, recoveryThreshold: 0.1 }, uiBroken: true });
		t.request(longConvo(10 * MIN));
		for (const event of [null, undefined, {}, { toolName: 5 }, { toolName: "bash", input: undefined }]) {
			expect(() => t.handlers.tool_call(event as any, t.ctx)).not.toThrow();
			expect(t.handlers.tool_call(event as any, t.ctx)).toBeUndefined();
		}
		expect(() => refetch(t, 4)).not.toThrow(); // the notify / status calls throw: still fine
		const quiet = await boot({ config: { keepTurns: 5, recoveryThreshold: 0.1 }, hasUI: false });
		resetIds(); // the helper numbers commands across calls: start again so "echo step 1" is in this conversation
		quiet.request(longConvo(10 * MIN));
		refetch(quiet, 3);
		expect(quiet.notes).toEqual([]); // no UI: no warning, but the tool is still protected
		expect(quiet.appended.some((e: any) => e.customType === "context-diet-protect")).toBe(true);
	});

	it("does nothing when disabled", async () => {
		const t = await boot({ config: { keepTurns: 5, enabled: false } });
		expect(t.handlers.tool_call({ toolName: "bash", input: { command: "echo step 1" } }, t.ctx)).toBeUndefined();
	});

	// -- the dangerous mode is never silent -------------------------------------------------------------

	it("warns at session start when mode is always (it rewrites the prompt cache on every pass)", async () => {
		const t = await boot({ config: { mode: "always" } });
		expect(t.notes.at(-1)).toContain("mode is 'always'");
		expect(t.notes.at(-1)).toContain("/context-diet mode cold");
	});

	it("shows ⚠ mode always in the footer even before anything is elided, and after", async () => {
		const t = await boot({ config: { mode: "always", keepTurns: 5 } });
		expect(t.statuses.at(-1)).toContain("⚠ mode always");
		t.request(longConvo(MIN));
		expect(t.statuses.at(-1)).toContain("🥗");
		expect(t.statuses.at(-1)).toContain("⚠ mode always");
	});

	it("says nothing in the default cold mode, when disabled, or without a UI", async () => {
		const cold = await boot();
		expect(cold.notes).toEqual([]);
		expect(cold.statuses.at(-1)).toBe("");
		const off = await boot({ config: { mode: "always", enabled: false } });
		expect(off.notes).toEqual([]);
		const quiet = await boot({ config: { mode: "always" }, hasUI: false });
		expect(quiet.notes).toEqual([]);
		expect(quiet.statuses).toEqual([]);
	});

	it("a failing notify cannot break session start", async () => {
		writeConfig({ mode: "always" });
		const handlers: Record<string, Function> = {};
		contextDiet({ on: (e: string, f: Function) => (handlers[e] = f), registerCommand() {}, appendEntry() {} } as any);
		const ctx: any = { hasUI: true, sessionManager: { getEntries: () => [] }, ui: { theme: { fg: (_: string, t: string) => t }, setStatus() {}, notify() { throw new Error("ui down"); } } };
		await expect(handlers.session_start({}, ctx)).resolves.toBeUndefined();
	});

	it("switching to mode always from the command also puts the marker in the footer", async () => {
		const t = await boot();
		await t.command.handler("mode always", t.ctx);
		expect(t.statuses.at(-1)).toContain("⚠ mode always");
		await t.command.handler("mode cold", t.ctx);
		expect(t.statuses.at(-1)).toBe("");
	});

	// -- calibration ---------------------------------------------------------------------------------------

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const assistantEnd = (usage: object | undefined, role = "assistant") => ({ type: "message_end", message: { role, usage } });

	it("learns chars-per-token from the provider's own usage and says so in the status", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("2.00 chars/token".replace("2.00", "3.00") + " assumed (calibrating: 0 of 6 requests)");
		for (let n = 4; n <= 14; n++) {
			const messages = convo(n, { endTs: clock - MIN, chars: 3000 });
			const sent = t.request(messages)?.messages ?? messages;
			const tokens = 20_000 + charsOfMessages(sent) / 2.5;
			expect(t.handlers.message_end(assistantEnd({ input: 100, cacheRead: tokens - 1100, cacheWrite: 1000 }), t.ctx)).toBeUndefined();
		}
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("2.50 chars/token measured from 11 requests");
	});

	it("does not claim a measurement when the provider's usage never varies with size", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		for (let n = 4; n <= 12; n++) {
			t.request(convo(n, { endTs: clock - MIN, chars: 3000 }));
			t.handlers.message_end(assistantEnd({ input: 5200 }), t.ctx); // a fixed token count whatever was sent
		}
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("3.00 chars/token assumed (the provider's usage did not vary with context size)");
		expect(t.notes.at(-1)).not.toContain("measured");
	});

	it("ignores non-assistant messages, messages without usage, and junk, and never replaces a message", async () => {
		const t = await boot();
		t.request(convo(5, { endTs: clock - MIN }));
		for (const e of [assistantEnd({ input: 5 }, "user"), assistantEnd(undefined), assistantEnd({}), { message: undefined }, null, undefined, {}]) {
			expect(() => t.handlers.message_end(e as any, t.ctx)).not.toThrow();
			expect(t.handlers.message_end(e as any, t.ctx)).toBeUndefined();
		}
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("calibrating: 0 of 6 requests");
	});

	// -- cache warming ----------------------------------------------------------------------------------------

	const PRICES = { cost: { cacheRead: 0.3, cacheWrite: 3.75 } };
	const warmEvent = (over: object = {}) => ({ type: "cache_warming_decision", action: "warm", warmCost: 0.1, missCost: 1.2, continuationProbability: 0.8, ...over });
	const bigStale = () => convo(30, { endTs: clock - MIN, chars: 20_000 }); // ~160k stale tokens

	it("stops pi's idle cache warming when enough of the context is stale, and says so", async () => {
		const t = await boot({ config: { keepTurns: 5 }, tokens: 300_000, model: PRICES });
		t.request(bigStale());
		expect(t.handlers.cache_warming_decision(warmEvent(), t.ctx)).toEqual({ action: "stop" });
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("warming: stopped 1×");
	});

	it("keeps warming when little is stale", async () => {
		const t = await boot({ config: { keepTurns: 5 }, tokens: 300_000, model: PRICES });
		t.request(convo(30, { endTs: clock - MIN, chars: 300 }));
		expect(t.handlers.cache_warming_decision(warmEvent(), t.ctx)).toBeUndefined();
	});

	it("never turns pi's own stop into a warm", async () => {
		const t = await boot({ config: { keepTurns: 5 }, tokens: 300_000, model: PRICES });
		t.request(bigStale());
		expect(t.handlers.cache_warming_decision(warmEvent({ action: "stop" }), t.ctx)).toBeUndefined();
	});

	it("without model prices it falls back to the stale share of the context", async () => {
		const t = await boot({ config: { keepTurns: 5 }, tokens: 300_000 });
		t.request(bigStale());
		expect(t.handlers.cache_warming_decision(warmEvent(), t.ctx)).toEqual({ action: "stop" });
		const unknown = await boot({ config: { keepTurns: 5 }, tokens: null });
		unknown.request(bigStale());
		expect(unknown.handlers.cache_warming_decision(warmEvent(), unknown.ctx)).toBeUndefined(); // no context size, no prices: leave pi alone
	});

	it("leaves pi alone when disabled, in always mode, with arbitration off, or before any request", async () => {
		for (const config of [{ enabled: false }, { mode: "always" }, { warmArbitration: false }]) {
			const t = await boot({ config: { keepTurns: 5, ...config }, tokens: 300_000, model: PRICES });
			t.request(bigStale());
			expect(t.handlers.cache_warming_decision(warmEvent(), t.ctx), JSON.stringify(config)).toBeUndefined();
		}
		const fresh = await boot({ tokens: 300_000, model: PRICES });
		expect(fresh.handlers.cache_warming_decision(warmEvent(), fresh.ctx)).toBeUndefined();
	});

	it("never throws into pi's warmer", async () => {
		const t = await boot({ config: { keepTurns: 5 }, tokens: 300_000, model: PRICES });
		t.request(bigStale());
		for (const e of [null, undefined, {}, { action: "warm" }]) expect(() => t.handlers.cache_warming_decision(e as any, t.ctx)).not.toThrow();
		const broken: any = { get model() { throw new Error("boom"); }, getContextUsage: () => undefined };
		expect(t.handlers.cache_warming_decision(warmEvent(), broken)).toBeUndefined();
	});

	// -- compaction (opt-in) ------------------------------------------------------------------------------------

	const compactConfig = { compact: true, compactAboveTokens: 100_000 };

	it("is off by default: a big idle session is never compacted", async () => {
		const t = await boot({ tokens: 900_000 });
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toEqual([]);
	});

	it("compacts an idle, big session after the run ends, with instructions that keep what the work needs", async () => {
		const t = await boot({ config: compactConfig, tokens: 150_000 });
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toHaveLength(1);
		expect(t.compactCalls[0].customInstructions).toContain("file paths");
		expect(t.notes.at(-1)).toContain("compacting the session (context is 150.0k tokens)");
		t.compactCalls[0].onComplete({});
		expect(t.notes.at(-1)).toContain("compaction done");
		await t.command.handler("", t.ctx);
		expect(t.notes.at(-1)).toContain("compaction: on above 100.0k tokens, 1 done");
	});

	it("waits a tick and re-checks: nothing happens if the session is busy, has queued work, or shrank", async () => {
		const busy = await boot({ config: compactConfig, tokens: 150_000, idle: false });
		busy.handlers.agent_end({}, busy.ctx);
		await sleep(30);
		expect(busy.compactCalls).toEqual([]);
		const queued = await boot({ config: compactConfig, tokens: 150_000, pending: true });
		queued.handlers.agent_end({}, queued.ctx);
		await sleep(30);
		expect(queued.compactCalls).toEqual([]);
		const small = await boot({ config: compactConfig, tokens: 99_999 });
		small.handlers.agent_end({}, small.ctx);
		await sleep(30);
		expect(small.compactCalls).toEqual([]);
		const unknown = await boot({ config: compactConfig, tokens: null });
		unknown.handlers.agent_end({}, unknown.ctx);
		await sleep(30);
		expect(unknown.compactCalls).toEqual([]);
	});

	it("is a no-op when disabled or turned off, and schedules at most one check at a time", async () => {
		const off = await boot({ config: { compact: false }, tokens: 150_000 });
		off.handlers.agent_end({}, off.ctx);
		await sleep(30);
		expect(off.compactCalls).toEqual([]);
		const disabled = await boot({ config: { ...compactConfig, enabled: false }, tokens: 150_000 });
		disabled.handlers.agent_end({}, disabled.ctx);
		await sleep(30);
		expect(disabled.compactCalls).toEqual([]);
		const t = await boot({ config: compactConfig, tokens: 150_000 });
		for (let i = 0; i < 5; i++) t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toHaveLength(1);
	});

	it("does not start a second compaction while one is running, and waits out the cooldown after one finishes", async () => {
		const t = await boot({ config: compactConfig, tokens: 150_000 });
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toHaveLength(1); // still in flight
		t.compactCalls[0].onComplete({});
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toHaveLength(1); // cooldown
		for (let i = 0; i < COMPACT_COOLDOWN_TURNS; i++) t.handlers.message_end(assistantEnd({ input: 10 }), t.ctx);
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toHaveLength(2);
	});

	it("a failed compaction is reported and can be retried", async () => {
		const t = await boot({ config: compactConfig, tokens: 150_000 });
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		t.compactCalls[0].onError(new Error("model down"));
		expect(t.notes.at(-1)).toContain("compaction failed: model down");
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toHaveLength(2);
	});

	it("pi's own compactions (manual or threshold) restart the cooldown", async () => {
		const t = await boot({ config: compactConfig, tokens: 150_000 });
		t.handlers.session_compact({}, t.ctx);
		t.handlers.agent_end({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toEqual([]);
	});

	it("a shutdown cancels a pending check", async () => {
		const t = await boot({ config: compactConfig, tokens: 150_000 });
		t.handlers.agent_end({}, t.ctx);
		t.handlers.session_shutdown({}, t.ctx);
		await sleep(30);
		expect(t.compactCalls).toEqual([]);
	});

	it("never throws into pi, even with a broken context, and works without a UI", async () => {
		const t = await boot({ config: compactConfig, tokens: 150_000 });
		const broken: any = { getContextUsage: () => { throw new Error("boom"); }, isIdle: () => true, hasPendingMessages: () => false };
		expect(() => t.handlers.agent_end({}, broken)).not.toThrow();
		await sleep(30);
		expect(t.compactCalls).toEqual([]);
		const q = await boot({ config: compactConfig, tokens: 150_000, hasUI: false });
		q.handlers.agent_end({}, q.ctx);
		await sleep(30);
		expect(q.compactCalls).toHaveLength(1);
		q.compactCalls[0].onComplete({});
		q.compactCalls[0].onError(new Error("x"));
		expect(q.notes).toEqual([]);
	});

	it("/context-diet compact on|off is remembered", async () => {
		const t = await boot();
		await t.command.handler("compact on", t.ctx);
		expect(readConfig().compact).toBe(true);
		expect(t.notes.at(-1)).toContain("compaction on");
		expect(t.notes.at(-1)).toContain("150.0k");
		await t.command.handler("compact off", t.ctx);
		expect(readConfig().compact).toBe(false);
		expect(t.notes.at(-1)).toContain("compaction off");
		await t.command.handler("compact maybe", t.ctx);
		expect(t.notes.at(-1)).toContain("Usage: /context-diet compact");
	});

	it("/context-diet compact now compacts an idle session, and refuses a busy one or one already compacting", async () => {
		const t = await boot();
		await t.command.handler("compact now", t.ctx);
		expect(t.compactCalls).toHaveLength(1);
		expect(t.notes.at(-1)).toContain("compacting the session (requested)");
		await t.command.handler("compact now", t.ctx);
		expect(t.compactCalls).toHaveLength(1); // in flight
		expect(t.notes.at(-1)).toContain("can only compact an idle session");
		t.compactCalls[0].onComplete({});
		t.live.idle = false;
		await t.command.handler("compact now", t.ctx);
		expect(t.compactCalls).toHaveLength(1);
		expect(t.notes.at(-1)).toContain("can only compact an idle session");
	});

	// -- show --------------------------------------------------------------------------------------------------

	it("/context-diet show says so before the first request", async () => {
		const t = await boot();
		await t.command.handler("show", t.ctx);
		expect(t.notes.at(-1)).toContain("nothing to show yet");
	});

	it("/context-diet show lists what is elided and what the next cold start would take", async () => {
		const t = await boot({ config: { keepTurns: 5 } });
		const messages = longConvo(10 * MIN);
		t.request(messages);
		await t.command.handler("show", t.ctx);
		const text = t.notes.at(-1)!;
		expect(text).toContain("elided now: 24");
		expect(text).toContain("bash echo step 1");
		expect(text).toContain("… and 16 more");
		expect(text).toContain("next cold start would elide: none");
		clock += 20 * MIN;
		const grown = [...messages, ...convo(30, { endTs: clock - 15 * MIN }).slice(1)];
		t.request(grown);
		await t.command.handler("show", t.ctx);
		expect(t.notes.at(-1)).toContain("elided now: 54"); // 60 results, the newest 6 kept
	});

	it("registers completions pi can apply", async () => {
		const t = await boot();
		expect(typeof t.command.getArgumentCompletions).toBe("function");
		expect(t.command.getArgumentCompletions("mo")![0].label).toBe("mode");
	});
});
