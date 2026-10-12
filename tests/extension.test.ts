import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextDiet, { type Message } from "../extensions/context-diet.ts";
import { big, convo, isStub, resetIds, resultsOf, text, turn, user } from "./helpers.ts";

const MIN = 60_000;
const START = 1_800_000_000_000;

describe("extension wiring", () => {
	let dir: string;
	let clock: number;
	const realNow = Date.now;
	let prevEnv: string | undefined;

	beforeEach(() => {
		resetIds();
		dir = mkdtempSync(join(tmpdir(), "pi-diet-"));
		prevEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		clock = START;
		Date.now = () => clock;
	});
	afterEach(() => {
		Date.now = realNow;
		if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevEnv;
		rmSync(dir, { recursive: true, force: true });
	});

	const writeConfig = (c: object) => writeFileSync(join(dir, "context-diet.json"), JSON.stringify(c));
	const readConfig = () => JSON.parse(readFileSync(join(dir, "context-diet.json"), "utf8"));

	/** A fake pi plus a fake context. `entries` is what the session already holds (a resumed session). */
	async function boot(opts: { config?: object; entries?: unknown[]; hasUI?: boolean; uiBroken?: boolean } = {}) {
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
		const ctx: any = {
			hasUI: opts.hasUI ?? true,
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
		return { handlers, appended, command, statuses, notes, ctx, request };
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

	it("registers completions pi can apply", async () => {
		const t = await boot();
		expect(typeof t.command.getArgumentCompletions).toBe("function");
		expect(t.command.getArgumentCompletions("mo")![0].label).toBe("mode");
	});
});
