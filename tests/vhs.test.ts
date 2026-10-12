import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { completions, parseCommand, sanitizeConfig } from "../extensions/context-diet.ts";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const VHS = join(ROOT, "examples", "vhs");
// Windows checkouts may convert to CRLF: compare on LF only.
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const tapes = readdirSync(VHS).filter((f) => f.endsWith(".tape")).sort();
const gifRefsInReadme = [...read(join(ROOT, "README.md")).matchAll(/examples\/vhs\/generated\/([\w-]+\.gif)/g)].map((m) => m[1]);
const posix = process.platform !== "win32";
const PORT = 8993;
const CMD = "context-diet";

describe("VHS tapes", () => {
	it("there is a tape for every feature we show off", () => {
		for (const name of ["overview", "commands", "completion", "recovery", "arguments", "compaction"]) expect(tapes, name).toContain(`${name}.tape`);
	});

	for (const tape of tapes) {
		const name = tape.replace(/\.tape$/, "");
		const text = read(join(VHS, tape));

		it(`${tape}: header, output path and the shared Set block match the house style`, () => {
			expect(text.split("\n")[0]).toBe(`# VHS tape: ${name}`);
			expect(text).toContain(`Output examples/vhs/generated/${name}.gif`);
			for (const setting of ['Set Shell "bash"', "Set FontSize 18", "Set Width 1200", "Set Height 720", "Set Padding 24", "Set PlaybackSpeed 1.0", 'Set Theme "Catppuccin Mocha"']) {
				expect(text, setting).toContain(setting);
			}
			// recordings only ever run on the synthetic fixture, with the real pi but only this extension
			expect(text).toContain("examples/vhs/fixture.sh");
			expect(text).toContain("examples/vhs/pi-demo.sh");
			expect(text).toContain(`mock-llm.ts ${PORT}`);
			expect(text).toContain("Wait+Screen@30s");
			expect(text).toContain("never touches your real files");
		});

		it(`${tape}: it only types valid /context-diet commands, with the right number of Enters`, () => {
			const lines = text.split("\n");
			lines.forEach((line, i) => {
				const m = line.match(/^Type "(\/context-diet[^"]*)"$/);
				if (!m || m[1].endsWith(" ")) return; // a trailing space only opens a menu
				const arg = m[1].replace(/^\/context-diet\s*/, "");
				expect(parseCommand(arg).kind, `"${m[1]}" in ${tape}`).not.toBe("invalid");
				// pi's menu is open for a bare command and for any argument that has a completion:
				// Enter #1 accepts the suggestion, Enter #2 runs it. Otherwise one Enter runs it.
				let enters = 0;
				for (let j = i + 1; j < lines.length && !lines[j].startsWith("Type "); j++) if (lines[j] === "Enter") enters++;
				expect(enters, `"${m[1]}" in ${tape}`).toBe(arg === "" || completions(arg) !== null ? 2 : 1);
			});
		});

		it(`${tape}: every prompt waits for the scripted reply instead of sleeping blindly`, () => {
			const lines = text.split("\n");
			lines.forEach((line, i) => {
				const m = line.match(/^Type "([^/"][^"]*)"$/);
				if (!m || !/^(Survey|What|Write|Read|Show)/.test(m[1])) return;
				const tail = lines.slice(i + 1, i + 12).join("\n");
				expect(tail, `"${m[1]}" in ${tape}`).toMatch(/Wait\+Screen@40s \/.+\//);
			});
		});
	}

	it("every tape quits pi and stops its mock model", () => {
		for (const tape of tapes) expect(read(join(VHS, tape)), tape).toMatch(/Ctrl\+D[\s\S]*pkill -f mock-llm/);
	});
});

