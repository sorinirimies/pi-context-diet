// Randomised robustness tests ("fuzzing" without extra dependencies).
//
// The extension rewrites every request pi sends, so it must survive any conversation, a
// hand-edited config file, any /context-diet command line and any session entries, and it
// must never change the messages it was given. The generator is seeded, so a failure
// prints a seed that reproduces it exactly:
//
//   FUZZ_SEED=12345 bun test tests/fuzz.test.ts --config=bunfig.fuzz.toml
//   FUZZ_ITERS=200000 bun test tests/fuzz.test.ts --config=bunfig.fuzz.toml   (the nightly workflow)
import { describe, expect, it } from "bun:test";
import {
	applyElision,
	Calibrator,
	completions,
	decide,
	DEFAULT_CONFIG,
	describeCandidates,
	describeElided,
	ENTRY_TYPE,
	elideArguments,
	formatSize,
	formatTokens,
	type Message,
	measure,
	parseCommand,
	policyOf,
	PROTECT_ENTRY_TYPE,
	previewOf,
	RecoveryMeter,
	restoreState,
	sanitizeConfig,
	stableStringify,
	statusLine,
} from "../extensions/context-diet.ts";

const KEYS = [...Object.keys(DEFAULT_CONFIG), "type", "text", "content", "path", "oldText", "newText", "edits", "command", "ids", "argIds", "tool"];
const ITERS = Number(process.env.FUZZ_ITERS ?? 400);
const SEED = Number(process.env.FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));

/** mulberry32: small, fast, seedable. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function gen(seed: number) {
	const r = rng(seed);
	const int = (n: number) => Math.floor(r() * n);
	const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
	const NASTY = [0, -0, 1, -1, 0.5, NaN, Infinity, -Infinity, 1e308, -1e308, 2 ** 53, 2 ** 31, 1e-300, Number.MAX_SAFE_INTEGER];
	const number = () => (r() < 0.5 ? pick(NASTY) : (r() - 0.5) * 10 ** int(16));
	/** Printable ASCII, mostly; sometimes control characters and lone surrogates. */
	const string = (max = 24) => {
		const len = int(max);
		let s = "";
		for (let i = 0; i < len; i++) s += String.fromCharCode(r() < 0.8 ? 32 + int(95) : int(0xd800));
		return s;
	};
	const value = (depth = 0): unknown => {
		const k = int(depth > 2 ? 6 : 9);
		if (k === 0) return number();
		if (k === 1) return string();
		if (k === 2) return null;
		if (k === 3) return undefined;
		if (k === 4) return r() < 0.5;
		if (k === 5) return pick(["", "NaN", "0", "-5", "1e999", "true"]);
		if (k === 6) return Array.from({ length: int(4) }, () => value(depth + 1));
		const o: Record<string, unknown> = {};
		for (let i = 0; i < int(5); i++) o[KEYS.length && r() < 0.6 ? pick(KEYS) : string()] = value(depth + 1);
		return o;
	};
	return { r, int, pick, number, string, value };
}
type Gen = ReturnType<typeof gen>;

/** Run `fn` ITERS times; on failure say which iteration and how to reproduce it. */
function fuzz(name: string, fn: (g: Gen) => void | Promise<void>, iters = ITERS) {
	it(`${name} (seed ${SEED}, ${iters} runs)`, async () => {
		for (let i = 0; i < iters; i++) {
			try {
				await fn(gen(SEED + i));
			} catch (e) {
				throw new Error(`${name}: failed at FUZZ_SEED=${SEED + i} FUZZ_ITERS=1: ${(e as Error).message}`);
			}
		}
	});
}

const TOOLS = ["read", "bash", "write", "edit", "grep", "find", "ls", "mcp"];
const LINES = ["ok", "error: boom", "FAIL src/a.test.ts", "0 failed", "TypeError: x is undefined", "", "   ", "panic!", "x".repeat(300)];
const text = (g: Gen) =>
	g.r() < 0.2 ? g.string(400) : Array.from({ length: g.int(g.r() < 0.1 ? 400 : 30) }, () => (g.r() < 0.7 ? g.pick(LINES) : g.string(60))).join(g.pick(["\n", "\r\n"]));
