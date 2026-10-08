import type { Pronouns } from "./config/config.ts";

/** Who the agents work for, as prompts and tool descriptions name them. */
export interface OwnerIdentity {
	name: string;
	/** How prompts refer back to the owner, such as they, them, their. */
	pronouns: { subject: string; object: string; possessive: string };
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Each pronoun choice in the words prompts use. */
export const PRONOUNS: Readonly<Record<Pronouns, OwnerIdentity["pronouns"]>> = {
	he: { subject: "he", object: "him", possessive: "his" },
	she: { subject: "she", object: "her", possessive: "her" },
	they: { subject: "they", object: "them", possessive: "their" },
};

/**
 * How prompts name a person: by their pronouns when they gave them, and otherwise by their name,
 * since a name needs no guess at pronouns.
 */
export function addresseeOf(person: {
	displayName: string;
	pronouns?: Pronouns;
}): OwnerIdentity {
	const name = person.displayName;
	return {
		name,
		pronouns: person.pronouns
			? PRONOUNS[person.pronouns]
			: { subject: name, object: name, possessive: `${name}'s` },
	};
}

/** The name and pronouns of whom prompt text addresses, capitalized for a sentence's start. */
export function addresseeWords(addressee: OwnerIdentity): OwnerWords {
	const { subject, object, possessive } = addressee.pronouns;
	return {
		name: addressee.name,
		he: subject,
		He: capital(subject),
		him: object,
		his: possessive,
		His: capital(possessive),
	};
}

/** `addresseeWords`, by its name from when every prompt addressed the owner. */
export const ownerWords = addresseeWords;

/** The words of whom prompt text addresses, as `addresseeWords` gives them. */
export interface OwnerWords {
	name: string;
	he: string;
	He: string;
	him: string;
	his: string;
	His: string;
}
