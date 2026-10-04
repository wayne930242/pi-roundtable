import { expect, test } from "bun:test";
import { jevCompactor } from "pi-roundtable/kit";
import { recordingLogger } from "pi-roundtable/testing";
import type { PiCompactor } from "./index.ts";

test("the core's Jev compactor is a sandbox compactor as it is", () => {
	const compactor: PiCompactor = jevCompactor({
		logger: recordingLogger().logger,
	});
	expect(compactor.engine).toBe("pi-jev-compaction");
});