/** Tool-result content: a string, text parts, images, or junk. */
const content = (g: Gen): unknown => {
	const k = g.int(10);
	if (k === 0) return text(g);
	if (k === 1) return g.value();
	return Array.from({ length: g.int(4) }, () => {
		const j = g.int(10);
		if (j < 7) return { type: "text", text: text(g) };
		if (j === 7) return { type: "image", data: "AAAA", mimeType: "image/png" };
		if (j === 8) return null;
		return g.value();
	});
};
const args = (g: Gen, name: string): Record<string, unknown> => {
	const a: Record<string, unknown> = { path: g.r() < 0.8 ? `src/${g.string(8)}.ts` : g.value() };
	if (name === "write") a.content = g.r() < 0.9 ? text(g) : g.value();
	if (name === "edit") {
		if (g.r() < 0.5) a.edits = Array.from({ length: g.int(4) }, () => (g.r() < 0.9 ? { oldText: text(g), newText: text(g) } : g.value()));
		else Object.assign(a, { oldText: text(g), newText: g.r() < 0.9 ? text(g) : g.value() });
	}
	if (name === "bash") a.command = g.string(40);
	return a;
};

/** A plausible conversation: user turns, assistant turns with tool calls (some with thinking), their results. */
function conversation(g: Gen, now: number): Message[] {
	const out: Message[] = [];
	let t = now - g.int(4 * 3600_000);
	let n = 0;
	for (let turn = 0; turn < g.int(40); turn++) {
		t += g.int(120_000);
		if (g.r() < 0.3) out.push({ role: "user", content: g.r() < 0.5 ? g.string(80) : [{ type: "text", text: g.string(80) }], timestamp: t });
		const calls = Array.from({ length: g.int(4) }, () => {
			const name = g.pick(TOOLS);
			return { type: "toolCall", id: `call_${n++}`, name, arguments: args(g, name) };
		});
		const parts: unknown[] = [...calls];
		if (g.r() < 0.2) parts.unshift({ type: "thinking", thinking: g.string(40), thinkingSignature: "sig" });
		if (g.r() < 0.3) parts.push({ type: "text", text: g.string(80) });
		if (g.r() < 0.05) parts.push(g.value());
		out.push({ role: "assistant", content: parts, timestamp: g.r() < 0.95 ? t : (g.value() as number) });
		for (const c of calls) {
			if (g.r() < 0.1) continue; // no result (interrupted)
			out.push({ role: "toolResult", toolCallId: c.id, toolName: g.r() < 0.95 ? c.name : undefined, content: content(g), isError: g.r() < 0.1, timestamp: t });
		}
	}
	return out;
}
const ids = (messages: Message[]) => messages.flatMap((m) => (m.role === "toolResult" && typeof m.toolCallId === "string" ? [m.toolCallId] : []));
const randomConfig = (g: Gen) =>
	sanitizeConfig({
		...DEFAULT_CONFIG,
		mode: g.pick(["cold", "always"]),
		keepTurns: g.int(12),
		minChars: g.pick([200, 500, 1500, 10_000]),
		cacheTtlMinutes: g.pick([1, 5, 60]),
		keepErrors: g.r() < 0.5,
		neverElide: g.r() < 0.3 ? [g.pick(TOOLS)] : [],
		elideArgs: g.r() < 0.7,
		stubTailLines: g.int(11),
		stubErrorLines: g.int(11),
	});

describe("fuzz: config", () => {
	fuzz("sanitizeConfig turns anything into a valid config, and is idempotent", (g) => {
		const raw = g.r() < 0.7 ? Object.fromEntries(Object.keys(DEFAULT_CONFIG).filter(() => g.r() < 0.5).map((k) => [k, g.value()])) : g.value();
		const c = sanitizeConfig(raw);
		for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
			const got = (c as unknown as Record<string, unknown>)[k];
			if (Array.isArray(v)) expect((got as unknown[]).every((x) => typeof x === "string" && x.trim() === x && x !== "")).toBe(true);
			else expect(typeof got).toBe(typeof v);
			if (typeof v === "number") expect(Number.isFinite(got as number) && (got as number) >= 0).toBe(true);
		}
		expect(["cold", "always"]).toContain(c.mode);
		expect(sanitizeConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
	});
});

