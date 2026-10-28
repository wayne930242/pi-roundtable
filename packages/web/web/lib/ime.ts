/**
 * Whether a key event belongs to an input method's composition. Chromium marks the committing
 * Enter with `isComposing`; Safari ends the composition first and reports `keyCode` 229 on the
 * keydown that follows, so both count.
 */
export const composingKey = (event: {
	isComposing: boolean;
	keyCode: number;
}): boolean => event.isComposing || event.keyCode === 229;
