import { readFileSync, statSync } from "node:fs";
import { AgentError } from "../../domain/errors.ts";
import {
	hashOf,
	MAX_DOCUMENT_BYTES,
	type SkillDocument,
	type SkillSource,
	type SkillVersion,
	skillFileContent,
} from "./skill-rules.ts";
import type { SkillEntry, StoredSkillVersion } from "./skill-store.ts";

/** An agent-written skill as the owner edits it: its SKILL.md, with the hash a save is checked against. */
export function writtenDocument(
	entry: Extract<SkillEntry, { kind: "written" }>,
): SkillDocument {
	const text = skillFileContent(entry);
	return {
		name: entry.name,
		source: { kind: "written" },
		text,
		hash: hashOf(text),
		writable: true,
	};
}

/** A skill the owner may read but not edit: its file as it is on disk, if it is small enough to show. */
export function readSkillDocument(
	name: string,
	source: SkillSource,
	file: string,
): SkillDocument {
	let size: number;
	try {
		size = statSync(file).size;
	} catch {
		throw new AgentError(`The file of the skill "${name}" cannot be read.`);
	}
	if (size > MAX_DOCUMENT_BYTES)
		throw new AgentError(
			`The file of the skill "${name}" is too large to show.`,
		);
	const text = readFileSync(file, "utf8");
	return { name, source, text, hash: hashOf(text), writable: false };
}

/** The stored versions of a written skill as whole documents, in the order given. */
export function skillVersions(
	name: string,
	rows: readonly StoredSkillVersion[],
): SkillVersion[] {
	return rows.map((version) => {
		const text = skillFileContent({
			name,
			description: version.description,
			body: version.body,
		});
		return {
			id: version.id,
			text,
			hash: hashOf(text),
			by: version.by,
			at: version.at,
		};
	});
}
