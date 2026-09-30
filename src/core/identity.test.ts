import { expect, test } from "bun:test";
import { ownerWords } from "./identity.ts";

test("owner words capitalize the subject and possessive for a sentence's start", () => {
	expect(
		ownerWords({
			name: "Alice",
			pronouns: { subject: "she", object: "her", possessive: "her" },
		}),
	).toEqual({
		name: "Alice",
		he: "she",
		He: "She",
		him: "her",
		his: "her",
		His: "Her",
	});
});
