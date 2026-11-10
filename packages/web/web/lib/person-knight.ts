// The knights people made for themselves, as the page learns them. The viewer's own comes with the
// socket's `ready` and lives in the store; another person's is asked for once per page life.

import type { CharacterSpec } from "pi-roundtable/characters";
import { useEffect, useMemo, useState } from "react";
import { useSelector } from "./app-store.ts";
import { loadKit, useKit } from "./kit.ts";

/** What the server answered for a person: their knight, or `null` for a person who has none. */
const known = new Map<string, CharacterSpec | null>();
/** The fetches under way and done, so every picture of one person shares a single request. */
const asked = new Map<string, Promise<CharacterSpec | null>>();

async function ask(id: string): Promise<CharacterSpec | null> {
	const [kit, response] = await Promise.all([
		loadKit(),
		fetch(`api/people/${encodeURIComponent(id)}/character`),
	]);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`the knight answered ${response.status}`);
	const body = (await response.json()) as { character?: unknown };
	try {
		return kit.parseCharacter(body.character);
	} catch {
		// A look this page's kit does not take is no knight: the account picture shows.
		return null;
	}
}

/** Another person's knight, fetched once; a fetch that failed is tried again by the next picture. */
export function knightOf(id: string): Promise<CharacterSpec | null> {
	let waiting = asked.get(id);
	if (!waiting) {
		waiting = ask(id).then(
			(knight) => {
				known.set(id, knight);
				return knight;
			},
			() => {
				asked.delete(id);
				return null;
			},
		);
		asked.set(id, waiting);
	}
	return waiting;
}

/**
 * The knight to draw for a person: a spec, `null` when they have none (their account picture
 * shows), and `undefined` while the page does not know yet.
 */
export function usePersonKnight(id: string): CharacterSpec | null | undefined {
	const me = useSelector((state) => state.principal);
	const own = id === me?.id;
	const kit = useKit();
	const mine = useMemo(() => {
		if (!own || !me?.character) return null;
		if (!kit) return undefined;
		try {
			return kit.parseCharacter(me.character);
		} catch {
			// A look this page's kit does not take is no knight: the account picture shows.
			return null;
		}
	}, [own, me?.character, kit]);
	const [answer, setAnswer] = useState<{
		id: string;
		knight: CharacterSpec | null;
	}>();
	useEffect(() => {
		if (own || known.has(id)) return;
		let current = true;
		knightOf(id).then((knight) => {
			if (current) setAnswer({ id, knight });
		});
		return () => {
			current = false;
		};
	}, [id, own]);
	if (own) return mine;
	const settled = known.get(id);
	if (settled !== undefined) return settled;
	return answer?.id === id ? answer.knight : undefined;
}
