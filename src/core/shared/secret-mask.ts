import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** The names of host variables whose values are masked in tool output. */
export const SECRET_NAME: RegExp = Object.freeze(
	/(TOKEN|SECRET|KEY|PASS(WORD)?|DATABASE_URL|JWT|CREDENTIAL)/i,
);

/** Shorter values are too likely to be ordinary words to mask. */
const MIN_SECRET_CHARS = 8;

/** What a masked value is replaced with. */
export const MASK = "****";

/** The values of the variables `SECRET_NAME` matches, longest first, so a value inside another is masked as part of it. */
function secretValues(
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(env))
		if (
			value !== undefined &&
			value.length >= MIN_SECRET_CHARS &&
			SECRET_NAME.test(name)
		)
			values.add(value);
	return [...values].sort((a, b) => b.length - a.length);
}

/**
 * The text with every value of a secret variable of `env` replaced with `****`: a variable whose
 * name `SECRET_NAME` matches and whose value is at least 8 characters.
 */
export function maskSecrets(
	text: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	let masked = text;
	for (const value of secretValues(env))
		masked = masked.replaceAll(value, MASK);
	return masked;
}

/**
 * Masks secret values of `env` in the text of every tool result before it enters the model's
 * context; read again at each result, so a variable set later is masked too.
 */
export function secretMaskExtension(
	env: () => Readonly<Record<string, string | undefined>> = () => process.env,
): ExtensionFactory {
	return (pi) => {
		pi.on("tool_result", (event) => {
			const source = env();
			let changed = false;
			const content = event.content.map((part) => {
				if (part.type !== "text") return part;
				const text = maskSecrets(part.text, source);
				if (text === part.text) return part;
				changed = true;
				return { ...part, text };
			});
			return changed ? { content } : undefined;
		});
	};
}
