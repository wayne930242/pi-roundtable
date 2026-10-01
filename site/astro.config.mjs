import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://pi-roundtable.wayneh.tw",
	integrations: [
		starlight({
			title: "pi-roundtable",
			description:
				"A plugin-driven Pi agent server for Discord: a team of AI agents in one server, extended with TypeScript plugins.",
			defaultLocale: "root",
			locales: {
				root: { label: "English", lang: "en" },
				"zh-tw": { label: "繁體中文", lang: "zh-TW" },
			},
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/wayne930242/pi-roundtable",
				},
			],
			sidebar: [
				{
					label: "Guides",
					translations: { "zh-TW": "指南" },
					items: [
						{ slug: "guides/quick-start" },
						{ slug: "guides/write-a-plugin" },
						{ slug: "guides/configure" },
					],
				},
			],
		}),
	],
});
