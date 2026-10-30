import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, readConfig, saveConfig, sanitizeConfig } from "../extensions/context-diet.ts";

describe("config file", () => {
	let dir: string;
	let prev: string | undefined;
	const file = () => join(dir, "context-diet.json");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-diet-config-"));
		prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(() => {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	it("a missing file gives the defaults and no problem", async () => {
		expect(await readConfig()).toEqual({ config: DEFAULT_CONFIG });
		expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
	});

	it("a broken file gives the defaults and says why", async () => {
		writeFileSync(file(), "{ nope");
		const r = await readConfig();
		expect(r.config).toEqual(DEFAULT_CONFIG);
		expect(r.problem).toContain("is not valid JSON");
	});

	it("an unreadable path gives the defaults and says why", async () => {
		mkdirSync(file()); // a directory where the file should be: EISDIR
		const r = await readConfig();
		expect(r.config).toEqual(DEFAULT_CONFIG);
		expect(r.problem).toContain("cannot read");
	});

	it("valid JSON with junk values is sanitized, not rejected", async () => {
		writeFileSync(file(), JSON.stringify({ keepTurns: 7, mode: "sometimes" }));
		const r = await readConfig();
		expect(r.problem).toBeUndefined();
		expect(r.config.keepTurns).toBe(7);
		expect(r.config.mode).toBe("cold");
	});

	it("save then load round-trips, creates the directory, and leaves no temp file behind", async () => {
		const nested = join(dir, "a", "b");
		process.env.PI_CODING_AGENT_DIR = nested;
		const config = sanitizeConfig({ keepTurns: 9, neverElide: ["read"], compact: true });
		await saveConfig(config);
		expect(await loadConfig()).toEqual(config);
		expect(readdirSync(nested)).toEqual(["context-diet.json"]);
		expect(readFileSync(join(nested, "context-diet.json"), "utf8").endsWith("}\n")).toBe(true);
	});

	it("a failed save throws and cleans up its temp file", async () => {
		// the target is a non-empty directory: the rename fails after the temp file was written
		mkdirSync(file());
		writeFileSync(join(file(), "keep"), "");
		await expect(saveConfig(DEFAULT_CONFIG)).rejects.toThrow();
		expect(readdirSync(dir)).toEqual(["context-diet.json"]);
	});
});
