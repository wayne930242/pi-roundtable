import type { RoundView } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { useCharacters } from "../lib/characters.ts";
import { translate as t } from "../lib/messages.ts";
import { facesOf, replyNumber } from "../lib/round-view.ts";
import { PageCharacter } from "./character.tsx";

/** The words of the round's chip: which reply it is on, or how it ended. */
function chipOf(round: {
	state: "running" | "ended";
	replies: number;
	limit: number;
	ended?: "done" | "limit" | "stopped" | undefined;
	n: number;
}): string {
	if (round.ended === "limit") return t("Limit reached");
	if (round.ended === "stopped") return t("Round stopped");
	if (round.ended === "done")
		return t("{count} of {limit} replies", {
			count: round.replies,
			limit: round.limit,
		});
	return t("Reply {n} of {limit}", { n: round.n, limit: round.limit });
}

/** The words of a round's chip, as the strip and the folded dialogue box show them. */
export const roundChip = (round: RoundView): string =>
	chipOf({ ...round, n: replyNumber(round) });

/**
 * The turn-taking of a group room's round, a strip on top of its dialogue box: the faces in the
 * order the round runs, those who spoke dimmed with a check, the one speaking now larger, those who
 * are next numbered, and a chip that says which reply the round is on out of the most it holds. It
 * is the same reading the seats of the ring wear, so the two always agree. Nothing shows until a
 * round has run in the room; the one that ended stays until the next starts.
 */
export function OrderStrip(props: { roomKey: string }) {
	const round = useSelector((state) => state.rooms[props.roomKey]?.round);
	const names = useSelector((state) => {
		const found: Record<string, string> = {};
		for (const one of Object.values(state.rooms))
			if (one.view?.kind === "agent")
				found[one.view.name] = one.view.displayName;
		return found;
	});
	const characters = useCharacters();
	if (!round) return null;
	const faces = facesOf(round);
	const label = (name: string) => names[name] ?? name;
	return (
		<div className="order-strip" data-state={round.state}>
			<ol className="order-faces" aria-label={t("Speaking order")}>
				{faces.map((face, index) => (
					<li
						// a member can stand twice in one round, as a handoff brings it back
						// biome-ignore lint/suspicious/noArrayIndexKey: the strip is a sequence and the same member may repeat
						key={`${face.name}:${index}`}
						className="order-face"
						data-place={face.place}
						title={label(face.name)}
					>
						<PageCharacter
							spec={characters[face.name]}
							name={face.name}
							size={face.place === "current" ? 36 : 26}
							live={false}
						/>
						<span className="order-badge" aria-hidden="true">
							{face.place === "spoken"
								? "✓"
								: face.place === "next"
									? face.order
									: null}
						</span>
						<span className="visually-hidden">
							{`${label(face.name)}, ${
								face.place === "spoken"
									? t("has spoken")
									: face.place === "current"
										? t("speaking")
										: t("next")
							}`}
						</span>
					</li>
				))}
			</ol>
			<span className="order-chip" aria-live="polite">
				{roundChip(round)}
			</span>
			{round.state === "running" && (round.queued ?? 0) > 0 ? (
				<span className="order-queued">
					{t("Your message waits for the next round")}
				</span>
			) : null}
		</div>
	);
}
