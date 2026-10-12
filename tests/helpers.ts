import type { Message } from "../extensions/context-diet.ts";

let counter = 0;
export const resetIds = () => (counter = 0);

export const text = (t: string) => [{ type: "text", text: t }];
export const big = (chars: number, seed = "x") => seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);

export const user = (t = "do the thing", ts = 0): Message => ({ role: "user", content: text(t), timestamp: ts });

/** One agent turn: an assistant message that calls a tool, then the tool's result. */
export function turn(opts: { tool?: string; args?: Record<string, unknown>; chars?: number; isError?: boolean; ts?: number; content?: unknown } = {}): Message[] {
	const id = `call_${++counter}`;
	const tool = opts.tool ?? "bash";
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: tool, arguments: opts.args ?? { command: `echo step ${counter}` } }],
			timestamp: opts.ts ?? 0,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: tool,
			content: opts.content ?? text(big(opts.chars ?? 4000, `line ${counter}\n`)),
			isError: opts.isError ?? false,
			timestamp: opts.ts ?? 0,
		},
	];
}

/** A conversation of `n` turns, one every `stepMs`, ending at `endTs`. */
export function convo(n: number, opts: { endTs: number; stepMs?: number; chars?: number } = { endTs: 0 }): Message[] {
	const step = opts.stepMs ?? 20_000;
	const out: Message[] = [user("start", opts.endTs - n * step - 1000)];
	for (let i = 0; i < n; i++) out.push(...turn({ chars: opts.chars ?? 4000, ts: opts.endTs - (n - 1 - i) * step }));
	return out;
}

export const resultsOf = (messages: Message[]) => messages.filter((m) => m.role === "toolResult");
export const isStub = (m: Message) => JSON.stringify(m.content).includes("pi-context-diet:");

/** Freeze a message tree so any mutation throws. */
export function deepFreeze<T>(o: T): T {
	if (o && typeof o === "object") {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}
