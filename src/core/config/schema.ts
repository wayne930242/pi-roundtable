import { ConfigError } from "../domain/errors.ts";
import { nearest } from "../registry/contributions.ts";

/**
 * One field of a configuration: how to check a value and what to say when it is wrong. A
 * checker returns the value it accepts, so a field may also normalize.
 */
export interface Field<T> {
	/** What the field holds, for the message: `a string`, `one of a, b`. */
	describe: string;
	check(value: unknown, path: string): T;
}

const wrong = (path: string, wanted: string, got: unknown): ConfigError =>
	new ConfigError(
		`config ${path}: expected ${wanted}, got ${
			got === undefined ? "nothing" : JSON.stringify(got)
		}. Fix the value in roundtable.config.ts.`,
	);

/** A non-empty string. */
export const text: Field<string> = {
	describe: "a non-empty string",
	check: (value, path) => {
		if (typeof value !== "string" || value.trim() === "")
			throw wrong(path, "a non-empty string", value);
		return value;
	},
};

/** True or false. */
export const bool: Field<boolean> = {
	describe: "true or false",
	check: (value, path) => {
		if (typeof value !== "boolean") throw wrong(path, "true or false", value);
		return value;
	},
};

/** An integer from `min` to `max`. */
export const integer = (min: number, max: number): Field<number> => ({
	describe: `an integer from ${min} to ${max}`,
	check: (value, path) => {
		if (
			!Number.isInteger(value) ||
			(value as number) < min ||
			(value as number) > max
		)
			throw wrong(path, `an integer from ${min} to ${max}`, value);
		return value as number;
	},
});

/** A number from `min` to `max`. */
export const number = (min: number, max: number): Field<number> => ({
	describe: `a number from ${min} to ${max}`,
	check: (value, path) => {
		if (
			typeof value !== "number" ||
			Number.isNaN(value) ||
			value < min ||
			value > max
		)
			throw wrong(path, `a number from ${min} to ${max}`, value);
		return value;
	},
});

/** One of the listed strings. */
export const oneOf = <T extends string>(
	...allowed: readonly T[]
): Field<T> => ({
	describe: `one of ${allowed.join(", ")}`,
	check: (value, path) => {
		if (typeof value !== "string" || !allowed.includes(value as T))
			throw wrong(path, `one of ${allowed.join(", ")}`, value);
		return value as T;
	},
});

/** A list whose items each pass `item`. */
export const list = <T>(item: Field<T>): Field<T[]> => ({
	describe: `a list of ${item.describe}`,
	check: (value, path) => {
		if (!Array.isArray(value))
			throw wrong(path, `a list of ${item.describe}`, value);
		return value.map((entry, index) => item.check(entry, `${path}[${index}]`));
	},
});

/** An object whose every value passes `item`, keyed by any string. */
export const record = <T>(item: Field<T>): Field<Record<string, T>> => ({
	describe: `an object of ${item.describe}`,
	check: (value, path) => {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw wrong(path, `an object of ${item.describe}`, value);
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				item.check(entry, `${path}.${key}`),
			]),
		);
	},
});

/** A value a caller-supplied predicate accepts, such as a plugin object. */
export const guarded = <T>(
	describe: string,
	accepts: (value: unknown) => value is T,
): Field<T> => ({
	describe,
	check: (value, path) => {
		if (!accepts(value)) throw wrong(path, describe, value);
		return value;
	},
});

/** A field that may be left out. */
export type Optional<T> = { optional: Field<T> };

export const optional = <T>(field: Field<T>): Optional<T> => ({
	optional: field,
});

type Shape = Record<string, Field<unknown> | Optional<unknown>>;

type Checked<S extends Shape> = {
	[K in keyof S as S[K] extends Optional<unknown>
		? never
		: K]: S[K] extends Field<infer T> ? T : never;
} & {
	[K in keyof S as S[K] extends Optional<unknown>
		? K
		: never]?: S[K] extends Optional<infer T> ? T : never;
};

const isOptional = (
	field: Field<unknown> | Optional<unknown>,
): field is Optional<unknown> => "optional" in field;

/**
 * An object with the named fields. A key the shape does not name is an error that names the
 * nearest key that is; a missing required key names the key.
 */
export function shape<S extends Shape>(fields: S): Field<Checked<S>> {
	const keys = Object.keys(fields);
	return {
		describe: `an object with ${keys.join(", ")}`,
		check: (value, path) => {
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw wrong(path, "an object", value);
			const given = value as Record<string, unknown>;
			for (const key of Object.keys(given)) {
				if (keys.includes(key)) continue;
				const meant = nearest(key, keys);
				throw new ConfigError(
					`config ${path === "" ? key : `${path}.${key}`}: unknown key.${
						meant ? ` Did you mean "${meant}"?` : ""
					} The keys here are ${keys.join(", ")}.`,
				);
			}
			const out: Record<string, unknown> = {};
			for (const key of keys) {
				const field = fields[key];
				if (!field) continue;
				const at = path === "" ? key : `${path}.${key}`;
				const raw = given[key];
				if (isOptional(field)) {
					if (raw !== undefined) out[key] = field.optional.check(raw, at);
					continue;
				}
				if (raw === undefined)
					throw new ConfigError(
						`config ${at}: required, expected ${field.describe}. Add it to roundtable.config.ts.`,
					);
				out[key] = field.check(raw, at);
			}
			return out as Checked<S>;
		},
	};
}
