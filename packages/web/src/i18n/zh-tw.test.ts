import { describe, expect, test } from "bun:test";
import { CATALOG } from "pi-roundtable/characters";
import { message } from "../features.ts";
import { clientMessages, serverMessages } from "../testing/source-messages.ts";
import { builtInMessages, isTraditionalChineseTaiwan } from "./index.ts";
import { ZH_TW } from "./zh-tw.ts";

const client = clientMessages();
const server = serverMessages();

/** The keys `characterLabel` and `characterJobs` ask for: what the character creator names. */
function characterKeys(): string[] {
	const classes = Object.keys(CATALOG.classes);
	const parts: Record<string, readonly string[]> = {
		outfit: CATALOG.outfits,
		hat: CATALOG.hats,
		prop: CATALOG.props,
		hair: CATALOG.hair,
		beard: ["none", ...CATALOG.beards],
		accessory: ["none", ...CATALOG.accessories],
		palette: Object.keys(CATALOG.palettes),
		class: classes,
	};
	return [
		...Object.entries(parts).flatMap(([kind, ids]) =>
			ids.map((id) => `character.${kind}.${id}`),
		),
		...classes.map((id) => `character.jobs.${id}`),
	];
}

const missing = (keys: Iterable<string>): string[] =>
	[...keys].filter((key) => !(key in ZH_TW));

describe("the built-in zh-TW catalog", () => {
	test("says 夥伴, never 助理", () => {
		const hits = Object.entries(ZH_TW).filter(([, text]) =>
			text.includes("助理"),
		);
		expect(hits).toEqual([]);
	});

	test("covers every string the browser app translates", () => {
		expect(missing(client.client.keys())).toEqual([]);
	});

	test("covers the fixed wording of the server's refusals and login page", () => {
		expect(missing(server.keys())).toEqual([]);
	});

	test("covers every class, part and palette the character creator names, and what each class suits", () => {
		expect(missing(characterKeys())).toEqual([]);
	});

	test("reads a translation call only when its key is a literal or comes from a table of marked strings", () => {
		// A call whose key is not a literal reads from a `wording(...)` table, the server's text, or a key built from the catalog.
		expect([...client.dynamic].sort()).toEqual(
			[
				"web/app.tsx: t(LABELS[pane])",
				"web/components/agent-sheet.tsx: t(THINKING_LABELS[level])",
				"web/components/agent-sheet.tsx: t(THINKING_LABELS[value as (typeof THINKING)[number]] ?? value)",
				"web/components/cards.tsx: t(OUTCOMES[outcome])",
				"web/components/character-creator.tsx: t(BUILD_LABELS[build])",
				"web/components/character-creator.tsx: t(STATE_LABELS[state])",
				"web/components/character-creator.tsx: t(STATE_LABELS[state])",
				"web/components/character-creator.tsx: t(part.title)",
				"web/components/character-creator.tsx: t(part.title)",
				"web/components/composer.tsx: t(plan.text)",
				"web/components/round-table.tsx: t(SEAT_STATE_LABELS[state])",
				"web/lib/api.ts: t(text)",
				"web/lib/character-labels.ts: translate(key)",
				"web/lib/character-labels.ts: translate(key)",
				"web/lib/prompt-text.ts: t(CORE[source] ?? source)",
				"web/pages/conversations.tsx: t(section.note)",
				"web/pages/conversations.tsx: t(section.title)",
				"web/pages/notes.tsx: t(entry.label)",
				"web/pages/notes.tsx: t(entry.label)",
				'web/pages/notes.tsx: t(KINDS.find((entry) => entry.kind === kind)?.hint ?? "")',
				"web/pages/overview.tsx: t(labels[p.container])",
				"web/pages/profile.tsx: t(TIER_LABELS[session.tier])",
				"web/pages/schedules.tsx: t(WEEKDAYS[String(day)] ?? String(day))",
				"web/pages/settings.tsx: t(option.label)",
				'web/pages/settings.tsx: t(LOOKS.find((option) => option.value === look)?.hint ?? "")',
				"web/pages/settings.tsx: t(theme.label)",
				"web/pages/transcript.tsx: t(LABELS[entry.role])",
				"web/pages/workspace.tsx: t(REASONS[reason])",
			].sort(),
		);
	});

	test("holds nothing the code no longer asks for", () => {
		const used = new Set([...client.client.keys(), ...server.keys()]);
		const extra = Object.keys(ZH_TW).filter(
			(key) => !used.has(key) && !characterKeys().includes(key),
		);
		expect(extra).toEqual([]);
	});

	test("keeps every {placeholder} of its English key", () => {
		const tokens = (text: string) =>
			[...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		for (const [key, wording] of Object.entries(ZH_TW))
			expect({ key, tokens: tokens(wording) }).toEqual({
				key,
				tokens: tokens(key),
			});
	});

	test("words the boss's terms as decided", () => {
		expect(ZH_TW.Agents).toBe("夥伴");
		expect(ZH_TW.Rooms).toBe("聊天室");
		expect(ZH_TW["Round table"]).toBe("圓桌");
		expect(ZH_TW.More).toBe("更多");
		expect(ZH_TW.Notes).toBe("記憶");
		expect(ZH_TW.Skills).toBe("技能");
		expect(ZH_TW.Connectors).toBe("連接器");
		expect(ZH_TW.Settings).toBe("設定");
		expect(ZH_TW["character.class.wizard"]).toBe("巫師");
		expect(ZH_TW["character.class.knight"]).toBe("騎士");
		expect(ZH_TW["character.class.healer"]).toBe("治療師");
		expect(ZH_TW["character.class.navigator"]).toBe("領航員");
		expect(ZH_TW["character.class.engineer"]).toBe("工程師");
	});

	test("is Traditional Chinese with full-width punctuation, and no Simplified-only characters", () => {
		const simplified =
			/[这个们为说对时务设开关还进过种无与联线级动态览页载连户键签账记库项显删复确认检请应读写样图头边称]/;
		const half =
			/[\u4e00-\u9fff][,;:?!()]|[,;:?!)]\s*[\u4e00-\u9fff]|[\u4e00-\u9fff]\(|\)[\u4e00-\u9fff]/;
		const offenders = Object.entries(ZH_TW).filter(
			([, wording]) => simplified.test(wording) || half.test(wording),
		);
		expect(offenders).toEqual([]);
	});

	test("names no word the console's own vocabulary avoids", () => {
		// Taiwan usage: these Mainland terms must not appear.
		const mainland =
			/服务器|文件夹|设置|信息|默认|软件|用户名|网络|登录|退出登录/;
		expect(
			Object.entries(ZH_TW).filter(([, wording]) => mainland.test(wording)),
		).toEqual([]);
	});
});

