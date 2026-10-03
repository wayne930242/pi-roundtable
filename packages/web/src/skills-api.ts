import type { SkillDetailView, SkillView } from "./api-types.ts";
import type { ConsoleFeatures } from "./features.ts";
import { ConsoleHttpError as HttpError } from "./http.ts";

/** Strip private file paths from a host catalog explicitly. */
export function skillCatalog(
	skills: NonNullable<ConsoleFeatures["skills"]>,
): SkillView[] {
	return skills
		.catalog()
		.map(({ name, source, description, missing, groups, carriers }) => ({
			name,
			source,
			...(description ? { description } : {}),
			...(missing ? { missing } : {}),
			groups,
			carriers,
		}));
}

/** Read a catalog-selected skill, bound its document, and return ordered frontmatter. */
export async function skillDetail(
	skills: NonNullable<ConsoleFeatures["skills"]>,
	name: string,
): Promise<SkillDetailView> {
	const entry = skills.catalog().find((s) => s.name === name);
	if (!entry) throw new HttpError(404, "There is no such skill.");
	if (entry.missing)
		throw skills.errorDetail
			? new HttpError(404, "The skill file is missing: ", entry.missing)
			: new HttpError(404, "The skill file is missing.");
	try {
		// The host's `read` enforces any size limit; the console shows what it returns.
		const parsed = await skills.read(name);
		return {
			name,
			body: parsed.body,
			metadata: metadataEntries(parsed.frontmatter),
		};
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw skills.errorDetail
			? new HttpError(
					422,
					"The skill frontmatter could not be read: ",
					(error instanceof Error ? error.message : String(error)).slice(
						0,
						300,
					),
				)
			: new HttpError(422, "The skill frontmatter could not be read.");
	}
}

/** Flatten nested frontmatter in source order, keeping scalar/array values readable. */
function metadataEntries(
	record: Record<string, unknown>,
	prefix = "",
	depth = 0,
): SkillDetailView["metadata"] {
	return Object.entries(record).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		if (
			depth < 20 &&
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value)
		)
			return metadataEntries(value as Record<string, unknown>, path, depth + 1);
		return [
			{
				key: path,
				value: Array.isArray(value)
					? value
							.map((v) =>
								typeof v === "object" ? JSON.stringify(v) : String(v ?? ""),
							)
							.join(", ")
					: typeof value === "object" && value !== null
						? JSON.stringify(value)
						: String(value ?? ""),
			},
		];
	});
}
