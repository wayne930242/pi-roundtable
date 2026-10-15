import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TurnRequest } from "../domain/ports.ts";
import type { EffortPolicy, ThinkingLevel } from "../models.ts";
import { thinkingLevel } from "./thinking-level.ts";

const session = { messages: [] } as unknown as AgentSession;
const request = (extra: Partial<TurnRequest> = {}) =>
	({ channel: "discord:1", text: "hi", ...extra }) as TurnRequest;

function parts(policy?: EffortPolicy) {
	const asked: unknown[] = [];
	const judged = new Map<`${string}:${string}`, ThinkingLevel>([
		["discord:1", "high"],
	]);
	return {
		asked,
		judged,
		parts: {
			modelRuntime: {} as never,
			judged,
			effort: {
				judge: async (_m: string, _p: unknown, rule: unknown) => {
					asked.push(rule);
					return "medium" as const;
				},
			},
			...(policy ? { policy } : {}),
		},
	};
}

describe("thinkingLevel with an effort policy", () => {
	test("without a policy the picker is asked with no rule", async () => {
		const p = parts();
		expect(await thinkingLevel(p.parts, "discord:1", session, request())).toBe(
			"medium",
		);
		expect(p.asked).toEqual([undefined]);
	});

	test("a fixed rule runs at that level without asking the judge", async () => {
		const seen: unknown[] = [];
		const p = parts((r) => {
			seen.push(r);
			return { fixed: "low" };
		});
		const level = await thinkingLevel(
			p.parts,
			"discord:1",
			session,
			request({ kind: "line-pm-auto" }),
		);
		expect(level).toBe("low");
		expect(p.asked).toEqual([]);
		expect(p.judged.has("discord:1")).toBe(false);
		expect(seen).toEqual([{ channel: "discord:1", kind: "line-pm-auto" }]);
	});

	test("a mass rule goes to the picker; undefined leaves the default", async () => {
		const mass = { requiredMass: [0, 0.95, 0.8, 0.8] } as const;
		const p = parts((r) =>
			r.channel.startsWith("discord:") ? mass : undefined,
		);
		await thinkingLevel(p.parts, "discord:1", session, request());
		await thinkingLevel(
			p.parts,
			"web:1",
			session,
			request({ channel: "web:1" }),
		);
		expect(p.asked).toEqual([mass, undefined]);
	});
});
