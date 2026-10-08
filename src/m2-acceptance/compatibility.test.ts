import { expect, test } from "bun:test";
import {
	OWNER_TARGET,
	type OwnerPrompts,
	PERSONAL_TARGET,
	type Prompts,
} from "../index.ts";

// §6.4 of the M2 plan: 0.8's names a plugin may import from the public entry still work in 0.9,
// marked @deprecated until 1.0. src/m2-acceptance/acceptance-index.test.ts lists where the rest of
// §6.4 is tested: an actor-less surface, prompts(channel, speaker), and notify_owner.

/** True when the two types are the same type, not merely assignable one way. */
type Same<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

test("OWNER_TARGET is PERSONAL_TARGET, and OwnerPrompts is Prompts, from the public entry", () => {
	expect(OWNER_TARGET).toBe(PERSONAL_TARGET);
	expect(OWNER_TARGET.name).toBe("owner");
	const same: Same<OwnerPrompts, Prompts> = true;
	expect(same).toBe(true);
});
