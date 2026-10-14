/**
 * pi-context-diet: cut token spend on long sessions by eliding stale tool results.
 *
 * Why: pi re-sends the whole history on every turn, and nearly all of that is served from the
 * prompt cache. In a long session old tool output (build logs, file dumps) is re-read hundreds of
 * times. Removing it saves a lot, but editing old history normally throws the cache away, which
 * costs more than it saves.
 *
 * The trick: do it only when the cache is ALREADY cold (the last assistant message is older than
 * the cache TTL). The whole prefix has to be rewritten at that point anyway, so a shorter one is
 * free. The set of elided results is decided once, at that moment, and then applied unchanged on
 * every later request, so the prefix stays byte-stable and cacheable until the next cold start.
 *
 * Zero prompt tokens: it only rewrites the messages of a request, never the system prompt, and the
 * saved transcript on disk is untouched.
 *
 * Three things keep it safe and cheap:
 *   - stubs carry a preview (the last lines and any error lines), so an exit status or a failure survives;
 *   - a recovery meter notices when the agent re-fetches something that was elided, shows the real cost,
 *     and stops eliding a tool whose results keep being needed;
 *   - stale `write` / `edit` arguments are elided too (the file on disk is the source of truth).
 *
 * Commands:
 *   /context-diet                 status and savings
 *   /context-diet on | off        turn it on / off (remembered)
 *   /context-diet now             elide stale results on the next request (accepts one cache rewrite)
 *   /context-diet keep <turns>    always keep the results of the last N assistant turns
 *   /context-diet ttl <minutes>   how long the prompt cache lives (5 for Anthropic, 60 for extended)
 *   /context-diet mode <cold|always>
 *   /context-diet args <on|off>   also elide stale write / edit arguments
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type Mode = "cold" | "always";

export interface DietConfig {
	enabled: boolean;
	/** `cold`: elide only when the prompt cache has expired (free). `always`: elide whenever eligible (for providers without prompt caching). */
	mode: Mode;
	/** Results of the last N assistant turns are always kept. */
	keepTurns: number;
	/** Results smaller than this many characters are not worth a stub. */
	minChars: number;
	/** Prompt-cache lifetime; a longer pause than this means the cache is cold. */
	cacheTtlMinutes: number;
	/** Keep results flagged as errors (they are usually short and important). */
	keepErrors: boolean;
	/** Tool names whose results are never elided. */
	neverElide: string[];
	showStatus: boolean;
	/** Lines from the end of an elided output that stay in its stub. */
	stubTailLines: number;
	/** Lines mentioning an error (up to this many) that stay in a stub. */
	stubErrorLines: number;
	/** Also elide stale `write` content and `edit` old/new text from the tool calls. */
	elideArgs: boolean;
	/** Stop eliding a tool for the rest of the session when its results keep being re-fetched. */
	autoProtect: boolean;
	/** Share of a tool's elided results that were re-fetched before it is protected (needs a few samples). */
	recoveryThreshold: number;
	/** Let pi's idle cache warmer be overridden: stop warming when letting the cache expire and eliding is cheaper. */
	warmArbitration: boolean;
	/** Turns still expected in a session, for the warm-or-stop estimate. */
	expectedTurns: number;
	/** Without model prices: stop warming when at least this share of the context is stale. */
	stopWarmingShare: number;
	/** Compact the history with pi's own compaction when the session is idle and big (opt-in; lossy). */
	compact: boolean;
	/** Context size, in tokens, above which an idle session is compacted. */
	compactAboveTokens: number;
}

export const DEFAULT_CONFIG: DietConfig = {
	enabled: true,
	mode: "cold",
	keepTurns: 20,
	minChars: 1500,
	cacheTtlMinutes: 5,
	keepErrors: true,
	neverElide: [],
	showStatus: true,
	stubTailLines: 3,
	stubErrorLines: 3,
	elideArgs: true,
	autoProtect: true,
	recoveryThreshold: 0.25,
	warmArbitration: true,
	expectedTurns: 30,
	stopWarmingShare: 0.2,
	compact: false,
	compactAboveTokens: 150_000,
};

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** A hand-edited config file can hold anything: keep only valid values, default the rest. */
export function sanitizeConfig(raw: unknown): DietConfig {
	const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_CONFIG;
	return {
		enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
		mode: r.mode === "cold" || r.mode === "always" ? r.mode : d.mode,
		keepTurns: clampInt(r.keepTurns, 1, 500, d.keepTurns),
		minChars: clampInt(r.minChars, 200, 1_000_000, d.minChars),
		cacheTtlMinutes: clampInt(r.cacheTtlMinutes, 1, 1440, d.cacheTtlMinutes),
		keepErrors: typeof r.keepErrors === "boolean" ? r.keepErrors : d.keepErrors,
		neverElide: Array.isArray(r.neverElide)
			? [...new Set(r.neverElide.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))].slice(0, 50)
			: [],
		showStatus: typeof r.showStatus === "boolean" ? r.showStatus : d.showStatus,
		stubTailLines: clampInt(r.stubTailLines, 0, 10, d.stubTailLines),
		stubErrorLines: clampInt(r.stubErrorLines, 0, 10, d.stubErrorLines),
		elideArgs: typeof r.elideArgs === "boolean" ? r.elideArgs : d.elideArgs,
		autoProtect: typeof r.autoProtect === "boolean" ? r.autoProtect : d.autoProtect,
		recoveryThreshold:
			typeof r.recoveryThreshold === "number" && Number.isFinite(r.recoveryThreshold)
				? Math.min(1, Math.max(0.05, r.recoveryThreshold))
				: d.recoveryThreshold,
		warmArbitration: typeof r.warmArbitration === "boolean" ? r.warmArbitration : d.warmArbitration,
		expectedTurns: clampInt(r.expectedTurns, 1, 500, d.expectedTurns),
		stopWarmingShare:
			typeof r.stopWarmingShare === "number" && Number.isFinite(r.stopWarmingShare)
				? Math.min(0.9, Math.max(0.05, r.stopWarmingShare))
				: d.stopWarmingShare,
		compact: typeof r.compact === "boolean" ? r.compact : d.compact,
		compactAboveTokens: clampInt(r.compactAboveTokens, 20_000, 2_000_000, d.compactAboveTokens),
	};
}

/** Where pi keeps its config: PI_CODING_AGENT_DIR, then $XDG_CONFIG_HOME/pi/agent, then ~/.pi/agent. */
export function resolveAgentDir(env: Record<string, string | undefined>, home: string): string {
	if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
	if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pi", "agent");
	return join(home, ".pi", "agent");
}

