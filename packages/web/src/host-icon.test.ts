import { expect, test } from "bun:test";
import { HOST_ICONS } from "./api-types.ts";
import { hostIcon } from "./web-app.ts";

test("a host's icon is one of the console's names, and anything else shows the default", () => {
	for (const name of HOST_ICONS) expect(hostIcon(name)).toBe(name);
	for (const name of ["Chat", "<svg>", "", 7, null, undefined, {}])
		expect(hostIcon(name)).toBeUndefined();
	// What the brief asked hosts could use.
	for (const name of [
		"chat",
		"link",
		"activity",
		"users",
		"megaphone",
		"qr",
		"settings",
	])
		expect(HOST_ICONS as readonly string[]).toContain(name);
});
