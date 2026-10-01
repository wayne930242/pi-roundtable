import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const site = "https://pi-roundtable.wayneh.tw";
const description =
	"An AI roundtable that creates its own personas and skills: a Discord agent server on Pi, extended with TypeScript plugins.";

export default defineConfig({
	site,
	integrations: [
		starlight({
			title: "pi-roundtable",
			description,
			favicon: "/favicon.svg",
			logo: { src: "./src/assets/logo.svg", alt: "roundtable" },
			head: [
				{
					tag: "link",
					attrs: {
						rel: "icon",
						href: "/favicon-32.png",
						sizes: "32x32",
						type: "image/png",
					},
				},
				{
					tag: "link",
					attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
				},
				{
					tag: "meta",
					attrs: { property: "og:image", content: `${site}/og.png` },
				},
				{ tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
				{ tag: "meta", attrs: { property: "og:image:height", content: "630" } },
				{
					tag: "meta",
					attrs: {
						property: "og:image:alt",
						content:
							"roundtable: an AI roundtable that creates its own personas and skills",
					},
				},
				{
					tag: "meta",
					attrs: { name: "twitter:image", content: `${site}/og.png` },
				},
				{
					tag: "script",
					attrs: { type: "application/ld+json" },
					content: JSON.stringify({
						"@context": "https://schema.org",
						"@type": "SoftwareSourceCode",
						name: "pi-roundtable",
						description,
						url: site,
						license: "https://opensource.org/licenses/MIT",
						programmingLanguage: "TypeScript",
						codeRepository: "https://github.com/wayne930242/pi-roundtable",
					}),
				},
			],
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
