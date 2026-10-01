/** Members a probe may ask of any object: a test's stand-in is not refused for them. */
const PROBED = new Set(["then", "toJSON", "asymmetricMatch"]);

/**
 * A stand-in for a port the code under test takes, made of only the members the test gives.
 * Reading any other member throws an error that names it, so a test learns at once which member
 * the code reaches for, instead of meeting `undefined is not a function` or a hidden cast.
 * `partial<AgentTeam>({ announce })` is an `AgentTeam` to the type checker.
 */
export function partial<T extends object>(given: Partial<T>): T {
	// SAFETY: the stand-in answers only the members given; any other read throws before it is used.
	return new Proxy(given, {
		get(target, member, receiver) {
			if (member in target || typeof member === "symbol" || PROBED.has(member))
				return Reflect.get(target, member, receiver);
			throw new Error(
				`partial() was given no "${member}". Give it where the stand-in is made: partial({ ${member}: ... }).`,
			);
		},
	}) as T;
}