describe("README previews and Git LFS", () => {
	it("every GIF the README shows is produced by a tape, and every tape's GIF is shown", () => {
		const produced = tapes.map((t) => t.replace(/\.tape$/, ".gif"));
		for (const gif of new Set(gifRefsInReadme)) expect(produced, `README shows ${gif}`).toContain(gif);
		for (const gif of produced) expect(gifRefsInReadme, `README should show ${gif}`).toContain(gif);
	});

	it("the GIFs exist (real files, or LFS pointers in a checkout without LFS)", () => {
		for (const gif of new Set(gifRefsInReadme)) {
			const p = join(VHS, "generated", gif);
			expect(existsSync(p), gif).toBe(true);
			expect(statSync(p).size, gif).toBeGreaterThan(50); // an LFS pointer is ~130 bytes
		}
	});

	it("GIFs and generated PNGs are tracked with Git LFS; scripts and tapes are pinned to LF", () => {
		const attrs = read(join(ROOT, ".gitattributes"));
		expect(attrs).toContain("*.gif filter=lfs diff=lfs merge=lfs -text");
		expect(attrs).toContain("examples/vhs/generated/*.png filter=lfs diff=lfs merge=lfs -text");
		expect(attrs).toContain("*.sh text eol=lf");
		expect(attrs).toContain("*.tape text eol=lf");
	});

	it("the demo assets never ship in the npm package", () => {
		const pkg = JSON.parse(read(join(ROOT, "package.json")));
		expect((pkg.files as string[]).every((f) => !f.startsWith("examples"))).toBe(true);
	});

	it("documents how to regenerate and how LFS is used", () => {
		const md = read(join(ROOT, "README.md"));
		for (const s of ["Git LFS", "git lfs install", "just vhs-all", "just vhs-tape", "just demo", "synthetic"]) expect(md, s).toContain(s);
	});
});

describe.skipIf(!posix)("synthetic fixture (examples/vhs/fixture.sh)", () => {
	const run = (...args: string[]) => Bun.spawnSync(["bash", join(VHS, "fixture.sh"), ...args], { cwd: ROOT });
	const env = () => Object.fromEntries(run("env").stdout.toString().split("\n").filter(Boolean).map((l) => l.replace(/^export /, "").split("=")));
	const app = () => join(env().HOME, "projects", "my-app");
	const lineCount = (p: string) => read(p).split("\n").length - 1;
	const digest = (dir: string) => {
		const h = createHash("sha256");
		const walk = (d: string) => readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : h.update(e.name).update(readFileSync(join(d, e.name)))));
		walk(dir);
		return h.digest("hex");
	};

	beforeAll(() => {
		expect(run().exitCode).toBe(0);
	});

	it("`env` points pi at the throw-away dirs, offline and in UTC", () => {
		const e = env();
		expect(e.HOME).toMatch(/\/home$/);
		expect(e.PI_CODING_AGENT_DIR).toMatch(/\/agent$/);
		expect(e.PI_OFFLINE).toBe("1");
		expect(e.TZ).toBe("UTC");
		expect(e.HOME).not.toBe(homedir());
	});

	it("builds five modules big enough to be worth eliding, and a demo config", () => {
		for (const name of ["orders", "inventory", "billing", "shipping", "reports"]) {
			expect(read(join(app(), "src", `${name}.ts`)).length, name).toBeGreaterThan(1500); // the default minChars
		}
		const cfg = sanitizeConfig(JSON.parse(read(join(env().PI_CODING_AGENT_DIR, "context-diet.json"))));
		expect(cfg).toMatchObject({ enabled: true, mode: "cold", keepTurns: 2 });
	});

	it("is deterministic", () => {
		const first = digest(join(env().HOME, ".."));
		expect(run().exitCode).toBe(0);
		expect(digest(join(env().HOME, ".."))).toBe(first);
	});

	it("configures a local mock model on this plugin's port, and leaks nothing about the real machine", () => {
		const agent = env().PI_CODING_AGENT_DIR;
		const models = JSON.parse(read(join(agent, "models.json")));
		expect(models.providers.demo.baseUrl).toBe(`http://127.0.0.1:${PORT}/v1`);
		expect(models.providers.demo.models[0].id).toBe("demo-model");
		expect(JSON.parse(read(join(agent, "settings.json")))).toMatchObject({ defaultProvider: "demo", defaultModel: "demo-model" });
		expect(read(join(VHS, "pi-demo.sh"))).toContain("--tools read,write");

		const leaks: string[] = [];
		const secrets = [homedir(), userInfo().username].filter((s) => s.length > 3);
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const full = join(d, e.name);
				if (e.isDirectory()) walk(full);
				else if (secrets.some((s) => read(full).includes(s) || full.includes(s))) leaks.push(full);
			}
		};
		walk(join(agent, ".."));
		expect(leaks).toEqual([]);
	});

	it("pi-demo.sh and fixture.sh are valid bash", () => {
		for (const f of ["pi-demo.sh", "fixture.sh"]) expect(Bun.spawnSync(["bash", "-n", join(VHS, f)]).exitCode, f).toBe(0);
	});
});

