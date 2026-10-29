import type { PersonProfiles } from "./profiles.ts";

/**
 * The directory as plugins get it: the `PersonProfiles` methods and nothing else, so no plugin
 * reaches the name the core gives agents. Each answer is a frozen copy.
 */
export function profilesView(directory: PersonProfiles): PersonProfiles {
	return Object.freeze({
		register: (source) => directory.register(source),
		sources: () =>
			Object.freeze(directory.sources().map((s) => Object.freeze({ ...s }))),
		observed: (principalId, provider, name) =>
			directory.observed(principalId, provider, name),
		sourceOf: (principalId) => directory.sourceOf(principalId),
		choose: (principalId, provider) => directory.choose(principalId, provider),
		of: async (principalId) =>
			Object.freeze({ ...(await directory.of(principalId)) }),
		picture: (principalId) => directory.picture(principalId),
	} satisfies PersonProfiles);
}
