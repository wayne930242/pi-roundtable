import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "canvas";

const SIDE = 512;
/** The icon sits in a disc, with a badge overlapping its lower right. */
const ICON_RADIUS = 176;
const ICON_CENTER = { x: 256, y: 232 };
const BADGE = { x: 396, y: 396, radius: 64 };

const hsl = (h: number, s: number, l: number): string =>
	`hsl(${Math.round(h) % 360},${s}%,${l}%)`;

// pi-lens-ignore: hardcoded-url — the SVG XML namespace, a fixed identifier rather than an address that is fetched
const layer = (body: string): Buffer =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE}" height="${SIDE}" viewBox="0 0 ${SIDE} ${SIDE}">${body}</svg>`,
	);

/**
 * A stable picture for an agent nobody drew: the assistant's icon on a colour taken from the
 * display name, with a badge holding the initial of the agent's name. The name is lowercase Latin
 * letters, digits, and dashes, so the badge is always drawn from a font every server has, whatever
 * script the display name is written in. The same display name, name, and icon always give the
 * same bytes.
 */
export async function fallbackAvatar(
	displayName: string,
	icon: Uint8Array,
	name: string,
): Promise<Buffer> {
	const shown = displayName.normalize("NFC").trim();
	const digest = createHash("sha256").update(shown).digest();
	const byte = (i: number) => digest[i] ?? 0;
	const hue = ((byte(0) << 8) | byte(1)) % 360;
	const dark = hsl(hue, 58, 26);

	const bubbles = [0, 1, 2]
		.map((i) => {
			const cx = (byte(2 + i * 3) / 255) * SIDE;
			const cy = (byte(3 + i * 3) / 255) * SIDE;
			const r = 90 + (byte(4 + i * 3) / 255) * 130;
			return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#fff" fill-opacity="0.09"/>`;
		})
		.join("");
	const back = layer(
		`<defs><linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${hsl(hue, 62, 55)}"/><stop offset="1" stop-color="${hsl(hue + 32, 60, 33)}"/></linearGradient></defs>` +
			`<rect width="${SIDE}" height="${SIDE}" fill="url(#g)"/>${bubbles}` +
			`<circle cx="${ICON_CENTER.x}" cy="${ICON_CENTER.y}" r="${ICON_RADIUS + 8}" fill="#fff" fill-opacity="0.35"/>` +
			`<circle cx="${ICON_CENTER.x}" cy="${ICON_CENTER.y}" r="${ICON_RADIUS}" fill="#fff" fill-opacity="0.55"/>`,
	);

	const initial = (name.match(/[a-z0-9]/)?.[0] ?? "?").toUpperCase();
	const mark = `<text x="${BADGE.x}" y="${BADGE.y + 28}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="80" font-weight="bold" text-anchor="middle" fill="${dark}">${initial}</text>`;
	const front = layer(
		`<circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.radius + 8}" fill="${hsl(hue + 32, 60, 33)}"/>` +
			`<circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.radius}" fill="#fff"/>${mark}`,
	);

	const canvas = createCanvas(SIDE, SIDE);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(await loadImage(back), 0, 0);
	const face = await loadImage(Buffer.from(icon));
	const crop = Math.min(face.width, face.height);
	ctx.save();
	ctx.beginPath();
	ctx.arc(ICON_CENTER.x, ICON_CENTER.y, ICON_RADIUS, 0, Math.PI * 2);
	ctx.clip();
	ctx.drawImage(
		face,
		(face.width - crop) / 2,
		(face.height - crop) / 2,
		crop,
		crop,
		ICON_CENTER.x - ICON_RADIUS,
		ICON_CENTER.y - ICON_RADIUS,
		ICON_RADIUS * 2,
		ICON_RADIUS * 2,
	);
	// Tint the icon's own backdrop with the name's colour so the disc belongs to the picture.
	ctx.globalCompositeOperation = "multiply";
	ctx.fillStyle = hsl(hue, 45, 93);
	ctx.fillRect(0, 0, SIDE, SIDE);
	ctx.restore();
	ctx.drawImage(await loadImage(front), 0, 0);
	return canvas.toBuffer("image/png");
}
