import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// pi's REAL autocomplete provider: the one that crashed a sibling plugin ("reading 'endsWith'") when
// its completions lacked a label. Mock-only tests never exercised it.
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import contextDiet, { parseCommand } from "../extensions/context-diet.ts";

const TYPED = [
	"", "s", "status", "o", "on", "off", "n", "now", "k", "keep", "keep ", "keep 5", "t", "ttl", "ttl ", "m", "mode", "mode ", "mode c", "mode a",
	"mode always", "zzz", "mode zzz", "e", "enable", "d", "disable", "a", "args", "args ", "args o", "args on", "args off",
];

describe("pi's real autocomplete provider × the context-diet command", () => {
	let command: any;
	let notes: string[];
	let provider: CombinedAutocompleteProvider;
	const signal = new AbortController().signal;
	const ctx = () => ({ hasUI: false, sessionManager: { getEntries: () => [] }, ui: { notify: (m: string) => notes.push(m), setStatus() {}, theme: { fg: (_: string, t: string) => t } } });

	// The command handler persists config: never let it touch a real ~/.pi/agent.
	let dir: string;
	let prevDir: string | undefined;
	beforeEach(() => {
		prevDir = process.env.PI_CODING_AGENT_DIR;
		dir = mkdtempSync(join(tmpdir(), "pi-diet-ac-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		notes = [];
		contextDiet({ on() {}, appendEntry() {}, registerCommand: (_: string, c: any) => (command = c) } as any);
		provider = new CombinedAutocompleteProvider([{ name: "context-diet", description: command.description, getArgumentCompletions: command.getArgumentCompletions }], process.cwd());
	});

	afterEach(() => {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const suggest = (line: string) => provider.getSuggestions([line], 0, line.length, { signal });

	it("regression: items without a label crash the real provider", async () => {
		const broken = new CombinedAutocompleteProvider([{ name: "context-diet", getArgumentCompletions: () => [{ value: "now" }] as any }], process.cwd());
		const line = "/context-diet n";
		const s = await broken.getSuggestions([line], 0, line.length, { signal });
		expect(() => broken.applyCompletion([line], 0, line.length, s!.items[0], s!.prefix)).toThrow(/endsWith/);
	});

	it("applying ANY suggestion for ANY typed input never throws and yields a valid command line", async () => {
		let applied = 0;
		for (const arg of TYPED) {
			const line = `/context-diet ${arg}`;
			const s = await suggest(line);
			if (!s) continue;
			for (const item of s.items) {
				const out = provider.applyCompletion([line], 0, line.length, item, s.prefix);
				expect(out.lines[0].startsWith("/context-diet")).toBe(true);
				const argText = out.lines[0].replace(/^\/context-diet\s*/, "");
				const stem = /^(keep|ttl|mode|args)\s*$/.test(argText); // intentionally unfinished: needs a value
				expect(parseCommand(argText).kind === "invalid" ? stem : true, `"${argText}"`).toBe(true);
				applied++;
			}
		}
		expect(applied).toBeGreaterThan(20);
	});

	it("`mode ` offers cold and always with descriptions, and completes to a runnable command", async () => {
		const line = "/context-diet mode a";
		const s = await suggest(line);
		expect(s!.items.map((i) => i.label)).toEqual(["always"]);
		const out = provider.applyCompletion([line], 0, line.length, s!.items[0], s!.prefix);
		expect(out.lines[0]).toBe("/context-diet mode always");
		await command.handler("mode always", ctx());
		expect(notes.at(-1)).toContain("only without prompt caching");
	});

	it("choosing keep/ttl/mode leaves the cursor after a space, ready for the value", async () => {
		const line = "/context-diet ke";
		const s = await suggest(line);
		const out = provider.applyCompletion([line], 0, line.length, s!.items[0], s!.prefix);
		expect(out.lines[0]).toBe("/context-diet keep ");
		expect(out.cursorCol).toBe(out.lines[0].length);
	});

	it("no suggestions for unknown input, without throwing", async () => {
		expect(await suggest("/context-diet zzz")).toBeNull();
		expect(await suggest("/context-diet mode zzz")).toBeNull();
	});
});