describe("fuzz: command line", () => {
	const WORDS = ["", "status", "on", "off", "enable", "disable", "now", "keep", "ttl", "mode", "cold", "always", "args", "show", "compact", "0", "1", "500", "501", "1440", "-3", "2.5", "1e3", "NaN", "Infinity"];
	const KINDS = ["status", "on", "off", "now", "keep", "ttl", "mode", "args", "show", "compact", "invalid"];
	const line = (g: Gen) => Array.from({ length: g.int(4) }, () => (g.r() < 0.8 ? g.pick(WORDS) : g.string(10))).join(g.pick([" ", "  ", "\t"]));

	fuzz("parseCommand never throws and returns a known command with values in range", (g) => {
		const cmd = parseCommand(g.r() < 0.05 ? undefined : line(g));
		expect(KINDS).toContain(cmd.kind);
		if (cmd.kind === "keep") expect(Number.isInteger(cmd.turns) && cmd.turns >= 1 && cmd.turns <= 500).toBe(true);
		if (cmd.kind === "ttl") expect(Number.isInteger(cmd.minutes) && cmd.minutes >= 1 && cmd.minutes <= 1440).toBe(true);
	});

	fuzz("completions only offer values that extend what was typed", (g) => {
		const typed = line(g) + (g.r() < 0.5 ? " " : "");
		const items = completions(typed);
		if (items === null) return;
		expect(items.length).toBeGreaterThan(0);
		for (const i of items) {
			expect(i.value.startsWith(typed.toLowerCase().replace(/^\s+/, ""))).toBe(true);
			expect(typeof i.label).toBe("string");
		}
	});
});

describe("fuzz: measuring and previews", () => {
	fuzz("measure counts only text, and previews stay within their limits", (g) => {
		const c = content(g);
		const m = measure(c);
		expect(Number.isInteger(m.chars) && m.chars >= 0 && Number.isInteger(m.lines) && m.lines >= 0).toBe(true);
		const tail = g.int(11);
		const errors = g.int(11);
		const p = previewOf(c, tail, errors);
		expect(p.tail.length).toBeLessThanOrEqual(tail);
		expect(p.errors.length).toBeLessThanOrEqual(errors);
		for (const l of [...p.tail, ...p.errors]) expect(l.length <= 160 && !l.includes("\n") && l.trim() === l && l !== "").toBe(true);
	});

	fuzz("sizes and token counts format any non-negative number", (g) => {
		const n = Math.abs(g.number());
		if (!Number.isFinite(n)) return;
		expect(formatSize(n)).not.toContain("NaN");
		expect(formatTokens(n)).not.toContain("NaN");
	});

	fuzz("stableStringify ignores key order and stays valid JSON", (g) => {
		const v = g.value();
		const shuffle = (x: unknown): unknown => {
			if (Array.isArray(x)) return x.map(shuffle);
			if (x && typeof x === "object") {
				const keys = Object.keys(x).sort(() => g.r() - 0.5);
				return Object.fromEntries(keys.map((k) => [k, shuffle((x as Record<string, unknown>)[k])]));
			}
			return x;
		};
		const s = stableStringify(v);
		expect(stableStringify(shuffle(v))).toBe(s);
		expect(() => JSON.parse(s)).not.toThrow();
	});
});

describe("fuzz: eliding a conversation", () => {
	fuzz("decide + applyElision never mutate their input and always give the same output", (g) => {
		const now = Date.now();
		const messages = conversation(g, now);
		const before = structuredClone(messages);
		const config = randomConfig(g);
		const all = ids(messages);
		const elided = new Set(all.filter(() => g.r() < 0.3));
		const d = decide(messages, elided, config, { now, force: g.r() < 0.3 }, { protectedTools: g.r() < 0.2 ? [g.pick(TOOLS)] : [] });

		for (const id of d.ids) expect(all).toContain(id);
		for (const id of d.ids) expect(elided.has(id)).toBe(false);

		const r = applyElision(messages, new Set([...elided, ...d.ids]), { argIds: new Set(d.argIds), preview: { tail: config.stubTailLines, errors: config.stubErrorLines } });
		expect(messages).toEqual(before);
		expect(r.messages.length).toBe(messages.length);
		expect(r.count).toBeLessThanOrEqual(elided.size + d.ids.length);
		expect(r.savedChars).toBeGreaterThanOrEqual(0);
		r.messages.forEach((m, i) => {
			const o = messages[i];
			expect(m.role).toBe(o.role);
			if (m === o) return;
			// Messages carrying signed thinking are never rewritten.
			if (o.role === "assistant") expect(JSON.stringify(o.content)).not.toContain('"thinking"');
			if (o.role === "toolResult") expect(m.toolCallId).toBe(o.toolCallId);
		});
		for (const i of r.infos) expect(all).toContain(i.id);

		// The same input always gives the same output (the prompt prefix must stay stable).
		const again = applyElision(structuredClone(before), new Set([...elided, ...d.ids]), { argIds: new Set(d.argIds), preview: { tail: config.stubTailLines, errors: config.stubErrorLines } });
		expect(again.messages).toEqual(r.messages);

		// Describing what is elided and what is next never throws.
		describeElided(messages, elided, new Set(d.argIds));
		describeCandidates(messages, policyOf(config), elided, new Set(d.argIds), config.elideArgs);
	});

	fuzz("elideArguments never mutates its input and keeps every key", (g) => {
		const name = g.pick(["write", "edit", "bash"]);
		const a = g.r() < 0.8 ? args(g, name) : (g.value() as Record<string, unknown>);
		if (!a || typeof a !== "object" || Array.isArray(a)) return;
		const before = structuredClone(a);
		const out = elideArguments(name, a);
		expect(a).toEqual(before);
		expect(Object.keys(out).sort()).toEqual(Object.keys(a).sort());
	});
});

