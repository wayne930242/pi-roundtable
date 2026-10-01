/** Who the agents work for, as prompts and tool descriptions name them. */
export interface OwnerIdentity {
	name: string;
	/** How prompts refer back to the owner, such as they, them, their. */
	pronouns: { subject: string; object: string; possessive: string };
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The owner's name and pronouns as prompt text uses them, capitalized for a sentence's start. */
export function ownerWords(owner: OwnerIdentity): OwnerWords {
	const { subject, object, possessive } = owner.pronouns;
	return {
		name: owner.name,
		he: subject,
		He: capital(subject),
		him: object,
		his: possessive,
		His: capital(possessive),
	};
}

/** The owner's words as `ownerWords` gives them. */
export interface OwnerWords {
	name: string;
	he: string;
	He: string;
	him: string;
	his: string;
	His: string;
}
