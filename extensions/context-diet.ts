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
 * Commands:
 *   /context-diet                 status and savings
 *   /context-diet on | off        turn it on / off (remembered)
 *   /context-diet now             elide stale results on the next request (accepts one cache rewrite)
 *   /context-diet keep <turns>    always keep the results of the last N assistant turns
 *   /context-diet ttl <minutes>   how long the prompt cache lives (5 for Anthropic, 60 for extended)
 *   /context-diet mode <cold|always>
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
		if (m.role !== "assistant") continue;
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

/** Deterministic: the same inputs always give the same text, so the prompt prefix stays stable. */
export function stubText(name: string, label: string, chars: number, lines: number): string {
	const what = label ? `${name} ${label}` : name;
	return `[pi-context-diet: the output of ${what} (${formatSize(chars)}, ${lines} lines) was elided from the context to save tokens. Re-run it if you need it again.]`;
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

export const estimateTokens = (chars: number) => Math.round(chars / 4);

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

export const policyOf = (c: DietConfig): Policy => ({
	keepTurns: c.keepTurns,
	minChars: c.minChars,
	keepErrors: c.keepErrors,
	neverElide: new Set(c.neverElide),
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

/** Which new results to elide on this request (none unless the cache is cold, it was forced, or mode is `always`). */
export function decide(
	messages: Message[],
	elided: ReadonlySet<string>,
	config: DietConfig,
	ctx: { now: number; force: boolean },
): { ids: string[]; cold: boolean } {
	if (!config.enabled) return { ids: [], cold: false };
	const cold = isCold(messages, ctx.now, config.cacheTtlMinutes * 60_000);
	if (!(ctx.force || cold || config.mode === "always")) return { ids: [], cold };
	return { ids: eligible(messages, policyOf(config), elided), cold };
}

/** Replace the chosen results with stubs. Original messages are never mutated; untouched ones are shared. */
export function applyElision(
	messages: Message[],
	elided: ReadonlySet<string>,
): { messages: Message[]; count: number; savedChars: number } {
	if (elided.size === 0) return { messages, count: 0, savedChars: 0 };
	const calls = indexCalls(messages);
	let count = 0;
	let savedChars = 0;
	const out = messages.map((m) => {
		if (m.role !== "toolResult" || typeof m.toolCallId !== "string" || !elided.has(m.toolCallId)) return m;
		const size = measure(m.content);
		if (!size.textOnly) return m;
		const call = calls.get(m.toolCallId);
		const text = stubText(m.toolName ?? call?.name ?? "tool", call ? describeCall(call.name, call.args) : "", size.chars, size.lines);
		count++;
		savedChars += Math.max(0, size.chars - text.length);
		return { ...m, content: [{ type: "text", text }] };
	});
	return count === 0 ? { messages, count: 0, savedChars: 0 } : { messages: out, count, savedChars };
}

// ---------------------------------------------------------------------------
// Persistence: the elided set survives resume, so the prefix stays stable
// ---------------------------------------------------------------------------

export const ENTRY_TYPE = "context-diet";

export function restoreIds(entries: unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const e of entries) {
		const entry = e as { type?: string; customType?: string; data?: { ids?: unknown } } | null;
		if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE || !Array.isArray(entry.data?.ids)) continue;
		for (const id of entry.data.ids) if (typeof id === "string") ids.add(id);
	}
	return ids;
}

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
	| { kind: "invalid"; message: string };

export const USAGE =
	"Usage: /context-diet [status] · on · off · now · keep <turns> · ttl <minutes> · mode <cold|always>";

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
];

/** `prefix` is the whole argument text typed so far (pi replaces it with `value`). */
export function completions(prefix: string): CompletionItem[] | null {
	const text = (prefix ?? "").toLowerCase().replace(/^\s+/, "");
	const pool: CompletionItem[] = text.startsWith("mode ")
		? [
				{ value: "mode cold", label: "cold", description: "Elide only when the prompt cache is already cold (free)" },
				{ value: "mode always", label: "always", description: "Elide whenever eligible (providers without prompt caching)" },
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
	coldStarts: number;
}

const emptyStats = (): Stats => ({ requests: 0, cumulativeChars: 0, lastChars: 0, lastCount: 0, coldStarts: 0 });

export function statusLine(config: DietConfig, stats: Stats): string {
	const head = `pi-context-diet: ${config.enabled ? "on" : "off"} · mode ${config.mode} · keep last ${config.keepTurns} turns · cache ttl ${config.cacheTtlMinutes} min · min ${formatSize(config.minChars)}`;
	const body = `this session: ${stats.lastCount} results elided (~${formatTokens(estimateTokens(stats.lastChars))} tokens kept out of every request), ~${formatTokens(estimateTokens(stats.cumulativeChars))} tokens saved over ${stats.requests} requests · ${stats.coldStarts} cold start${stats.coldStarts === 1 ? "" : "s"}`;
	return `${head}\n${body}`;
}

export default function contextDiet(pi: ExtensionAPI) {
	let config: DietConfig = sanitizeConfig({});
	let elided = new Set<string>();
	let stats = emptyStats();
	let force = false;

	// The status line is cosmetic: a UI that throws must never change what is sent to the model.
	const showStatus = (ctx: ExtensionContext) => {
		try {
			if (!ctx.hasUI) return;
			if (!config.enabled || !config.showStatus || stats.lastCount === 0) {
				ctx.ui.setStatus("context-diet", "");
				return;
			}
			const t = ctx.ui.theme;
			ctx.ui.setStatus(
				"context-diet",
				`${t.fg("success", "🥗")} ${t.fg("accent", `−${formatTokens(estimateTokens(stats.lastChars))}`)} ${t.fg("dim", `/req · ${formatTokens(estimateTokens(stats.cumulativeChars))} saved`)}`,
			);
		} catch {
			/* ignore */
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		elided = restoreIds(ctx.sessionManager?.getEntries?.() ?? []);
		stats = emptyStats();
		force = false;
		showStatus(ctx);
	});

	// pi BLOCKS or breaks the request path when a handler misbehaves, so any unexpected error here means
	// "send the conversation unchanged".
	pi.on("context", (event, ctx) => {
		try {
			if (!config.enabled) return undefined;
			const messages = event.messages as unknown as Message[];
			const decision = decide(messages, elided, config, { now: Date.now(), force });
			if (decision.ids.length > 0) {
				for (const id of decision.ids) elided.add(id);
				pi.appendEntry(ENTRY_TYPE, { ids: decision.ids, cold: decision.cold, at: Date.now() });
				if (decision.cold) stats.coldStarts++;
			}
			force = false;
			const result = applyElision(messages, elided);
			if (result.count === 0) return undefined;
			stats.requests++;
			stats.lastCount = result.count;
			stats.lastChars = result.savedChars;
			stats.cumulativeChars += result.savedChars;
			showStatus(ctx);
			return { messages: result.messages as unknown as typeof event.messages };
		} catch {
			return undefined;
		}
	});

	pi.registerCommand("context-diet", {
		description: "Elide stale tool results when the prompt cache is cold: status, on/off, now, keep, ttl, mode",
		getArgumentCompletions: (prefix: string) => completions(prefix),
		handler: async (args, ctx) => {
			const cmd = parseCommand(args);
			const persist = async () => {
				await saveConfig(config);
				showStatus(ctx);
			};
			switch (cmd.kind) {
				case "status":
					ctx.ui.notify(statusLine(config, stats), "info");
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
				case "invalid":
					ctx.ui.notify(cmd.message, "warning");
					return;
			}
		},
	});
}