describe("fuzz: session state and meters", () => {
	fuzz("restoreState accepts any session entries and keeps only strings", (g) => {
		const entries = Array.from({ length: g.int(10) }, () =>
			g.r() < 0.6
				? { type: g.r() < 0.9 ? "custom" : g.string(6), customType: g.pick([ENTRY_TYPE, PROTECT_ENTRY_TYPE, "other"]), data: g.value() }
				: g.value(),
		);
		const s = restoreState(entries);
		for (const set of [s.ids, s.argIds, s.protectedTools]) for (const x of set) expect(typeof x).toBe("string");
	});

	// Found by fuzzing: one Infinity (or sums overflowing on huge values) made the ratio NaN for the rest of the session.
	it("Calibrator ignores samples that are not finite", () => {
		const c = new Calibrator();
		for (let i = 1; i <= 8; i++) c.add(i * 3000, i * 1000);
		c.add(Infinity, 5);
		c.add(5, NaN);
		expect(c.samples()).toBe(8);
		expect(c.charsPerToken()).toBeCloseTo(3);
		const huge = new Calibrator();
		for (let i = 1; i <= 8; i++) huge.add(1e307 * i, 1e306 * i);
		expect(huge.charsPerToken()).toBe(3);
		expect(huge.isMeasured()).toBe(false);
	});

	fuzz("Calibrator always reports a usable chars-per-token ratio", (g) => {
		const c = new Calibrator();
		const base = 1 + g.r() * 5;
		for (let i = 0; i < g.int(30); i++) {
			const chars = g.r() < 0.8 ? g.int(2_000_000) : g.number();
			c.add(chars, g.r() < 0.8 ? chars / base + g.int(5000) : g.number());
		}
		const cpt = c.charsPerToken();
		expect(Number.isFinite(cpt) && cpt >= 1.5 && cpt <= 8).toBe(true);
	});

	fuzz("RecoveryMeter and statusLine cope with any calls", (g) => {
		const meter = new RecoveryMeter();
		const infos = Array.from({ length: g.int(10) }, (_, i) => ({ id: `c${i}`, tool: g.pick(TOOLS), sig: "", chars: g.int(10_000) }));
		meter.track(infos.map((x) => ({ ...x, sig: `${x.tool}:{}` })));
		for (let i = 0; i < g.int(10); i++) meter.onCall(g.pick(TOOLS), g.r() < 0.5 ? {} : g.value());
		for (const t of TOOLS) expect(typeof meter.shouldProtect(t, g.r())).toBe("boolean");
		const config = randomConfig(g);
		const stats = { requests: g.int(100), cumulativeChars: g.int(1e7), lastChars: g.int(1e6), lastCount: g.int(50), lastArgCount: g.int(5), coldStarts: g.int(5) };
		const line = statusLine(config, stats, { recovered: g.int(5), elided: g.int(10), recoveredChars: g.int(1e5), protectedTools: [] }, { charsPerToken: 1.5 + g.r() * 6, samples: g.int(20), measured: g.r() < 0.5 });
		expect(line).not.toContain("NaN");
	});
});
