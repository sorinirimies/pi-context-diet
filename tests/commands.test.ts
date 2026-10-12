import { describe, it, expect } from "bun:test";
import { completions, parseCommand } from "../extensions/context-diet.ts";

describe("parseCommand", () => {
	it("defaults to status", () => {
		for (const a of [undefined, "", "   ", "status", " STATUS "]) expect(parseCommand(a)).toEqual({ kind: "status" });
	});
	it("on / off and their aliases", () => {
		expect(parseCommand("on")).toEqual({ kind: "on" });
		expect(parseCommand("enable")).toEqual({ kind: "on" });
		expect(parseCommand("off")).toEqual({ kind: "off" });
		expect(parseCommand("disable")).toEqual({ kind: "off" });
		expect(parseCommand("now")).toEqual({ kind: "now" });
	});
	it("keep <turns>", () => {
		expect(parseCommand("keep 20")).toEqual({ kind: "keep", turns: 20 });
		expect(parseCommand("KEEP  1")).toEqual({ kind: "keep", turns: 1 });
		for (const bad of ["keep", "keep 0", "keep 501", "keep 1.5", "keep x", "keep -3"]) expect(parseCommand(bad).kind, bad).toBe("invalid");
	});
	it("ttl <minutes>", () => {
		expect(parseCommand("ttl 5")).toEqual({ kind: "ttl", minutes: 5 });
		expect(parseCommand("ttl 1440")).toEqual({ kind: "ttl", minutes: 1440 });
		for (const bad of ["ttl", "ttl 0", "ttl 1441", "ttl 2.5", "ttl soon"]) expect(parseCommand(bad).kind, bad).toBe("invalid");
	});
	it("mode <cold|always>", () => {
		expect(parseCommand("mode cold")).toEqual({ kind: "mode", mode: "cold" });
		expect(parseCommand("mode ALWAYS")).toEqual({ kind: "mode", mode: "always" });
		for (const bad of ["mode", "mode sometimes"]) expect(parseCommand(bad).kind, bad).toBe("invalid");
	});
	it("args <on|off>", () => {
		expect(parseCommand("args on")).toEqual({ kind: "args", on: true });
		expect(parseCommand("ARGS  OFF")).toEqual({ kind: "args", on: false });
		for (const bad of ["args", "args maybe"]) expect(parseCommand(bad).kind, bad).toBe("invalid");
	});
	it("unknown words say what is valid", () => {
		const c = parseCommand("bogus");
		expect(c.kind).toBe("invalid");
		expect((c as any).message).toContain('Unknown option "bogus"');
		expect((c as any).message).toContain("keep <turns>");
	});
});

describe("completions", () => {
	it("offers every command at the top level, each with a string value and label", () => {
		const items = completions("")!;
		expect(items.map((i) => i.label)).toEqual(["status", "on", "off", "now", "keep", "ttl", "mode", "args"]);
		for (const i of items) {
			expect(typeof i.value).toBe("string");
			expect(typeof i.label).toBe("string");
			expect(i.description && i.description.length).toBeGreaterThan(3);
		}
	});
	it("filters by prefix and returns null when nothing matches", () => {
		expect(completions("mo")!.map((i) => i.value)).toEqual(["mode "]);
		expect(completions("k")!.map((i) => i.value)).toEqual(["keep "]);
		expect(completions("  ST")!.map((i) => i.value)).toEqual(["status"]);
		expect(completions("zzz")).toBeNull();
		expect(completions(undefined as any)).not.toBeNull();
	});
	it("completes the mode argument with the full argument text", () => {
		expect(completions("mode ")!.map((i) => i.value)).toEqual(["mode cold", "mode always"]);
		expect(completions("mode a")!.map((i) => i.value)).toEqual(["mode always"]);
		expect(completions("mode x")).toBeNull();
	});
	it("completes the args argument too", () => {
		expect(completions("args ")!.map((i) => i.value)).toEqual(["args on", "args off"]);
		expect(completions("args of")!.map((i) => i.value)).toEqual(["args off"]);
		expect(completions("args x")).toBeNull();
		expect(completions("a")!.map((i) => i.value)).toEqual(["args "]);
	});
});
