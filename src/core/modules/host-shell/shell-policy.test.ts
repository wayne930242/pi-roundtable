import { describe, expect, test } from "bun:test";
import { simpleCommands } from "./shell-policy.ts";

describe("simpleCommands", () => {
	test("splits on operators and removes quotes", () => {
		expect(simpleCommands(`echo 'a b' && ls -la | grep "x y"; df -h`)).toEqual([
			["echo", "a b"],
			["ls", "-la"],
			["grep", "x y"],
			["df", "-h"],
		]);
	});

	test("keeps redirections as words", () => {
		expect(simpleCommands("echo hi > /etc/x 2>&1")).toEqual([
			["echo", "hi", ">", "/etc/x", "2", "dup", "1"],
		]);
	});
});
