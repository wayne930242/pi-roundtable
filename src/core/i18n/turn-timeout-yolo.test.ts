import { expect, test } from "bun:test";
import type { TurnTimeout } from "../domain/turn-timeout.ts";
import { catalogFor } from "./index.ts";

const MIN = 60_000;

test("in yolo the timeout card and its footer say the turn goes on, in English and zh-TW", () => {
	const timeout: TurnTimeout = {
		limit: "turn",
		limitMs: 10 * MIN,
		workedMs: 10 * MIN,
		running: [],
		compacting: false,
		tools: [],
		graceMs: MIN,
		end: "timeout",
		autoContinue: true,
	};
	const zh = catalogFor("zh-TW");
	expect(zh.turnTimeoutQuestion(timeout, 10 * MIN)).toContain(
		"Yolo 模式已開啟：1 分內沒有回答，它會自己繼續。",
	);
	expect(zh.turnTimeoutAutoContinued(timeout)).toBe(
		"⏱️ 1 分內沒有回答；Yolo 模式已開啟，這一輪已自動繼續。",
	);
	expect(catalogFor("en").turnTimeoutAutoContinued(timeout)).toContain(
		"continued automatically",
	);
});
