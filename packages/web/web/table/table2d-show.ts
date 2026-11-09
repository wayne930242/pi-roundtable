import type { Hall } from "./hall";
import { PUFF_MS, type planSeating, RISE_MS } from "./seating";
import { el } from "./table2d-svg";

/** The pieces of a show that are in the picture only for a while: the rings under those who join and the puffs over those who leave. */
export function showChange(
	svg: SVGSVGElement,
	hall: Hall,
	ephemera: Set<ReturnType<typeof setTimeout>>,
	plan: ReturnType<typeof planSeating>,
	standing: ReadonlyMap<string, SVGGElement>,
): void {
	if (plan.mode === "cut") return;
	const later = (run: () => void, ms: number) => {
		const timer = setTimeout(() => {
			ephemera.delete(timer);
			run();
		}, ms);
		ephemera.add(timer);
	};
	for (const id of plan.joining) {
		const seat = [
			...svg.querySelectorAll<SVGGElement>("g.seat[data-seat]"),
		].find((g) => g.getAttribute("data-seat") === id);
		if (!seat) continue;
		seat.classList.add("seat-in");
		seat.prepend(
			el("ellipse", {
				class: "seat-ring",
				rx: 44,
				ry: 12,
				cy: 4,
				stroke: hall.css.ring,
			}),
		);
		later(() => {
			seat.classList.remove("seat-in");
			seat.querySelector(".seat-ring")?.remove();
		}, RISE_MS);
	}
	for (const id of plan.leaving) {
		const old = standing.get(id);
		if (!old) continue;
		const ghost = old.cloneNode(true) as SVGGElement;
		ghost.classList.add("seat-out");
		for (const name of ["data-seat", "tabindex", "role", "aria-label"])
			ghost.removeAttribute(name);
		ghost.setAttribute("aria-hidden", "true");
		for (const [i, [x, y, r]] of (
			[
				[-26, -24, 20],
				[24, -20, 22],
				[0, -52, 24],
				[-4, -4, 26],
			] as const
		).entries()) {
			const puff = el(
				"circle",
				{
					class: "puff",
					cx: x,
					cy: y,
					r,
					fill: hall.paper,
					stroke: hall.ink,
					"stroke-width": 3,
				},
				ghost,
			);
			puff.style.animationDelay = `${i * 40}ms`;
		}
		svg.appendChild(ghost);
		later(() => ghost.remove(), PUFF_MS);
	}
}
