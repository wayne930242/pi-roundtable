import type { SeatInit, SeatState, TableHandle, TableOptions } from "./types";

export type { SeatInit, SeatState, TableHandle, TableOptions } from "./types";
export { SEAT_STATES } from "./types";

/**
 * The only module the React app imports eagerly (it is tiny). It decides between the
 * WebGL scene and the SVG fallback and loads exactly one of them as a lazy chunk.
 */
export function webglAvailable(): boolean {
	try {
		const c = document.createElement("canvas");
		return !!(c.getContext("webgl2") || c.getContext("webgl"));
	} catch {
		return false;
	}
}

export async function mountRoundTable(
	container: HTMLElement,
	opts: TableOptions,
	force?: "svg" | "webgl",
): Promise<TableHandle> {
	const compact = opts.variant === "compact";
	const seats = new Map<string, SeatInit>();
	const mirror = (list: SeatInit[]) => {
		seats.clear();
		for (const s of list) seats.set(s.id, { ...s });
	};
	mirror(opts.seats);
	let theme = { t: opts.theme, s: opts.scheme };
	let inner: TableHandle | null = null;

	const root = document.createElement("div");
	root.className = "rt-table";
	root.dataset.variant = compact ? "compact" : "full";
	const stage = document.createElement("div");
	stage.className = "rt-table-stage";
	root.appendChild(stage);
	let list: HTMLUListElement | null = null;
	if (opts.listBelow && !compact) {
		root.dataset.list = "";
		list = document.createElement("ul");
		list.className = "rt-table-list";
		list.setAttribute("aria-label", "Round table");
		root.appendChild(list);
	}
	container.appendChild(root);

	// Buttons are kept while the seats stay the same, so a state change does not drop keyboard focus.
	const buttons = new Map<string, HTMLButtonElement>();
	const syncList = () => {
		if (!list) return;
		for (const id of [...buttons.keys()])
			if (!seats.has(id)) buttons.delete(id);
		for (const s of seats.values()) {
			let b = buttons.get(s.id);
			if (!b) {
				b = document.createElement("button");
				b.type = "button";
				const seat = s.id;
				b.addEventListener("click", () => {
					const current = seats.get(seat);
					if (current) opts.onSeatClick({ id: current.id, name: current.name });
				});
				buttons.set(s.id, b);
			}
			b.textContent = `${s.name} (${s.state ?? "idle"})`;
			b.style.setProperty("--seat", s.color);
		}
		list.replaceChildren(
			...[...seats.values()].map((s) => {
				const li = document.createElement("li");
				const b = buttons.get(s.id);
				if (b) li.appendChild(b);
				return li;
			}),
		);
	};
	syncList();

	const mountSvg = async () => {
		const { createTable2D } = await import("./table2d");
		inner = createTable2D(stage, {
			...opts,
			theme: theme.t,
			scheme: theme.s,
			seats: [...seats.values()],
		});
	};
	const mountGl = async () => {
		const { createTable3D } = await import("./table3d");
		inner = createTable3D(
			stage,
			{ ...opts, theme: theme.t, scheme: theme.s, seats: [...seats.values()] },
			() => {
				// context lost: swap to the SVG table with the current seats/states, never leave a dead canvas
				inner?.dispose();
				void mountSvg();
			},
		);
	};

	if (compact || force === "svg" || (force !== "webgl" && !webglAvailable()))
		await mountSvg();
	else {
		try {
			await mountGl();
		} catch {
			await mountSvg();
		}
	}

	const proxy: TableHandle = {
		get kind() {
			return inner!.kind;
		},
		setTheme(t, s) {
			theme = { t, s };
			inner!.setTheme(t, s);
		},
		setSeats(next) {
			mirror(next);
			syncList();
			inner!.setSeats(next);
		},
		setState(id, st: SeatState) {
			const s = seats.get(id);
			if (s) s.state = st;
			syncList();
			inner!.setState(id, st);
		},
		setAvatar(id, svg) {
			const s = seats.get(id);
			if (s) s.avatarSvg = svg;
			return inner!.setAvatar(id, svg);
		},
		setReducedMotion: (r) => inner!.setReducedMotion(r),
		resetCamera: () => inner!.resetCamera(),
		getStats: () => inner!.getStats(),
		dispose() {
			inner?.dispose();
			root.remove();
		},
	};
	return proxy;
}
