import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextDiet, { type Message } from "../extensions/context-diet.ts";
import { convo, isStub, resetIds, resultsOf, turn, user } from "./helpers.ts";

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

	it("registers completions pi can apply", async () => {
		const t = await boot();
		expect(typeof t.command.getArgumentCompletions).toBe("function");
		expect(t.command.getArgumentCompletions("mo")![0].label).toBe("mode");
	});
});