describe("scripted mock model (examples/vhs/mock-llm.ts)", () => {
	const port = 19000 + Math.floor(Math.random() * 400);
	const base = `http://127.0.0.1:${port}`;
	let proc: ReturnType<typeof Bun.spawn>;
	const FILES = ["src/orders.ts", "src/inventory.ts", "src/billing.ts", "src/shipping.ts", "src/reports.ts"];

	const ask = async (messages: unknown[], stream = false, withTools = true) => {
		const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "demo-model", stream, messages, tools: withTools ? [{ type: "function", function: { name: "read" } }] : undefined }) });
		return stream ? res : ((await res.json()) as any);
	};
	const user = (content: string) => ({ role: "user", content });
	const readCall = (path: string) => ({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } }] });
	const result = (content: unknown) => ({ role: "tool", tool_call_id: "c", content });
	const STUB = "[pi-context-diet: the output of read src/x.ts (4.0 KB, 90 lines) was elided from the context to save tokens.]";
	const call = (r: any) => ({ name: r.choices[0].message.tool_calls[0].function.name, args: JSON.parse(r.choices[0].message.tool_calls[0].function.arguments) });
	const said = (r: any) => r.choices[0].message.content as string;

	/** A conversation that has already read `n` files; `stubbed` of the first results arrive as stubs. */
	const survey = (n: number, stubbed = 0) => {
		const m: unknown[] = [user("Survey the project")];
		for (let i = 0; i < n; i++) m.push(readCall(FILES[i]), result(i < stubbed ? STUB : "x".repeat(2000)));
		return m;
	};

	beforeAll(async () => {
		proc = Bun.spawn(["bun", join(VHS, "mock-llm.ts"), String(port)], { stdout: "ignore", stderr: "ignore" });
		for (let i = 0; i < 60; i++) {
			try {
				if ((await fetch(`${base}/v1/models`)).ok) return;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error("mock-llm did not start");
	});
	afterAll(() => proc?.kill());

	it("lists the demo model and 404s everything else", async () => {
		const body = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] };
		expect(body.data.map((m) => m.id)).toEqual(["demo-model"]);
		expect((await fetch(`${base}/v1/nope`)).status).toBe(404);
		expect((await fetch(`${base}/v1/chat/completions`)).status).toBe(404);
	});

	it("survey: reads the five files one after another", async () => {
		expect(call(await ask([user("Survey the project")]))).toEqual({ name: "read", args: { path: FILES[0] } });
		for (let n = 1; n < 5; n++) expect(call(await ask(survey(n))), `after ${n} results`).toEqual({ name: "read", args: { path: FILES[n] } });
	});

	it("survey: after the fifth file it reports what context it received", async () => {
		const plain = said(await ask(survey(5)));
		expect(plain).toContain("Surveyed 5 files.");
		expect(plain).toContain("5 tool results, 0 of them elided stubs");
		expect(plain).toContain("10.0 KB");
		const diet = said(await ask(survey(5, 3)));
		expect(diet).toContain("5 tool results, 3 of them elided stubs");
		expect(diet).toContain("4.3 KB"); // 3 stubs + 2 full results
	});

	it("'what do you still know' reports the context without calling a tool", async () => {
		const r = await ask([...survey(5, 3), { role: "assistant", content: "Surveyed." }, user("What do you still know?")]);
		expect(r.choices[0].finish_reason).toBe("stop");
		expect(said(r)).toContain("5 tool results, 3 of them elided stubs");
		expect(said(await ask([user("summarise")]))).toContain("0 tool results, 0 of them elided stubs");
	});

	it("write: writes a 60-line src/summary.ts, then confirms", async () => {
		const first = call(await ask([user("Write the summary file")]));
		expect(first.name).toBe("write");
		expect(first.args.path).toBe("src/summary.ts");
		expect(first.args.content.split("\n").filter(Boolean)).toHaveLength(60);
		expect(first.args.content.length).toBeGreaterThan(1500); // big enough to be worth eliding
		const writeCall = { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "write", arguments: JSON.stringify(first.args) } }] };
		expect(said(await ask([user("Write the summary file"), writeCall, result("Wrote 60 lines")]))).toBe("Wrote src/summary.ts (60 lines).");
	});

	it("again: re-reads the FIRST file (an identical call to the earlier one), then reports the context", async () => {
		expect(call(await ask([user("Read the first file again")]))).toEqual({ name: "read", args: { path: FILES[0] } });
		const after = said(await ask([user("Read the first file again"), readCall(FILES[0]), result("x".repeat(2000))]));
		expect(after).toContain("Read it again.");
		expect(after).toContain("1 tool results, 0 of them elided stubs");
	});

	it("stub: shows the first stub it received, preview included, or says it got none", async () => {
		const preview = `${STUB}\nlast lines:\n  }\n  return Math.round(sum * 100) / 100;`;
		const r = said(await ask([...survey(2, 1).slice(0, 1), readCall(FILES[0]), result(preview), user("Show me one stub")]));
		expect(r).toContain("The first stub I received:");
		expect(r).toContain("last lines:");
		expect(r).toContain("return Math.round");
		expect(said(await ask([user("Show me one stub")]))).toBe("I have not received any stubs.");
	});

	it("the report counts tool calls whose arguments arrived elided", async () => {
		const elidedWrite = { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "a", content: "[pi-context-diet: 60 lines elided]" }) } }] };
		const one = said(await ask([user("x"), elidedWrite, result("ok"), user("What do you still know?")]));
		expect(one).toContain("1 tool call with elided arguments.");
		const two = said(await ask([user("x"), elidedWrite, result("ok"), elidedWrite, result("ok"), user("What do you still know?")]));
		expect(two).toContain("2 tool calls with elided arguments.");
		expect(said(await ask([...survey(2), user("What do you still know?")]))).not.toContain("elided arguments");
	});

	it("a request without tools is pi's compaction: it gets a canned summary, never a tool call", async () => {
		for (const messages of [[user("Survey the project")], survey(5), []]) {
			const r = await ask(messages, false, false);
			expect(r.choices[0].finish_reason).toBe("stop");
			expect(said(r)).toContain("Summary: surveyed five source files");
		}
		const streamed = await ((await ask([user("Survey the project")], true, false)) as Response).text();
		expect(streamed).not.toContain("tool_calls");
		expect(streamed).toContain("finish_reason\":\"stop");
	});

	it("reports usage that grows with what it received, like a real provider", async () => {
		const small = (await ask([user("hello")])).usage.prompt_tokens;
		const big = (await ask(survey(5))).usage.prompt_tokens;
		expect(small).toBeGreaterThan(4000);
		expect(big).toBeGreaterThan(small + 3000);
	});

	it("tool results may arrive as content parts, and anything else gets a polite scripted line", async () => {
		const parts = [...survey(4), readCall(FILES[4]), result([{ type: "text", text: STUB }])];
		expect(said(await ask(parts))).toContain("1 of them elided stubs"); // a stub inside a content part is counted
		expect(said(await ask([user("hello")]))).toContain("scripted scenarios");
		expect(said(await ask([]))).toContain("scripted scenarios");
	});

	it("streams a tool call as SSE: role, tool_calls, finish_reason tool_calls, usage, [DONE]", async () => {
		const res = (await ask([user("Survey the project")], true)) as Response;
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		const events = text.split("\n\n").filter((e) => e.startsWith("data: ") && !e.includes("[DONE]")).map((e) => JSON.parse(e.slice(6)));
		expect(events[0].choices[0].delta.role).toBe("assistant");
		const calls = events.flatMap((e) => e.choices[0].delta.tool_calls ?? []);
		expect(calls[0].function.name).toBe("read");
		expect(JSON.parse(calls.map((c: any) => c.function.arguments).join("")).path).toBe(FILES[0]);
		const last = events.at(-1);
		expect(last.choices[0].finish_reason).toBe("tool_calls");
		expect(last.usage.total_tokens).toBe(last.usage.prompt_tokens + last.usage.completion_tokens);
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	it("streams a text reply word by word and ends with stop", async () => {
		const text = await ((await ask([user("hello")], true)) as Response).text();
		const events = text.split("\n\n").filter((e) => e.startsWith("data: ") && !e.includes("[DONE]")).map((e) => JSON.parse(e.slice(6)));
		expect(events.map((e) => e.choices[0].delta.content ?? "").join("")).toContain("scripted scenarios");
		expect(events.at(-1).choices[0].finish_reason).toBe("stop");
	});

	it("non-streaming replies carry usage and a finish reason; a malformed body is tolerated", async () => {
		const r = await ask([user("Survey the project")]);
		expect(r.choices[0].finish_reason).toBe("tool_calls");
		expect(r.usage.total_tokens).toBeGreaterThan(0);
		expect((await ask([user("hello")])).choices[0].finish_reason).toBe("stop");
		const bad = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{not json" });
		expect(bad.status).toBe(200);
	});
});