const configPath = () => join(resolveAgentDir(process.env, homedir()), "context-diet.json");

export async function loadConfig(): Promise<DietConfig> {
	try {
		return sanitizeConfig(JSON.parse(await readFile(configPath(), "utf8")));
	} catch {
		return sanitizeConfig({});
	}
}

export async function saveConfig(config: DietConfig): Promise<void> {
	await mkdir(resolveAgentDir(process.env, homedir()), { recursive: true });
	await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Messages: what a tool result weighs, what it was, whether it is stale
// ---------------------------------------------------------------------------

/** The few fields of pi's messages this extension reads. Everything else is passed through untouched. */
export interface Message {
	role: string;
	timestamp?: number;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	[key: string]: unknown;
}

interface Part {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

const partsOf = (content: unknown): Part[] => (Array.isArray(content) ? (content as Part[]) : []);

/** Size of a tool result's text, and whether it is text only (images are never elided). */
export function measure(content: unknown): { chars: number; lines: number; textOnly: boolean } {
	if (typeof content === "string") return { chars: content.length, lines: lineCount(content), textOnly: true };
	let chars = 0;
	let lines = 0;
	let textOnly = true;
	for (const p of partsOf(content)) {
		if (p?.type === "text" && typeof p.text === "string") {
			chars += p.text.length;
			lines += lineCount(p.text);
		} else textOnly = false;
	}
	return { chars, lines, textOnly };
}

const lineCount = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

/** toolCallId → the call that produced it, found in the assistant messages. */
export function indexCalls(messages: Message[]): Map<string, { name: string; args: Record<string, unknown> }> {
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	for (const m of messages) {
		if (m?.role !== "assistant") continue;
		for (const p of partsOf(m.content)) {
			if (p?.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string") {
				calls.set(p.id, { name: p.name, args: p.arguments ?? {} });
			}
		}
	}
	return calls;
}

const clip = (s: string, n: number) => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** A short label for what was run: the command, the path, the pattern. */
export function describeCall(name: string, args: Record<string, unknown>): string {
	const first = (...keys: string[]) => {
		for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k] as string;
		return "";
	};
	const label = name === "bash" ? first("command") : first("path", "file_path", "pattern", "query", "command", "url");
	return label ? clip(label, 80) : "";
}

export function formatSize(chars: number): string {
	if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
	if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)} KB`;
	return `${chars} B`;
}

/** What survives of an elided output: its last lines and the lines that mention an error. */
export interface Preview {
	tail: string[];
	errors: string[];
}

/** Lines worth keeping from a long output: errors, failures, exceptions (TypeError, AssertionError…). */
const ERROR_LINE = /(error|fail|exception|panic|fatal|traceback|assertion)/i;
/** ...except summaries that say nothing went wrong ("0 failed", "0 errors"). */
const ALL_CLEAR = /\b0 (errors?|failed|failures?|failing)\b/i;
const PREVIEW_LINE_CHARS = 160;

/** Deterministic: derived only from the original output, so the same result always gives the same preview. */
export function previewOf(content: unknown, tailLines: number, errorLines: number): Preview {
	if (tailLines <= 0 && errorLines <= 0) return { tail: [], errors: [] };
	const text = typeof content === "string" ? content : partsOf(content).map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : "")).join("\n");
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	const clipLine = (l: string) => (l.length > PREVIEW_LINE_CHARS ? l.slice(0, PREVIEW_LINE_CHARS - 1) + "…" : l);
	const tail = tailLines > 0 ? lines.slice(-tailLines) : [];
	const errors = errorLines > 0 ? lines.filter((l, i) => ERROR_LINE.test(l) && !ALL_CLEAR.test(l) && !(tailLines > 0 && i >= lines.length - tailLines)).slice(-errorLines) : [];
	return { tail: tail.map(clipLine), errors: errors.map(clipLine) };
}

/** Deterministic: the same inputs always give the same text, so the prompt prefix stays stable. */
export function stubText(name: string, label: string, chars: number, lines: number, preview?: Preview): string {
	const what = label ? `${name} ${label}` : name;
	let out = `[pi-context-diet: the output of ${what} (${formatSize(chars)}, ${lines} lines) was elided from the context to save tokens. Re-run it if you need it again.`;
	if (preview?.errors.length) out += `\nerror lines:\n${preview.errors.map((l) => `  ${l}`).join("\n")}`;
	if (preview?.tail.length) out += `\nlast lines:\n${preview.tail.map((l) => `  ${l}`).join("\n")}`;
	return out + "]";
}

/** Assistant messages with thinking blocks must be sent back byte-identical (signed), so they are never rewritten. */
export function hasThinking(m: Message): boolean {
	return partsOf(m.content).some((p) => p?.type === "thinking" || p?.type === "redacted_thinking");
}

/** For every message, how many assistant messages come after it. */
export function assistantTurnsAfter(messages: Message[]): number[] {
	const ages = new Array<number>(messages.length).fill(0);
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		ages[i] = seen;
		if (messages[i].role === "assistant") seen++;
	}
	return ages;
}

/** Until calibrated from real usage: measured 2.0 to 3.0 on real sessions; 4 would under-count tool output. */
export const DEFAULT_CHARS_PER_TOKEN = 3;
export const estimateTokens = (chars: number, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN) => Math.round(chars / charsPerToken);

export function formatTokens(n: number): string {
	if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
	return String(n);
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export interface Policy {
	keepTurns: number;
	minChars: number;
	keepErrors: boolean;
	neverElide: ReadonlySet<string>;
}

/** `protectedTools` are tools protected for this session by the recovery meter, on top of the configured ones. */
export const policyOf = (c: DietConfig, protectedTools: Iterable<string> = []): Policy => ({
	keepTurns: c.keepTurns,
	minChars: c.minChars,
	keepErrors: c.keepErrors,
	neverElide: new Set([...c.neverElide, ...protectedTools]),
});

/** Tool results that may be elided now: old enough, big enough, plain text, not an error, not protected. */
export function eligible(messages: Message[], policy: Policy, already: ReadonlySet<string>): string[] {
	const ages = assistantTurnsAfter(messages);
	const ids: string[] = [];
	messages.forEach((m, i) => {
		if (m.role !== "toolResult" || typeof m.toolCallId !== "string") return;
		if (already.has(m.toolCallId) || ages[i] <= policy.keepTurns) return;
		if (m.isError && policy.keepErrors) return;
		if (m.toolName && policy.neverElide.has(m.toolName)) return;
		const size = measure(m.content);
		if (!size.textOnly || size.chars < policy.minChars) return;
		ids.push(m.toolCallId);
	});
	return ids;
}

export function lastAssistantTimestamp(messages: Message[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && typeof m.timestamp === "number") return m.timestamp;
	}
	return undefined;
}

/** The prompt cache is cold when the last assistant message is older than its lifetime. */
export function isCold(messages: Message[], now: number, ttlMs: number): boolean {
	const last = lastAssistantTimestamp(messages);
	return last !== undefined && now - last > ttlMs;
}

// ---------------------------------------------------------------------------
// Stale write / edit arguments
// ---------------------------------------------------------------------------

/** Tools whose arguments carry file content that the file on disk already holds. */
export const ARG_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

interface EditArg {
	oldText?: unknown;
	newText?: unknown;
	[key: string]: unknown;
}

const strLen = (v: unknown) => (typeof v === "string" ? v.length : 0);

/** How many characters of file content a write / edit call carries. */
export function argChars(name: string, args: Record<string, unknown> | undefined): number {
	if (!args) return 0;
	if (name === "write") return strLen(args.content);
	let n = strLen(args.oldText) + strLen(args.newText);
	if (Array.isArray(args.edits)) for (const e of args.edits as EditArg[]) n += strLen(e?.oldText) + strLen(e?.newText);
	return n;
}

const elidedArg = (v: unknown, path: string) => {
	const text = typeof v === "string" ? v : "";
	return `[pi-context-diet: ${lineCount(text)} lines (${formatSize(text.length)}) of ${path || "the file"} elided; the file on disk is authoritative]`;
};

/** The same call with its bulky content replaced by a short placeholder. */
export function elideArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
	if (name === "write") return typeof args.content === "string" ? { ...args, content: elidedArg(args.content, path) } : args;
	const out: Record<string, unknown> = { ...args };
	if (typeof out.oldText === "string") out.oldText = elidedArg(out.oldText, path);
	if (typeof out.newText === "string") out.newText = elidedArg(out.newText, path);
	if (Array.isArray(args.edits)) {
		out.edits = (args.edits as EditArg[]).map((e) =>
			e && typeof e === "object" ? { ...e, ...(typeof e.oldText === "string" ? { oldText: elidedArg(e.oldText, path) } : {}), ...(typeof e.newText === "string" ? { newText: elidedArg(e.newText, path) } : {}) } : e,
		);
	}
	return out;
}

/** Tool-call ids whose write / edit arguments may be elided: old enough, big enough, and the call succeeded. */
export function eligibleArgs(messages: Message[], policy: Policy, already: ReadonlySet<string>): string[] {
	const ages = assistantTurnsAfter(messages);
	const failed = new Set<string>();
	const answered = new Set<string>();
	for (const m of messages) {
		if (m.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
		answered.add(m.toolCallId);
		if (m.isError) failed.add(m.toolCallId);
	}
	const ids: string[] = [];
	messages.forEach((m, i) => {
		if (m.role !== "assistant" || ages[i] <= policy.keepTurns) return;
		if (hasThinking(m)) return; // signed thinking blocks: the API rejects any edit to the message
		for (const p of partsOf(m.content)) {
			if (p?.type !== "toolCall" || typeof p.id !== "string" || typeof p.name !== "string") continue;
			if (!ARG_TOOLS.has(p.name) || policy.neverElide.has(p.name) || already.has(p.id)) continue;
			if (!answered.has(p.id) || failed.has(p.id)) continue; // a failed or unanswered call may be retried: keep it
			if (argChars(p.name, p.arguments) < policy.minChars) continue;
			ids.push(p.id);
		}
	});
	return ids;
}

/** Which new results (and write / edit arguments) to elide on this request. None unless the cache is cold, it was forced, or mode is `always`. */
export function decide(
	messages: Message[],
	elided: ReadonlySet<string>,
	config: DietConfig,
	ctx: { now: number; force: boolean },
	extra: { elidedArgs?: ReadonlySet<string>; protectedTools?: Iterable<string> } = {},
): { ids: string[]; argIds: string[]; cold: boolean } {
	if (!config.enabled) return { ids: [], argIds: [], cold: false };
	const cold = isCold(messages, ctx.now, config.cacheTtlMinutes * 60_000);
	if (!(ctx.force || cold || config.mode === "always")) return { ids: [], argIds: [], cold };
	const policy = policyOf(config, extra.protectedTools);
	return {
		ids: eligible(messages, policy, elided),
		argIds: config.elideArgs ? eligibleArgs(messages, policy, extra.elidedArgs ?? new Set()) : [],
		cold,
	};
}

// ---------------------------------------------------------------------------
// Applying the elision
// ---------------------------------------------------------------------------

/** Stable JSON: object keys sorted, so the same call always gives the same signature. */
export function stableStringify(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
	}
	return JSON.stringify(v) ?? "null";
}

export const callSignature = (name: string, args: unknown) => `${name}:${stableStringify(args ?? {})}`;

/** An elided tool result, remembered so a later identical call can be recognised as a re-fetch. */
export interface ElidedInfo {
	id: string;
	tool: string;
	sig: string;
	chars: number;
}

export interface ApplyOptions {
	argIds?: ReadonlySet<string>;
	preview?: { tail: number; errors: number };
}

/** Replace the chosen results (and arguments) with stubs. Original messages are never mutated; untouched ones are shared. */
export function applyElision(
	messages: Message[],
	elided: ReadonlySet<string>,
	opts: ApplyOptions = {},
): { messages: Message[]; count: number; argCount: number; savedChars: number; infos: ElidedInfo[] } {
	const argIds = opts.argIds ?? new Set<string>();
	if (elided.size === 0 && argIds.size === 0) return { messages, count: 0, argCount: 0, savedChars: 0, infos: [] };
	const calls = indexCalls(messages);
	let count = 0;
	let argCount = 0;
	let savedChars = 0;
	const infos: ElidedInfo[] = [];
	const out = messages.map((m) => {
		if (m.role === "toolResult" && typeof m.toolCallId === "string" && elided.has(m.toolCallId)) {
			const size = measure(m.content);
			if (!size.textOnly) return m;
			const call = calls.get(m.toolCallId);
			const tool = m.toolName ?? call?.name ?? "tool";
			const preview = opts.preview ? previewOf(m.content, opts.preview.tail, opts.preview.errors) : undefined;
			const text = stubText(tool, call ? describeCall(call.name, call.args) : "", size.chars, size.lines, preview);
			count++;
			savedChars += Math.max(0, size.chars - text.length);
			if (call) infos.push({ id: m.toolCallId, tool, sig: callSignature(call.name, call.args), chars: size.chars });
			return { ...m, content: [{ type: "text", text }] };
		}
		if (m.role === "assistant" && argIds.size > 0 && Array.isArray(m.content) && !hasThinking(m)) {
			let changed = false;
			const content = (m.content as Part[]).map((p) => {
				if (p?.type !== "toolCall" || typeof p.id !== "string" || typeof p.name !== "string" || !argIds.has(p.id) || !p.arguments) return p;
				const before = JSON.stringify(p.arguments).length;
				const next = elideArguments(p.name, p.arguments);
				if (next === p.arguments) return p;
				changed = true;
				argCount++;
				savedChars += Math.max(0, before - JSON.stringify(next).length);
				return { ...p, arguments: next };
			});
			return changed ? { ...m, content } : m;
		}
		return m;
	});
	return count + argCount === 0 ? { messages, count: 0, argCount: 0, savedChars: 0, infos: [] } : { messages: out, count, argCount, savedChars, infos };
}

// ---------------------------------------------------------------------------
// Calibration: how many characters make a token, measured from real usage
// ---------------------------------------------------------------------------

/** Characters of message content in a request (what the extension can see; the provider adds its own framing). */
export function charsOfMessages(messages: Message[]): number {
	let n = 0;
	for (const m of messages) {
		const c = m?.content;
		n += typeof c === "string" ? c.length : c === undefined || c === null ? 0 : JSON.stringify(c).length;
	}
	return n;
}

/**
 * Learns characters-per-token from (characters sent, tokens the provider billed) pairs of one session:
 * the slope of tokens over characters, so the fixed system prompt drops out as the intercept.
 */
export class Calibrator {
	private readonly points: Array<[number, number]>;

	constructor() {
		this.points = [];
	}

	add(chars: number, tokens: number): void {
		if (chars > 0 && tokens > 0) this.points.push([chars, tokens]);
		if (this.points.length > 200) this.points.shift();
	}

	samples(): number {
		return this.points.length;
	}

	/** Slope of tokens over characters (sxx / sxy), or undefined when there are too few or unusable samples. */
	private measure(): number | undefined {
		const n = this.points.length;
		if (n < 6) return undefined;
		const mx = this.points.reduce((a, p) => a + p[0], 0) / n;
		const my = this.points.reduce((a, p) => a + p[1], 0) / n;
		let sxx = 0;
		let sxy = 0;
		for (const [x, y] of this.points) {
			sxx += (x - mx) ** 2;
			sxy += (x - mx) * (y - my);
		}
		return sxx === 0 || sxy <= 0 ? undefined : sxx / sxy;
	}

	/** True once the ratio comes from the data (enough samples, and tokens that actually grow with characters). */
	isMeasured(): boolean {
		return this.measure() !== undefined;
	}

	/** Characters per token: measured when possible, else the default. Clamped to 1.5..8. */
	charsPerToken(): number {
		const m = this.measure();
		return m === undefined ? DEFAULT_CHARS_PER_TOKEN : Math.min(8, Math.max(1.5, m));
	}
}

// ---------------------------------------------------------------------------
// Show: what is elided right now, and what is next
// ---------------------------------------------------------------------------

export interface Shown {
	kind: "result" | "args";
	tool: string;
	label: string;
	chars: number;
}

/** The biggest things currently elided (results and write/edit arguments), measured from the ORIGINAL messages. */
export function describeElided(messages: Message[], elided: ReadonlySet<string>, elidedArgs: ReadonlySet<string>): Shown[] {
	const calls = indexCalls(messages);
	const out: Shown[] = [];
	for (const m of messages) {
		if (m?.role === "toolResult" && typeof m.toolCallId === "string" && elided.has(m.toolCallId)) {
			const call = calls.get(m.toolCallId);
			out.push({ kind: "result", tool: m.toolName ?? call?.name ?? "tool", label: call ? describeCall(call.name, call.args) : "", chars: measure(m.content).chars });
		} else if (m?.role === "assistant") {
			for (const p of partsOf(m.content)) {
				if (p?.type === "toolCall" && typeof p.id === "string" && elidedArgs.has(p.id) && typeof p.name === "string") {
					out.push({ kind: "args", tool: p.name, label: describeCall(p.name, p.arguments ?? {}), chars: argChars(p.name, p.arguments) });
				}
			}
		}
	}
	return out.sort((a, b) => b.chars - a.chars);
}

/** The next candidates: stale, big, not elided yet (what the next cold start would take). */
export function describeCandidates(messages: Message[], policy: Policy, elided: ReadonlySet<string>, elidedArgs: ReadonlySet<string>, includeArgs: boolean): Shown[] {
	const ids = new Set(eligible(messages, policy, elided));
	const argIds = new Set(includeArgs ? eligibleArgs(messages, policy, elidedArgs) : []);
	return describeElided(messages, ids, argIds);
}

export function showLines(title: string, items: Shown[], limit: number, cpt: number): string[] {
	if (items.length === 0) return [`${title}: none`];
	const total = items.reduce((n, x) => n + x.chars, 0);
	const rows = items.slice(0, limit).map((x) => `  ${x.kind === "args" ? "args " : ""}${x.tool}${x.label ? ` ${x.label}` : ""}  ${formatSize(x.chars)}`);
	const more = items.length > limit ? [`  … and ${items.length - limit} more`] : [];
	return [`${title}: ${items.length} (~${formatTokens(estimateTokens(total, cpt))} tokens)`, ...rows, ...more];
}

// ---------------------------------------------------------------------------
// Cache warming: warm, or let the cache expire and elide?
// ---------------------------------------------------------------------------

/** Tokens of stale, elidable output (results and write/edit arguments) that a cold start would drop. */
export function staleTokens(
	messages: Message[],
	policy: Policy,
	elided: ReadonlySet<string>,
	elidedArgs: ReadonlySet<string>,
	includeArgs: boolean,
	charsPerToken: number,
): number {
	return estimateTokens(
		describeCandidates(messages, policy, elided, elidedArgs, includeArgs).reduce((n, x) => n + x.chars, 0),
		charsPerToken,
	);
}

export interface WarmInput {
	/** Pi's own decision. */
	action: "warm" | "stop";
	/** Pi's estimates, in dollars: the price of this refresh, the extra price of the next request if the cache is lost, and the chance a request arrives in time. */
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	staleTokens: number;
	contextTokens: number | null;
	/** Model prices, dollars per million tokens, when known. */
	prices?: { cacheRead: number; cacheWrite: number };
	expectedTurns: number;
	shareFallback: number;
}

/**
 * Pi warms an idle cache to avoid a rewrite. But a cold cache is the free moment to drop stale output, so when
 * enough of the context is stale, letting it expire is cheaper. Stopping is chosen when
 *   warmCost + p·S·(R·T + W)  >  p·missCost
 * (S stale tokens, R / W cache read / write price, T expected remaining turns, p the chance the user returns in
 * time): the refresh is saved for sure, and a returning user pays a rewrite of the SLIMMER context but then reads
 * S fewer tokens on every later turn. Never turns a "stop" into a "warm": warming costs money.
 */
export function shouldStopWarming(i: WarmInput): boolean {
	if (i.action !== "warm" || i.staleTokens <= 0) return false;
	const priced = !!i.prices && i.prices.cacheRead > 0 && i.prices.cacheWrite > 0;
	if (priced && Number.isFinite(i.warmCost) && Number.isFinite(i.missCost) && i.missCost > 0 && Number.isFinite(i.continuationProbability)) {
		const R = i.prices!.cacheRead / 1e6;
		const W = i.prices!.cacheWrite / 1e6;
		const p = Math.min(1, Math.max(0, i.continuationProbability));
		return i.warmCost + p * i.staleTokens * (R * i.expectedTurns + W) > p * i.missCost;
	}
	return (i.contextTokens ?? 0) > 0 && i.staleTokens / (i.contextTokens as number) >= i.shareFallback;
}

// ---------------------------------------------------------------------------
// Compaction (opt-in)
// ---------------------------------------------------------------------------

/** Instructions for pi's own summariser: keep what the work needs, drop the raw output. */
export const COMPACT_INSTRUCTIONS =
	"Summarise this session so the work can continue. Keep: file paths and function names, decisions and why they were made, open tasks and next steps, errors that were hit and how they were fixed, and the user's preferences. Drop: raw tool output, logs, and exploration that led nowhere.";

/** Turns that must pass after a compaction before another one. */
export const COMPACT_COOLDOWN_TURNS = 20;

export function shouldCompact(i: {
	enabled: boolean;
	compact: boolean;
	tokens: number | null;
	threshold: number;
	turnsSinceCompaction: number;
	idle: boolean;
	pending: boolean;
	inFlight: boolean;
}): boolean {
	return i.enabled && i.compact && !i.inFlight && i.idle && !i.pending && i.tokens !== null && i.tokens >= i.threshold && i.turnsSinceCompaction >= COMPACT_COOLDOWN_TURNS;
}

// ---------------------------------------------------------------------------
// Recovery meter: did the agent need what was elided?
// ---------------------------------------------------------------------------

/**
 * Remembers what was elided and notices when the agent re-issues the identical call. Each such re-fetch
 * costs the output again, so the meter turns "did this hurt?" into a number, and it can tell which tool
 * to stop eliding.
 */
export class RecoveryMeter {
	private readonly bySig: Map<string, ElidedInfo[]>;
	private readonly tracked: Set<string>;
	private readonly counted: Set<string>;
	readonly perTool: Map<string, { elided: number; recovered: number }>;
	recovered: number;
	recoveredChars: number;

	constructor() {
		this.bySig = new Map();
		this.tracked = new Set();
		this.counted = new Set();
		this.perTool = new Map();
		this.recovered = 0;
		this.recoveredChars = 0;
	}

	/** Idempotent: call it with everything currently elided on each request. */
	track(infos: ElidedInfo[]): void {
		for (const info of infos) {
			if (this.tracked.has(info.id)) continue;
			this.tracked.add(info.id);
			(this.bySig.get(info.sig) ?? this.bySig.set(info.sig, []).get(info.sig)!).push(info);
			const t = this.perTool.get(info.tool) ?? { elided: 0, recovered: 0 };
			t.elided++;
			this.perTool.set(info.tool, t);
		}
	}

	/** A tool is about to run: is it the identical call to something that was elided (and not yet counted)? */
	onCall(tool: string, args: unknown): ElidedInfo | undefined {
		const matches = this.bySig.get(callSignature(tool, args));
		const hit = matches?.find((m) => !this.counted.has(m.id));
		if (!hit) return undefined;
		for (const m of matches!) this.counted.add(m.id); // one call answers every elided copy of the same output
		this.recovered++;
		this.recoveredChars += hit.chars;
		const t = this.perTool.get(hit.tool);
		if (t) t.recovered++;
		return hit;
	}

	elided(): number {
		return this.tracked.size;
	}

	/** True when this tool's results keep being re-fetched: enough samples and a high enough share. */
	shouldProtect(tool: string, threshold: number, minSample = 5): boolean {
		const t = this.perTool.get(tool);
		return !!t && t.elided >= minSample && t.recovered / t.elided > threshold;
	}
}

// ---------------------------------------------------------------------------
// Persistence: the elided set survives resume, so the prefix stays stable
// ---------------------------------------------------------------------------

export const ENTRY_TYPE = "context-diet";
export const PROTECT_ENTRY_TYPE = "context-diet-protect";

/** Rebuild this extension's state from the session's custom entries (resume, fork). */
export function restoreState(entries: unknown[]): { ids: Set<string>; argIds: Set<string>; protectedTools: Set<string> } {
	const state = { ids: new Set<string>(), argIds: new Set<string>(), protectedTools: new Set<string>() };
	for (const e of entries) {
		const entry = e as { type?: string; customType?: string; data?: { ids?: unknown; argIds?: unknown; tool?: unknown } } | null;
		if (entry?.type !== "custom") continue;
		if (entry.customType === ENTRY_TYPE) {
			for (const [key, into] of [["ids", state.ids], ["argIds", state.argIds]] as const) {
				const list = entry.data?.[key];
				if (Array.isArray(list)) for (const id of list) if (typeof id === "string") into.add(id);
			}
		} else if (entry.customType === PROTECT_ENTRY_TYPE && typeof entry.data?.tool === "string") {
			state.protectedTools.add(entry.data.tool);
		}
	}
	return state;
}

export const restoreIds = (entries: unknown[]): Set<string> => restoreState(entries).ids;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
	| { kind: "status" }
	| { kind: "on" }
	| { kind: "off" }
	| { kind: "now" }
	| { kind: "keep"; turns: number }
	| { kind: "ttl"; minutes: number }
	| { kind: "mode"; mode: Mode }
	| { kind: "args"; on: boolean }
	| { kind: "show" }
	| { kind: "compact"; action: "on" | "off" | "now" }
	| { kind: "invalid"; message: string };

export const USAGE =
	"Usage: /context-diet [status] · on · off · now · keep <turns> · ttl <minutes> · mode <cold|always> · args <on|off> · show · compact <on|off|now>";

export function parseCommand(args: string | undefined): Command {
	const [cmd, p1] = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
	switch (cmd) {
		case undefined:
		case "status":
			return { kind: "status" };
		case "on":
		case "enable":
			return { kind: "on" };
		case "off":
		case "disable":
			return { kind: "off" };
		case "now":
			return { kind: "now" };
		case "keep": {
			const n = Number(p1);
			return Number.isInteger(n) && n >= 1 && n <= 500
				? { kind: "keep", turns: n }
				: { kind: "invalid", message: "Usage: /context-diet keep <turns> (1 to 500)" };
		}
		case "ttl": {
			const n = Number(p1);
			return Number.isInteger(n) && n >= 1 && n <= 1440
				? { kind: "ttl", minutes: n }
				: { kind: "invalid", message: "Usage: /context-diet ttl <minutes> (1 to 1440)" };
		}
		case "mode":
			return p1 === "cold" || p1 === "always"
				? { kind: "mode", mode: p1 }
				: { kind: "invalid", message: "Usage: /context-diet mode <cold|always>" };
		case "show":
			return { kind: "show" };
		case "compact":
			return p1 === "on" || p1 === "off" || p1 === "now"
				? { kind: "compact", action: p1 }
				: { kind: "invalid", message: "Usage: /context-diet compact <on|off|now>" };
		case "args":
			return p1 === "on" || p1 === "off"
				? { kind: "args", on: p1 === "on" }
				: { kind: "invalid", message: "Usage: /context-diet args <on|off>" };
		default:
			return { kind: "invalid", message: `Unknown option "${cmd}". ${USAGE}` };
	}
}

export interface CompletionItem {
	value: string;
	/** Required by pi: it calls `label.endsWith(...)` when applying a completion. */
	label: string;
	description?: string;
}

const TOP_LEVEL: CompletionItem[] = [
	{ value: "status", label: "status", description: "Show settings and savings" },
	{ value: "on", label: "on", description: "Turn context-diet on" },
	{ value: "off", label: "off", description: "Turn it off (nothing is elided)" },
	{ value: "now", label: "now", description: "Elide stale results on the next request (one cache rewrite)" },
	{ value: "keep ", label: "keep", description: "Always keep the last N assistant turns" },
	{ value: "ttl ", label: "ttl", description: "Prompt-cache lifetime in minutes" },
	{ value: "mode ", label: "mode", description: "cold (free) or always" },
	{ value: "args ", label: "args", description: "Also elide stale write/edit arguments (on or off)" },
	{ value: "show", label: "show", description: "List what is elided and what is next" },
	{ value: "compact ", label: "compact", description: "Compact an idle, big session (opt-in): on, off or now" },
];

/** `prefix` is the whole argument text typed so far (pi replaces it with `value`). */
export function completions(prefix: string): CompletionItem[] | null {
	const text = (prefix ?? "").toLowerCase().replace(/^\s+/, "");
	const pool: CompletionItem[] = text.startsWith("mode ")
		? [
				{ value: "mode cold", label: "cold", description: "Elide only when the prompt cache is already cold (free)" },
				{ value: "mode always", label: "always", description: "Elide whenever eligible (providers without prompt caching)" },
			]
		: text.startsWith("compact ")
			? [
					{ value: "compact on", label: "on", description: "Compact the history when idle and over the size limit" },
					{ value: "compact off", label: "off", description: "Never compact automatically" },
					{ value: "compact now", label: "now", description: "Compact the session right now (needs an idle session)" },
				]
			: text.startsWith("args ")
			? [
					{ value: "args on", label: "on", description: "Elide stale write content and edit old/new text" },
					{ value: "args off", label: "off", description: "Keep write and edit arguments in the context" },
				]
			: TOP_LEVEL;
	const out = pool.filter((i) => i.value.startsWith(text));
	return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export interface Stats {
	requests: number;
	cumulativeChars: number;
	lastChars: number;
	lastCount: number;
	lastArgCount: number;
	coldStarts: number;
	warmStops?: number;
	compactions?: number;
}

const emptyStats = (): Stats => ({ requests: 0, cumulativeChars: 0, lastChars: 0, lastCount: 0, lastArgCount: 0, coldStarts: 0 });

export interface RecoverySummary {
	recovered: number;
	elided: number;
	recoveredChars: number;
	protectedTools: string[];
}

export interface Extra {
	charsPerToken: number;
	samples: number;
	measured: boolean;
}

export function statusLine(config: DietConfig, stats: Stats, recovery?: RecoverySummary, extra?: Extra): string {
	const cpt = extra?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
	const head = `pi-context-diet: ${config.enabled ? "on" : "off"} · mode ${config.mode} · keep last ${config.keepTurns} turns · cache ttl ${config.cacheTtlMinutes} min · min ${formatSize(config.minChars)} · write/edit args ${config.elideArgs ? "elided" : "kept"}`;
	const args = stats.lastArgCount > 0 ? ` + ${stats.lastArgCount} write/edit arguments` : "";
	const body = `this session: ${stats.lastCount} results${args} elided (~${formatTokens(estimateTokens(stats.lastChars, cpt))} tokens kept out of every request), ~${formatTokens(estimateTokens(stats.cumulativeChars, cpt))} tokens saved over ${stats.requests} requests · ${stats.coldStarts} cold start${stats.coldStarts === 1 ? "" : "s"}`;
	const lines = [head, body];
	if (extra) {
		const calibrated = extra.measured
			? `${extra.charsPerToken.toFixed(2)} chars/token measured from ${extra.samples} requests`
			: extra.samples < 6
				? `${extra.charsPerToken.toFixed(2)} chars/token assumed (calibrating: ${extra.samples} of 6 requests)`
				: `${extra.charsPerToken.toFixed(2)} chars/token assumed (the provider's usage did not vary with context size)`;
		const warm = config.warmArbitration ? `warming: stopped ${stats.warmStops ?? 0}×, when letting the cache expire is cheaper` : "warming: not arbitrated";
		const compaction = config.compact ? `compaction: on above ${formatTokens(config.compactAboveTokens)} tokens, ${stats.compactions ?? 0} done` : "compaction: off (opt-in)";
		lines.push(`${calibrated} · ${warm} · ${compaction}`);
	}
	if (!recovery) return lines.join("\n");
	const rate = recovery.elided > 0 ? Math.round((100 * recovery.recovered) / recovery.elided) : 0;
	const guard = recovery.protectedTools.length > 0 ? ` · protected: ${recovery.protectedTools.join(", ")}` : "";
	const rec = `recovery: ${recovery.recovered} of ${recovery.elided} elided results re-fetched (${rate}%, ~${formatTokens(estimateTokens(recovery.recoveredChars, cpt))} tokens to re-fetch, once)${guard}`;
	lines.push(rec);
	return lines.join("\n");
}

