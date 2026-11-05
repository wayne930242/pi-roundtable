/** Freeze shared protocol data recursively, including symbol-keyed schema metadata. */
export function freeze<T extends object>(value: T): Readonly<T> {
	for (const key of Reflect.ownKeys(value)) {
		const child: unknown = (value as Record<PropertyKey, unknown>)[key];
		if (child && typeof child === "object" && !Object.isFrozen(child))
			freeze(child);
	}
	return Object.freeze(value);
}
