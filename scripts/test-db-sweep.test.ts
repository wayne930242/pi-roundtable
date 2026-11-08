import { expect, test } from "bun:test";
import { postmasterPid } from "./test-db-sweep.ts";

test("the server pid is the first line of postmaster.pid", () => {
	expect(
		postmasterPid("4242\n/tmp/roundtable-test-pg-x/data\n1700000000\n"),
	).toBe(4242);
	expect(postmasterPid("")).toBeUndefined();
	expect(postmasterPid("1\n")).toBeUndefined();
});
