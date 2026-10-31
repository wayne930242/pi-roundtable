import type { Migration } from "pi-roundtable";

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

/**
 * Turns the jsonb columns that hold the text of a value, as a JSON string, into the value
 * itself. Inserts once bound `${JSON.stringify(x)}::jsonb`, which Postgres stores as a jsonb
 * string; none of these columns holds a string on purpose.
 */
export function jsonValuesMigration(
	name: string,
	table: string,
	columns: readonly string[],
): Migration {
	return {
		name,
		up: async (sql) => {
			for (const column of columns)
				await sql.unsafe(
					`UPDATE ${table} SET ${column} = (${column} #>> '{}')::jsonb WHERE jsonb_typeof(${column}) = 'string'`,
				);
		},
	};
}
