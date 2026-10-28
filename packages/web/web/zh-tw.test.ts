import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loginPage } from "../src/auth/login-page.ts";
import { ZH_TW } from "../src/i18n/zh-tw.ts";
import { Cleanup } from "./components/cleanup.tsx";
import { characterJobs, characterLabel } from "./lib/character-labels.ts";
import { ConfigContext } from "./lib/config.ts";
import {
	loadBuiltInMessages,
	plural,
	setPresentation,
	translate,
} from "./lib/messages.ts";

const base = { title: "Console", panes: [] as never[], timeZone: "UTC" };
afterEach(async () => {
	setPresentation(base);
	await loadBuiltInMessages(undefined);
});

const cleanup = () =>
	renderToStaticMarkup(
		createElement(
			ConfigContext.Provider,
			{ value: { ...base, panes: ["overview" as const], cleanup: true } },
			createElement(Cleanup, {
				channel: "discord:900000000000000001",
				title: "Room",
				busy: false,
				deletable: true,
				refresh: () => undefined,
			}),
		),
	);

test("a zh-TW locale shows the built-in wording for what the host did not word", async () => {
	await loadBuiltInMessages("zh-TW");
	setPresentation({ ...base, locale: "zh-TW" });
	expect(translate("Rooms")).toBe(ZH_TW.Rooms as string);
	expect(translate("Reply count {count}", { count: 2 })).toBe("Reply count 2");
	expect(translate("{name} (you)", { name: "Bea" })).toBe(
		(ZH_TW["{name} (you)"] as string).replace("{name}", "Bea"),
	);
	expect(plural(1, "{count} file", "{count} files")).toBe(
		(ZH_TW["{count} file"] as string).replace("{count}", "1"),
	);
	const html = cleanup();
	expect(html).toContain(ZH_TW["Start over"] as string);
	expect(html).toContain(ZH_TW.Delete as string);
	expect(html).not.toContain("Start over");
});

test("the host's messages win over the built-in wording, key by key", async () => {
	await loadBuiltInMessages("zh-Hant-TW");
	setPresentation({
		...base,
		locale: "zh-Hant-TW",
		messages: { "Start over": "Host restart", Rooms: "Host rooms" },
	});
	expect(translate("Rooms")).toBe("Host rooms");
	const html = cleanup();
	expect(html).toContain("Host restart");
	expect(html).toContain(ZH_TW.Delete as string);
});

test("another locale stays in English, and nothing is fetched for it", async () => {
	await loadBuiltInMessages("fr");
	setPresentation({ ...base, locale: "fr" });
	expect(translate("Rooms")).toBe("Rooms");
	setPresentation({ ...base, locale: "en-GB" });
	expect(cleanup()).toContain("Start over");
});

test("class, part and palette names, and what a class suits, come from the catalog in zh-TW, and a host can reword one", async () => {
	await loadBuiltInMessages("zh-TW");
	setPresentation({
		...base,
		locale: "zh-TW",
		messages: { "character.class.wizard": "Host wizard" },
	});
	expect(characterLabel("class", "knight")).toBe(
		ZH_TW["character.class.knight"] as string,
	);
	expect(characterLabel("class", "wizard")).toBe("Host wizard");
	expect(characterLabel("palette", "azure")).toBe(
		ZH_TW["character.palette.azure"] as string,
	);
	expect(characterLabel("hat", "none")).toBe(
		ZH_TW["character.hat.none"] as string,
	);
	expect(characterJobs("smith")).toBe(ZH_TW["character.jobs.smith"] as string);
	await loadBuiltInMessages("en-GB");
	setPresentation({ ...base, locale: "en-GB" });
	expect(characterLabel("class", "knight")).toBe("Knight");
	expect(characterLabel("hat", "goggcap")).toBe("Goggle cap");
});

test("the sign-in page uses the built-in wording under a zh-TW locale", () => {
	const html = loginPage("/console", "Console", { locale: "zh-TW" });
	expect(html).toContain(`<html lang="zh-TW">`);
	expect(html).toContain(ZH_TW.Password as string);
	expect(html).toContain(ZH_TW["Sign in"] as string);
	expect(loginPage("/console", "Console", undefined)).toContain("Sign in");
});