/** Timing knobs (exported so tests can shorten them). */
export const timing = { compactDelayMs: 750 };

export default function contextDiet(pi: ExtensionAPI) {
	let config: DietConfig = sanitizeConfig({});
	let elided = new Set<string>();
	let elidedArgs = new Set<string>();
	let protectedTools = new Set<string>();
	let meter = new RecoveryMeter();
	let stats = emptyStats();
	let force = false;
	let calibrator = new Calibrator();
	let lastMessages: Message[] | undefined;
	let pendingChars = 0;
	let turnsSinceCompaction = COMPACT_COOLDOWN_TURNS;
	let compactInFlight = false;
	let compactTimer: ReturnType<typeof setTimeout> | undefined;
	const cpt = () => calibrator.charsPerToken();

	// The status line is cosmetic: a UI that throws must never change what is sent to the model.
	const showStatus = (ctx: ExtensionContext) => {
		try {
			if (!ctx.hasUI) return;
			if (!config.enabled || !config.showStatus) {
				ctx.ui.setStatus("context-diet", "");
				return;
			}
			const t = ctx.ui.theme;
			// `always` rewrites the prompt cache on every pass: never let it go unnoticed.
			const warn = config.mode === "always" ? t.fg("warning", " ⚠ mode always") : "";
			const compact = config.compact ? t.fg("dim", ` · compact ≥${formatTokens(config.compactAboveTokens)}`) : "";
			if (stats.lastCount + stats.lastArgCount === 0) {
				// Nothing elided yet (in cold mode that is normal until a pause): say it is on, and what a cold start would take.
				const next = lastMessages ? staleTokens(lastMessages, policyOf(config, protectedTools), elided, elidedArgs, config.elideArgs, cpt()) : 0;
				const text = next > 0 ? `${t.fg("accent", `−${formatTokens(next)}`)} ${t.fg("dim", "at the next pause")}` : t.fg("dim", "on");
				ctx.ui.setStatus("context-diet", `${t.fg(warn ? "warning" : "success", "🥗")} ${text}${compact}${warn}`);
				return;
			}
			const recovered = meter.recovered > 0 ? t.fg("warning", ` ↺${meter.recovered}`) : "";
			ctx.ui.setStatus(
				"context-diet",
				`${t.fg("success", "🥗")} ${t.fg("accent", `−${formatTokens(estimateTokens(stats.lastChars, cpt()))}`)} ${t.fg("dim", `/req · ${formatTokens(estimateTokens(stats.cumulativeChars, cpt()))} saved`)}${recovered}${compact}${warn}`,
			);
		} catch {
			/* ignore */
		}
	};

	const summary = (): RecoverySummary => ({
		recovered: meter.recovered,
		elided: meter.elided(),
		recoveredChars: meter.recoveredChars,
		protectedTools: [...protectedTools].sort(),
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		const state = restoreState(ctx.sessionManager?.getEntries?.() ?? []);
		elided = state.ids;
		elidedArgs = state.argIds;
		protectedTools = state.protectedTools;
		meter = new RecoveryMeter();
		stats = emptyStats();
		force = false;
		calibrator = new Calibrator();
		lastMessages = undefined;
		pendingChars = 0;
		turnsSinceCompaction = COMPACT_COOLDOWN_TURNS;
		compactInFlight = false;
		if (compactTimer) clearTimeout(compactTimer);
		compactTimer = undefined;
		showStatus(ctx);
		try {
			if (config.enabled && config.mode === "always" && ctx.hasUI) {
				ctx.ui.notify("context-diet: mode is 'always', which rewrites the prompt cache on every pass. Use it only without prompt caching; switch back with /context-diet mode cold", "warning");
			}
		} catch {
			/* a warning must never break session start */
		}
	});

	// pi misbehaves when a handler throws, so any unexpected error here means "send the conversation unchanged".
	pi.on("context", (event, ctx) => {
		try {
			if (!config.enabled) return undefined;
			const messages = event.messages as unknown as Message[];
			lastMessages = messages;
			const decision = decide(messages, elided, config, { now: Date.now(), force }, { elidedArgs, protectedTools });
			if (decision.ids.length > 0 || decision.argIds.length > 0) {
				for (const id of decision.ids) elided.add(id);
				for (const id of decision.argIds) elidedArgs.add(id);
				pi.appendEntry(ENTRY_TYPE, { ids: decision.ids, argIds: decision.argIds, cold: decision.cold, at: Date.now() });
				if (decision.cold) stats.coldStarts++;
			}
			force = false;
			const result = applyElision(messages, elided, { argIds: elidedArgs, preview: { tail: config.stubTailLines, errors: config.stubErrorLines } });
			pendingChars = charsOfMessages(result.messages);
			if (result.count + result.argCount === 0) {
				showStatus(ctx);
				return undefined;
			}
			meter.track(result.infos);
			stats.requests++;
			stats.lastCount = result.count;
			stats.lastArgCount = result.argCount;
			stats.lastChars = result.savedChars;
			stats.cumulativeChars += result.savedChars;
			showStatus(ctx);
			return { messages: result.messages as unknown as typeof event.messages };
		} catch {
			return undefined;
		}
	});

	// Calibration: the provider's own token count for what we just sent, against the characters we sent.
	// Must return undefined: a message_end handler may otherwise replace the message.
	pi.on("message_end", (event) => {
		try {
			const m = event.message as unknown as { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } | undefined;
			if (m?.role !== "assistant") return undefined;
			turnsSinceCompaction++;
			const u = m.usage;
			const tokens = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
			if (pendingChars > 0 && tokens > 0) calibrator.add(pendingChars, tokens);
			pendingChars = 0;
		} catch {
			/* observing must never break a message */
		}
		return undefined;
	});

	// Pi warms an idle prompt cache to avoid a rewrite. When enough of the context is stale, letting it expire is
	// cheaper (the cold start is the free moment to elide), so this can turn a "warm" into a "stop". Never the reverse.
	pi.on("cache_warming_decision", (event, ctx) => {
		try {
			if (!config.enabled || !config.warmArbitration || config.mode !== "cold" || !lastMessages) return undefined;
			const stale = staleTokens(lastMessages, policyOf(config, protectedTools), elided, elidedArgs, config.elideArgs, cpt());
			const cost = (ctx as unknown as { model?: { cost?: { cacheRead?: number; cacheWrite?: number } } }).model?.cost;
			const stop = shouldStopWarming({
				action: event.action,
				warmCost: event.warmCost,
				missCost: event.missCost,
				continuationProbability: event.continuationProbability,
				staleTokens: stale,
				contextTokens: ctx.getContextUsage()?.tokens ?? null,
				prices: cost && cost.cacheRead && cost.cacheWrite ? { cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } : undefined,
				expectedTurns: config.expectedTurns,
				shareFallback: config.stopWarmingShare,
			});
			if (!stop) return undefined;
			stats.warmStops = (stats.warmStops ?? 0) + 1;
			return { action: "stop" as const };
		} catch {
			return undefined;
		}
	});

	// Compaction (opt-in). ctx.compact() aborts a running agent, so it only ever runs when pi is idle: wait a tick after
	// the run ends (queued work or a retry may follow) and check again.
	// `announce`: an explicit command always answers; an automatic compaction only when there is a UI to tell.
	const startCompaction = (ctx: ExtensionContext, why: string, announce: boolean = ctx.hasUI) => {
		compactInFlight = true;
		if (announce) ctx.ui.notify(`context-diet: compacting the session (${why})`, "info");
		ctx.compact({
			customInstructions: COMPACT_INSTRUCTIONS,
			onComplete: () => {
				compactInFlight = false;
				stats.compactions = (stats.compactions ?? 0) + 1;
				turnsSinceCompaction = 0;
				if (announce) ctx.ui.notify("context-diet: compaction done", "info");
			},
			onError: (error) => {
				compactInFlight = false;
				if (announce) ctx.ui.notify(`context-diet: compaction failed: ${error.message}`, "warning");
			},
		});
	};

	pi.on("agent_end", (_event, ctx) => {
		try {
			if (!config.enabled || !config.compact || compactTimer) return;
			compactTimer = setTimeout(() => {
				compactTimer = undefined;
				try {
					const tokens = ctx.getContextUsage()?.tokens ?? null;
					if (shouldCompact({ enabled: config.enabled, compact: config.compact, tokens, threshold: config.compactAboveTokens, turnsSinceCompaction, idle: ctx.isIdle(), pending: ctx.hasPendingMessages(), inFlight: compactInFlight })) {
						startCompaction(ctx, `context is ${formatTokens(tokens as number)} tokens`);
					}
				} catch {
					/* never break the session */
				}
			}, timing.compactDelayMs);
			(compactTimer as { unref?: () => void }).unref?.();
		} catch {
			/* never break the session */
		}
	});

	pi.on("session_compact", () => {
		turnsSinceCompaction = 0;
	});

	pi.on("session_shutdown", () => {
		if (compactTimer) clearTimeout(compactTimer);
		compactTimer = undefined;
	});

	// Recovery meter: an identical call to something that was elided means the agent needed it again.
	// This handler only observes: it never blocks a tool.
	pi.on("tool_call", (event, ctx) => {
		try {
			if (!config.enabled) return undefined;
			const hit = meter.onCall(event.toolName, event.input);
			if (!hit) return undefined;
			if (config.autoProtect && !protectedTools.has(hit.tool) && meter.shouldProtect(hit.tool, config.recoveryThreshold)) {
				protectedTools.add(hit.tool);
				pi.appendEntry(PROTECT_ENTRY_TYPE, { tool: hit.tool, at: Date.now() });
				const t = meter.perTool.get(hit.tool)!;
				if (ctx.hasUI) ctx.ui.notify(`context-diet: protecting ${hit.tool} results for the rest of the session (${t.recovered} of ${t.elided} elided ones were re-fetched)`, "warning");
			}
			showStatus(ctx);
		} catch {
			/* observing must never break a tool call */
		}
		return undefined;
	});

	pi.registerCommand("context-diet", {
		description: "Elide stale tool results when the prompt cache is cold: status, on/off, now, keep, ttl, mode, args, show, compact",
		getArgumentCompletions: (prefix: string) => completions(prefix),
		handler: async (args, ctx) => {
			const cmd = parseCommand(args);
			const persist = async () => {
				await saveConfig(config);
				showStatus(ctx);
			};
			switch (cmd.kind) {
				case "status":
					ctx.ui.notify(statusLine(config, stats, summary(), { charsPerToken: cpt(), samples: calibrator.samples(), measured: calibrator.isMeasured() }), "info");
					return;
				case "show": {
					if (!lastMessages) {
						ctx.ui.notify("context-diet: nothing to show yet (no request has been made)", "info");
						return;
					}
					const now = describeElided(lastMessages, elided, elidedArgs);
					const next = describeCandidates(lastMessages, policyOf(config, protectedTools), elided, elidedArgs, config.elideArgs);
					ctx.ui.notify([...showLines("elided now", now, 8, cpt()), ...showLines("next cold start would elide", next, 5, cpt())].join("\n"), "info");
					return;
				}
				case "compact":
					if (cmd.action === "now") {
						if (!ctx.isIdle() || compactInFlight) {
							ctx.ui.notify("context-diet: can only compact an idle session", "warning");
							return;
						}
						startCompaction(ctx, "requested", true);
						return;
					}
					config.compact = cmd.action === "on";
					await persist();
					ctx.ui.notify(
						config.compact
							? `context-diet: compaction on: an idle session above ${formatTokens(config.compactAboveTokens)} tokens is compacted with pi's own summariser (lossy: keep an eye on it)`
							: "context-diet: compaction off",
						"info",
					);
					return;
				case "on":
				case "off":
					config.enabled = cmd.kind === "on";
					await persist();
					ctx.ui.notify(`context-diet ${config.enabled ? "on" : "off"}${config.enabled ? "" : " (the next request sends the full history again)"}`, "info");
					return;
				case "now":
					force = true;
					ctx.ui.notify("context-diet: stale results will be elided on the next request (this one request rewrites the cache)", "info");
					return;
				case "keep":
					config.keepTurns = cmd.turns;
					await persist();
					ctx.ui.notify(`context-diet: keeping the results of the last ${cmd.turns} assistant turns`, "info");
					return;
				case "ttl":
					config.cacheTtlMinutes = cmd.minutes;
					await persist();
					ctx.ui.notify(`context-diet: prompt cache assumed to expire after ${cmd.minutes} min`, "info");
					return;
				case "mode":
					config.mode = cmd.mode;
					await persist();
					ctx.ui.notify(
						cmd.mode === "cold"
							? "context-diet: eliding only when the prompt cache is already cold (free)"
							: "context-diet: eliding whenever eligible (use this only without prompt caching: every pass rewrites the cache)",
						"info",
					);
					return;
				case "args":
					config.elideArgs = cmd.on;
					await persist();
					ctx.ui.notify(`context-diet: stale write/edit arguments will ${cmd.on ? "be elided too" : "stay in the context"} (the next cold start decides)`, "info");
					return;
				case "invalid":
					ctx.ui.notify(cmd.message, "warning");
					return;
			}
		},
	});
}
