import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

// Windows checkouts may convert to CRLF: compare on LF only.
const readme = () => readFileSync(join(import.meta.dir, "..", "README.md"), "utf8").replace(/\r\n/g, "\n");
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextDiet, { parseCommand } from "../extensions/context-diet.ts";

const PLACEHOLDERS: Record<string, string[]> = { "<turns>": ["5"], "<minutes>": ["60"] };

/** `/context-diet ...` spans from the README, with `a|b` alternatives and <placeholders> expanded. */
function readmeCommands(): string[] {
	const md = readme();
	const spans = [...md.matchAll(/`(\/context-diet[^`]*)`/g)].map((m) => m[1].replace(/\\\|/g, "|"));
	const out = new Set<string>();
	for (const span of spans) {
		let variants = [span];
		for (let guard = 0; guard < 4; guard++) {
			variants = variants.flatMap((v) => {
				const m = v.match(/<([^<>]*\|[^<>]*)>/);
				return m ? m[1].split("|").map((alt) => v.replace(m[0], alt)) : [v];
			});
		}
		for (const [ph, values] of Object.entries(PLACEHOLDERS)) {
			variants = variants.flatMap((v) => (v.includes(ph) ? values.map((val) => v.split(ph).join(val)) : [v]));
		}
		for (const v of variants) out.add(v.replace(/^\/context-diet\s*/, "").trim());
	}
	return [...out];
}

describe("every command documented in the README works", () => {
	let dir: string;
	let command: any;
	let notes: string[];
	let prev: string | undefined;
	const ctx = () => ({ hasUI: false, sessionManager: { getEntries: () => [] }, ui: { notify: (m: string) => notes.push(m), setStatus() {}, theme: { fg: (_: string, t: string) => t } } });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-diet-readme-"));
		prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		notes = [];
		contextDiet({ on() {}, appendEntry() {}, registerCommand: (_: string, c: any) => (command = c) } as any);
	});
	afterEach(() => {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds every command in the README", () => {
		const cmds = readmeCommands();
		for (const must of ["", "on", "off", "now", "keep 5", "ttl 60", "mode cold", "mode always", "args on", "args off"]) expect(cmds, must).toContain(must);
	});

	it("each example parses (none is `invalid`) and runs with a success notification", async () => {
		for (const cmd of readmeCommands()) {
			expect(parseCommand(cmd).kind, `README example "/context-diet ${cmd}"`).not.toBe("invalid");
			notes.length = 0;
			await command.handler(cmd, ctx());
			expect(notes.length, `"/context-diet ${cmd}" produced no output`).toBeGreaterThan(0);
			expect(notes.at(-1), `"/context-diet ${cmd}"`).not.toContain("Unknown");
			expect(notes.at(-1), `"/context-diet ${cmd}"`).not.toContain("Usage:");
		}
	});

	it("the documented defaults match the code", () => {
		const md = readme();
		const json = JSON.parse(md.match(/```json\n([\s\S]*?)```/)![1]);
		expect(json).toEqual({ enabled: true, mode: "cold", keepTurns: 20, minChars: 1500, cacheTtlMinutes: 5, keepErrors: true, neverElide: [], showStatus: true, stubTailLines: 3, stubErrorLines: 3, elideArgs: true, autoProtect: true, recoveryThreshold: 0.25 });
	});
});
