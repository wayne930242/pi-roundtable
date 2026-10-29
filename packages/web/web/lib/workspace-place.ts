// Where the files pane is, as the router carries it, and the path arithmetic it shares.

/** A path's parts: `a/b/c` is `["a", "b", "c"]`, and the top is `[]`. */
export const segmentsOf = (path: string): string[] =>
	path.split("/").filter(Boolean);

/** The directory a path is in; the top for a name at the top. */
export const parentOf = (path: string): string =>
	segmentsOf(path).slice(0, -1).join("/");

/** The path of `name` inside the directory `dir`. */
export const join = (dir: string, name: string): string =>
	dir ? `${dir}/${name}` : name;

/**
 * A place in the pane as the router carries it: `root:path`, with a trailing `/` for a folder.
 * The root's id is a lower-case word, so the first `:` ends it.
 */
export interface Place {
	root: string;
	path: string;
	dir: boolean;
}

export const placeKey = (place: Place): string =>
	`${place.root}:${place.path}${place.dir && place.path ? "/" : ""}`;

export function placeOf(key: string | undefined): Place | undefined {
	if (!key) return undefined;
	const colon = key.indexOf(":");
	if (colon < 1) return undefined;
	const rest = key.slice(colon + 1);
	return {
		root: key.slice(0, colon),
		path: rest.replace(/\/+$/, ""),
		dir: rest === "" || rest.endsWith("/"),
	};
}
