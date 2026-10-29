import { expect, test } from "bun:test";
import { within } from "./workspace-files.ts";

test("within judges by the path alone: the parent, its children, and a child whose name starts with two dots", () => {
	expect(within("/w", "/w")).toBe(true);
	expect(within("/w", "/w/a/b")).toBe(true);
	expect(within("/w", "/w/..cfg/a.txt")).toBe(true);
	expect(within("/w", "/w/...")).toBe(true);
	expect(within("/w", "/")).toBe(false);
	expect(within("/w", "/w/../x")).toBe(false);
	expect(within("/w", "/wx")).toBe(false);
});
