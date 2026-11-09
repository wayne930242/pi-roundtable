import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlateContext } from "./table/plate.ts";

export const recorder = () => {
	const calls: string[] = [];
	const g: PlateContext = {
		font: "",
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		textAlign: "left",
		textBaseline: "alphabetic",
		measureText(text: string) {
			const px = Number(/(\d+)px/.exec(g.font)?.[1] ?? 10);
			let em = 0;
			for (const char of text)
				em += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.6;
			return { width: em * px };
		},
		fillText(text: string) {
			calls.push(`${g.font}|${text}`);
		},
		fillRect() {},
		beginPath() {},
		moveTo() {},
		lineTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
	};
	return { g, calls };
};

/** Registers the setup and cleanup hooks of the suites. */
export function sceneHall(): void {
	beforeAll(() => GlobalRegistrator.register({ width: 1280, height: 800 }));
	afterAll(() => GlobalRegistrator.unregister());
}
