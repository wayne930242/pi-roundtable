import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HOST_ICONS } from "../src/api-types.ts";
import { Icon, type IconName } from "./components/icons.tsx";
import "./lib/host-icons.ts";

test("every icon a host may name is drawn by the console", () => {
	for (const name of HOST_ICONS) {
		const html = renderToStaticMarkup(<Icon name={name as IconName} />);
		expect(html, name).toMatch(/<path d="M[^"]+"/);
	}
});

test("a name the console does not have draws no path, so a page falls back to its default elsewhere", () => {
	expect(renderToStaticMarkup(<Icon name={"nope" as IconName} />)).not.toMatch(
		/<path d="/,
	);
});
