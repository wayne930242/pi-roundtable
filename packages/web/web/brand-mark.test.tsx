import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandMark } from "./components/brand-mark.tsx";
import { setRouting } from "./lib/router.ts";

afterEach(() => setRouting(undefined));

test("the brand mark is the install icon under the mount path, decorative", () => {
	setRouting("/app", "rooms");
	const html = renderToStaticMarkup(<BrandMark />);
	expect(html).toContain('src="/app/icons/192.png"');
	expect(html).toContain('alt=""');
});

test("an unmounted page takes the icon relative to itself", () => {
	setRouting(undefined);
	expect(renderToStaticMarkup(<BrandMark />)).toContain(
		'src="./icons/192.png"',
	);
});
