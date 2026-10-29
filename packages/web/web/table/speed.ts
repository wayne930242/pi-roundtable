/**
 * The speed lines that flash for about 400 ms on a new speaker: an element over the scene with
 * a ring of thin rays pointing at the centre, faded in and out. It is CSS (a conic gradient behind a
 * radial mask), not a canvas and not post-processing, and under reduced motion it never plays.
 */

export const SPEED_MS = 400;

export interface SpeedLines {
	/** Plays the lines once; false when reduced motion keeps them off. */
	play(): boolean;
	dispose(): void;
}

export function createSpeedLines(
	host: HTMLElement,
	reduced: () => boolean,
): SpeedLines {
	const el = document.createElement("div");
	el.className = "rt-speed";
	el.setAttribute("aria-hidden", "true");
	el.style.cssText =
		"position:absolute;inset:0;pointer-events:none;opacity:0;" +
		"background:repeating-conic-gradient(from 3deg at 50% 52%,rgba(255,255,255,.85) 0 .55deg,transparent .55deg 5.2deg);" +
		"-webkit-mask-image:radial-gradient(ellipse at 50% 52%,transparent 34%,#000 74%);" +
		"mask-image:radial-gradient(ellipse at 50% 52%,transparent 34%,#000 74%);";
	host.appendChild(el);
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		play() {
			if (reduced()) return false;
			el.dataset.playing = "";
			if (typeof el.animate === "function") {
				el.animate(
					[
						{ opacity: 0, transform: "scale(1.18)" },
						{ opacity: 0.9, transform: "scale(1.04)", offset: 0.3 },
						{ opacity: 0, transform: "scale(1)" },
					],
					{ duration: SPEED_MS, easing: "ease-out" },
				);
			} else el.style.opacity = "0.9";
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(() => {
				delete el.dataset.playing;
				el.style.opacity = "0";
			}, SPEED_MS);
			return true;
		},
		dispose() {
			if (timer !== undefined) clearTimeout(timer);
			el.remove();
		},
	};
}
