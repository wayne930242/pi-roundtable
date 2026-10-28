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

/**
 * Whether the address asks for the 2D table (`?nogl`, in the query or after the hash), to try it on a
 * machine that has WebGL. `nogl=0` and `nogl=false` leave the choice to the browser.
 */
export function glDisabled(search: string, hash: string): boolean {
	const queries = [
		search,
		hash.includes("?") ? hash.slice(hash.indexOf("?")) : "",
	];
	return queries.some((query) => {
		const value = new URLSearchParams(query).get("nogl");
		return value !== null && value !== "0" && value !== "false";
	});
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
	/** The canvas reported it cannot carry names a person reads: the seats are listed under it. */
	let unreadable = false;
	/** Whether the seats are listed as buttons under the canvas; the list is made when it first is. */
	const listed = () => !compact && (Boolean(opts.listBelow) || unreadable);
	container.appendChild(root);

	// Buttons are kept while the seats stay the same, so a state change does not drop keyboard focus.
	const buttons = new Map<string, HTMLButtonElement>();
	const syncList = () => {
		if (!listed()) {
			list?.remove();
			list = null;
			buttons.clear();
			delete root.dataset.list;
			return;
		}
		if (!list) {
			list = document.createElement("ul");
			list.className = "rt-table-list";
			list.setAttribute("aria-label", "Round table");
			root.appendChild(list);
			root.dataset.list = "";
		}
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

	const reading = (readable: boolean) => {
		unreadable = !readable;
		syncList();
		opts.onNames?.(readable);
	};

	const mountSvg = async () => {
		const { createTable2D } = await import("./table2d");
		inner = createTable2D(stage, {
			...opts,
			theme: theme.t,
			scheme: theme.s,
			seats: [...seats.values()],
		});
		// The 2D table draws every name at 11 px or more by its own sizing.
		reading(true);
	};
	const mountGl = async () => {
		const { createTable3D } = await import("./table3d");
		inner = createTable3D(
			stage,
			{
				...opts,
				theme: theme.t,
				scheme: theme.s,
				seats: [...seats.values()],
				onNames: reading,
			},
			() => {
				// context lost: swap to the SVG table with the current seats/states, never leave a dead canvas
				inner?.dispose();
				void mountSvg();
			},
		);
	};

	if (
		compact ||
		force === "svg" ||
		(force !== "webgl" &&
			(glDisabled(location.search, location.hash) || !webglAvailable()))
	)
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
