/**
 * A tiny OpenAI-compatible chat endpoint for the demos (no network, no API key, no real model).
 * It is a script, not an AI. Its one trick: it tells you what CONTEXT it received, so a recording
 * shows pi-context-diet's effect: how many tool results reached the model as elision stubs.
 *
 *   bun examples/vhs/mock-llm.ts [port]      (8993 for pi-context-diet)
 *
 * Scenarios (matched on the last user message):
 *   "survey"               read five source files one after another, then report the context it received
 *   "write"                write a 60-line src/summary.ts (a big write argument that goes stale)
 *   "again"                re-read src/orders.ts: the identical call to an earlier, possibly elided, read
 *   "stub"                 show the first elision stub it received (with its preview lines)
 *   "still know"/"summar"  just report the context it received
 *   (request without tools) pi's compaction asks for a summary and offers no tools: reply with a canned summary
 */
const port = Number(process.argv[2] ?? 8993);

type Msg = { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[] };

const SUMMARY = Array.from({ length: 60 }, (_, i) => `export const summaryRow${i} = { id: "row-${i}", qty: ${i + 1}, price: ${(i + 1) * 3}.5 };`).join("\n") + "\n";
const FILES = ["src/orders.ts", "src/inventory.ts", "src/billing.ts", "src/shipping.ts", "src/reports.ts"];
/** Usage that grows with what was sent (a fixed 4k system prompt plus ~2.5 characters per token), like a real provider's. */
const usageFor = (messages: Msg[]) => {
	const chars = messages.reduce((n, m) => n + text(m).length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
	const prompt = 4_000 + Math.round(chars / 2.5);
	return { prompt_tokens: prompt, completion_tokens: 420, total_tokens: prompt + 420, prompt_tokens_details: { cached_tokens: Math.max(0, prompt - 900) } };
};

const text = (m: Msg | undefined): string => {
	const c = m?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join(" ");
	return "";
};

/** What reached the model: tool results, how many are pi-context-diet stubs, and how much text they carry. */
function report(messages: Msg[]): string {
	const results = messages.filter((m) => m.role === "tool");
	const stubs = results.filter((m) => text(m).includes("pi-context-diet:"));
	const chars = results.reduce((n, m) => n + text(m).length, 0);
	const elidedArgs = messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).filter((c) => c.function.arguments.includes("pi-context-diet:")).length;
	const args = elidedArgs > 0 ? ` ${elidedArgs} tool call${elidedArgs === 1 ? "" : "s"} with elided arguments.` : "";
	return `Context I received: ${results.length} tool results, ${stubs.length} of them elided stubs. Tool output total: ${(chars / 1000).toFixed(1)} KB.${args}`;
}

type Reply = { kind: "text"; text: string } | { kind: "tool"; name: string; args: object };

function decide(messages: Msg[], hasTools: boolean): Reply {
	const last = messages[messages.length - 1];
	// pi's compaction summarises the conversation in requests that offer no tools (two of them: the history and the
	// split turn): answer with a canned summary, never a tool call
	if (!hasTools) {
		return { kind: "text", text: "Summary: surveyed five source files under src (orders, inventory, billing, shipping, reports); nothing was edited. Next step: ask the user what to change." };
	}
	if (last?.role === "tool") {
		let lastUser = -1;
		messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
		const ask = text(messages[lastUser]).toLowerCase();
		const calls = messages.slice(lastUser + 1).filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
		if (/survey/.test(ask)) {
			if (calls < FILES.length) return { kind: "tool", name: "read", args: { path: FILES[calls] } };
			return { kind: "text", text: `Surveyed ${FILES.length} files. ${report(messages)}` };
		}
		if (/write/.test(ask)) return { kind: "text", text: "Wrote src/summary.ts (60 lines)." };
		return { kind: "text", text: `Read it again. ${report(messages)}` };
	}
	const ask = text(last).toLowerCase();
	if (ask.includes("survey")) return { kind: "tool", name: "read", args: { path: FILES[0] } };
	if (ask.includes("write")) return { kind: "tool", name: "write", args: { path: "src/summary.ts", content: SUMMARY } };
	if (ask.includes("again")) return { kind: "tool", name: "read", args: { path: FILES[0] } };
	if (ask.includes("stub")) {
		const first = messages.filter((m) => m.role === "tool").map(text).find((t) => t.includes("pi-context-diet:"));
		return { kind: "text", text: first ? `The first stub I received:\n${first}` : "I have not received any stubs." };
	}
	if (/still know|summar/.test(ask)) return { kind: "text", text: report(messages) };
	return { kind: "text", text: "Sure. This is the demo model: it only follows the scripted scenarios." };
}

const chunk = (delta: object, finish: string | null = null, usage?: object) =>
	`data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", created: 0, model: "demo-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "demo-model", object: "model" }] });
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body = (await req.json().catch(() => ({}))) as { stream?: boolean; messages?: Msg[]; tools?: unknown[] };
		const reply = decide(body.messages ?? [], Array.isArray(body.tools) && body.tools.length > 0);
		const USAGE = usageFor(body.messages ?? []);

		if (!body.stream) {
			const message = reply.kind === "text"
				? { role: "assistant", content: reply.text }
				: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] };
			return Response.json({ id: "demo", object: "chat.completion", created: 0, model: "demo-model", usage: USAGE, choices: [{ index: 0, message, finish_reason: reply.kind === "text" ? "stop" : "tool_calls" }] });
		}

		const enc = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				const send = (s: string) => controller.enqueue(enc.encode(s));
				send(chunk({ role: "assistant", content: "" }));
				if (reply.kind === "text") {
					for (const word of reply.text.split(" ")) {
						send(chunk({ content: word + " " }));
						await new Promise((r) => setTimeout(r, 20));
					}
					send(chunk({}, "stop", USAGE));
				} else {
					send(chunk({ tool_calls: [{ index: 0, id: "call_" + Math.random().toString(36).slice(2, 8), type: "function", function: { name: reply.name, arguments: "" } }] }));
					send(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] }));
					send(chunk({}, "tool_calls", USAGE));
				}
				send("data: [DONE]\n\n");
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
	},
});
console.error(`mock-llm listening on http://127.0.0.1:${port}`);
