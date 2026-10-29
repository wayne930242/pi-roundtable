/**
 * A jsonb value as the driver returned it: already an object, or the text of one when the
 * driver left it as text. Anything else the database holds here is a stored value gone wrong,
 * which is named instead of surfacing as a bare parse error.
 */
export function storedJson<T>(value: T | string, what: string): T {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`the stored ${what} is not valid JSON`);
	}
}
