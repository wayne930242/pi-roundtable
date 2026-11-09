import { Color, Fog, Group } from "three";
import { podiumPlace, ringRadius, slotsFor } from "./camera";
import { hallOf } from "./hall";
import { buildHall } from "./hall3d";
import { badgeOf, Podium, PodiumKit } from "./podium3d";
import { mixHex, stickerCanvas } from "./standee";
import type { Table3DContext } from "./table3d-context";
import { keyOf, type Place } from "./table3d-context";
import { Toon } from "./toon";
import type { SeatState } from "./types";

/** The hall as built for the seats: its podiums, the standees drawn for them, and the lights. */
export function worldBuilder(c: Table3DContext) {
	const { opts, names, scene, ambient, key, states, marks, svgs, talks } = c;
	/** The standees as drawn, so a new ring shows them at once and does not wait for them to be drawn again. */
	const stickers = new Map<
		string,
		{
			svg: string;
			talk: string | undefined;
			tone: string;
			canvas: HTMLCanvasElement;
			talkCanvas: HTMLCanvasElement | undefined;
		}
	>();
	/** Whether a seat's drawn standee is the one its pictures ask for now. */
	const keptFor = (id: string) => {
		const kept = stickers.get(id);
		return kept &&
			kept.svg === svgs.get(id) &&
			kept.talk === talks.get(id) &&
			kept.tone === toneOf()
			? kept
			: undefined;
	};
	const toneOf = () => `${c.theme}/${c.scheme}`;

	const disposeWorld = () => {
		if (!c.world) return;
		scene.remove(c.world.group);
		for (const p of c.world.podiums) p.dispose();
		c.world.kit.dispose();
		c.world.built.dispose();
		c.world.toon.dispose();
		c.world = undefined;
	};

	const stickerOf = async (id: string, expected: number) => {
		const svg = svgs.get(id);
		const w = c.world;
		if (!svg || !w) return;
		const slot = w.slotOf.get(id);
		const podium = slot === undefined ? undefined : w.podiums[slot];
		if (podium?.init.kind !== "agent") return;
		const talk = talks.get(id);
		const colors = {
			rim: w.hall.paper,
			ink: w.hall.ink,
			edge: mixHex(
				c.seats.find((s) => s.id === id)?.color ?? w.hall.gold,
				w.hall.ink,
				0.35,
			),
		};
		try {
			const [made, open] = await Promise.all([
				stickerCanvas(svg, 320, colors),
				talk ? stickerCanvas(talk, 320, colors) : undefined,
			]);
			if (expected !== c.building || c.world !== w) return;
			stickers.set(id, {
				svg,
				talk,
				tone: toneOf(),
				canvas: made.canvas,
				talkCanvas: open?.canvas,
			});
			podium.setSticker(made.canvas);
			podium.setTalk(open?.canvas);
			c.loop.wake();
		} catch {
			/* a picture that does not decode leaves the podium empty, never the scene broken */
		}
	};

	const applyState = (p: Podium, state: SeatState) => {
		p.setBadge(badgeOf(state));
	};

	const build = (glide?: {
		from: ReadonlyMap<string, Place>;
		joining: ReadonlySet<string>;
	}) => {
		const generation = ++c.building;
		disposeWorld();
		const hall = hallOf(c.theme, c.scheme);
		const slots = slotsFor(c.seats.length);
		const toon = new Toon();
		toon.setInk(hall.ink);
		const kit = new PodiumKit(hall);
		const built = buildHall(hall, slots.count, toon);
		const group = new Group();
		group.add(built.group);
		const slotOf = new Map<string, number>();
		const order: string[] = [];
		const podiums: Podium[] = [];
		const place = (slot: number, podium: Podium, push = 0) => {
			const at = podiumPlace(slot, slots.count);
			const out = 1 + push / ringRadius(slots.count);
			podium.group.position.set(at.x * out, 0.2, at.z * out);
			podium.group.rotation.y = at.yaw;
			podiums[slot] = podium;
			group.add(podium.group);
		};
		place(
			0,
			new Podium(
				{
					id: undefined,
					name: opts.ownerName ?? "You",
					kind: "owner",
					accent: hall.gold,
				},
				kit,
				toon,
			),
			1.2,
		);
		c.seats.slice(0, slots.seated).forEach((seat, i) => {
			const slot = i + 1;
			slotOf.set(seat.id, slot);
			order.push(seat.id);
			const podium = new Podium(
				{ id: seat.id, name: seat.name, kind: "agent", accent: seat.color },
				kit,
				toon,
			);
			podium.setDim(seat.dim === true);
			applyState(podium, states.get(seat.id) ?? seat.state ?? "idle");
			place(slot, podium);
			const kept = keptFor(seat.id);
			if (kept) {
				podium.setSticker(kept.canvas);
				podium.setTalk(kept.talkCanvas);
			}
		});
		c.world = { hall, toon, kit, built, group, slots, podiums, slotOf, order };
		if (glide && c.show) {
			const joining = new Set<Podium>();
			for (const p of podiums) {
				const to = {
					x: p.group.position.x,
					z: p.group.position.z,
					yaw: p.group.rotation.y,
				};
				const from = glide.from.get(keyOf(p));
				if (from) {
					c.show.slides.push({ podium: p, from, to });
					p.group.position.x = from.x;
					p.group.position.z = from.z;
					p.group.rotation.y = from.yaw;
				}
				if (p.init.id && glide.joining.has(p.init.id)) {
					p.group.visible = false;
					p.labelHidden = true;
					joining.add(p);
				}
			}
			c.show.risers = [...joining];
		}
		scene.add(group);
		group.updateMatrixWorld(true);
		scene.background = new Color(hall.bg);
		scene.fog = new Fog(hall.bg, 17, 46);
		ambient.color.set(hall.ambient);
		ambient.intensity = hall.ambientI;
		key.color.set(hall.key);
		key.intensity = hall.keyI;
		for (const seat of c.seats.slice(0, slots.seated)) {
			if (keptFor(seat.id)) continue;
			void stickerOf(seat.id, generation);
		}
		if (c.focusId && !slotOf.has(c.focusId)) c.focusId = null;
		// a new ring has new angles: the camera stays where it stands relative to what it looks at
		c.moveTo(c.targetShot(), glide === undefined);
		names.paint(hall);
		names.set(podiums, (p) => states.get(p.init.id ?? "") ?? "idle");
		for (const p of podiums) {
			const mark = marks.get(p.init.id ?? "");
			if (mark) names.mark(p, mark);
		}
		c.loop.wake();
	};

	return { disposeWorld, stickerOf, applyState, build, keptFor, toneOf };
}