describe("choosing the catalog by locale", () => {
	test("accepts Traditional Chinese as written in Taiwan in its usual forms", () => {
		for (const locale of [
			"zh-TW",
			"zh-tw",
			"zh_TW",
			"zh-Hant-TW",
			"zh-hant-tw",
			"zh-Hant",
			"zh-TW-u-ca-roc",
		])
			expect([locale, isTraditionalChineseTaiwan(locale)]).toEqual([
				locale,
				true,
			]);
	});

	test("leaves other locales in English", () => {
		for (const locale of [
			"en",
			"en-GB",
			"zh",
			"zh-CN",
			"zh-Hans",
			"zh-Hans-CN",
			"zh-HK",
			"zh-Hant-HK",
			"ja",
			"not a locale",
			"",
		])
			expect([locale, builtInMessages(locale)]).toEqual([locale, undefined]);
		expect(builtInMessages(undefined)).toBeUndefined();
	});

	test("the host's messages win key by key, and the catalog fills the rest", () => {
		const presentation = {
			locale: "zh-TW",
			messages: { Rooms: "Host rooms", Settings: "" },
		};
		expect(message(presentation, "Rooms")).toBe("Host rooms");
		// An empty string is the host's wording too.
		expect(message(presentation, "Settings")).toBe("");
		expect(message(presentation, "More")).toBe(ZH_TW.More as string);
		expect(message(presentation, "A key nobody worded")).toBe(
			"A key nobody worded",
		);
	});

	test("without a locale, or with another, nothing is translated and a host's wording still applies", () => {
		expect(message(undefined, "Rooms")).toBe("Rooms");
		expect(message({ locale: "fr" }, "Rooms")).toBe("Rooms");
		expect(
			message({ locale: "fr", messages: { Rooms: "Salons" } }, "Rooms"),
		).toBe("Salons");
	});
});
