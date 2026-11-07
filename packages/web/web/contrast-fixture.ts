// The colour arithmetic of the contrast tests: WCAG ratios and the `light-dark()` tokens of a stylesheet.

/** The WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
	const luminance = (hex: string) => {
		const [r, g, b2] = [1, 3, 5].map((at) => {
			const unit = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
			return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
	};
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (light + 0.05) / (dark + 0.05);
}

/** Each `--name: light-dark(#light, #dark)` of the first block that `block` matches in `css`. */
export function lightDarkTokens(
	css: string,
	block: RegExp,
): Record<string, { light: string; dark: string }> {
	const body = block.exec(css)?.[1];
	if (!body) throw new Error(`no token block ${block}`);
	const found: Record<string, { light: string; dark: string }> = {};
	for (const match of body.matchAll(
		/--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/g,
	)) {
		const [, name, light, dark] = match;
		if (name && light && dark) found[name] = { light, dark };
	}
	return found;
}

/** `#rrggbb` laid over `under` at `alpha`, as a translucent fill paints. */
export function over(color: string, alpha: number, under: string): string {
	const channel = (hex: string, at: number) =>
		Number.parseInt(hex.slice(at, at + 2), 16);
	return `#${[1, 3, 5]
		.map((at) =>
			Math.round(channel(color, at) * alpha + channel(under, at) * (1 - alpha))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}
