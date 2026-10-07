import { expect, test } from "bun:test";
import { discord } from "./discord-adapter.ts";

test("discord() names the adapter and keeps the options as given", () => {
	const options = {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
		rootCommand: "rh",
	};
	expect(discord(options)).toEqual({ adapter: "discord", discord: options });
});
