import { store } from "./app-store.ts";
import { subscribeHost, totalUnread } from "./host-state.ts";
import { noticeState, subscribeNotices } from "./notices.ts";
import { openCards, setTabUnread } from "./tab-count.ts";

const SIZE = 64;

/** The picture of `href` with a red dot in its top-right corner, as a PNG address. */
export async function dottedIcon(href: string): Promise<string> {
	const image = new Image();
	image.src = href;
	await image.decode();
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = SIZE;
	const draw = canvas.getContext("2d");
	if (!draw) throw new Error("the page has no 2d canvas");
	draw.drawImage(image, 0, 0, SIZE, SIZE);
	const radius = SIZE * 0.175;
	const x = SIZE - radius - 2;
	const y = radius + 2;
	draw.fillStyle = "#ffffff";
	draw.beginPath();
	draw.arc(x, y, radius + 2.5, 0, Math.PI * 2);
	draw.fill();
	draw.fillStyle = "#ef4444";
	draw.beginPath();
	draw.arc(x, y, radius, 0, Math.PI * 2);
	draw.fill();
	return canvas.toDataURL("image/png");
}

export interface TabDotEnv {
	/** How many things wait on the person. */
	count(): number;
	/** Calls `listener` whenever `count` may have changed. */
	subscribe(listener: () => void): void;
	/** The picture of an icon address with the dot on it. */
	render(href: string): Promise<string>;
}

const iconLinks = (): HTMLLinkElement[] => [
	...document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
];

/**
 * Keeps the tab's icon dotted while `env.count()` is above zero and plain again when it is zero.
 * The dotted picture is made from the page's own icon (so a host's `icons.dir` keeps its look),
 * once per address. Where a browser ignores a changed icon (Safari), the title's `(N) ` still says it.
 */
export function startTabDot(env: TabDotEnv): void {
	const cache = new Map<string, Promise<string>>();
	let dotted = false;
	let turn = 0;

	const plain = (link: HTMLLinkElement) => {
		if (link.dataset.plainHref === undefined) return;
		link.setAttribute("href", link.dataset.plainHref);
		if (link.dataset.plainType) link.type = link.dataset.plainType;
		else link.removeAttribute("type");
		if (link.dataset.plainSizes)
			link.setAttribute("sizes", link.dataset.plainSizes);
		else link.removeAttribute("sizes");
		delete link.dataset.plainHref;
		delete link.dataset.plainType;
		delete link.dataset.plainSizes;
	};

	const apply = async (): Promise<void> => {
		const mine = ++turn;
		const want = env.count() > 0;
		if (want === dotted) return;
		if (!want) {
			for (const link of iconLinks()) plain(link);
			dotted = false;
			return;
		}
		const links = iconLinks();
		// The PNG is the one every icon directory has; an SVG-only directory falls back to its first link.
		const source = (
			links.find(
				(link) =>
					link.dataset.plainHref === undefined && link.type === "image/png",
			) ?? links[0]
		)?.href;
		if (!source) return;
		let pending = cache.get(source);
		if (!pending) {
			pending = env.render(source);
			cache.set(source, pending);
		}
		const url = await pending.catch((failure: unknown) => {
			cache.delete(source);
			console.warn("the tab icon's dot failed to draw", failure);
			return undefined;
		});
		// The count changed while the picture was drawn: a later turn decides.
		if (!url || mine !== turn) return;
		for (const link of iconLinks()) {
			if (link.dataset.plainHref === undefined) {
				link.dataset.plainHref = link.getAttribute("href") ?? "";
				link.dataset.plainType = link.type;
				link.dataset.plainSizes = link.getAttribute("sizes") ?? "";
			}
			link.href = url;
			link.type = "image/png";
			link.removeAttribute("sizes");
		}
		dotted = true;
	};

	env.subscribe(() => void apply());
	void apply();
}

/** The page's own: cards waiting, notices and unread messages. */
export function startPageTabDot(): void {
	const unread = (): number => noticeState().badge + totalUnread();
	const sync = (): void => setTabUnread(unread());
	startTabDot({
		count: () => openCards(store.getState()) + unread(),
		subscribe: (listener) => {
			const changed = () => {
				sync();
				listener();
			};
			store.subscribe(changed);
			subscribeNotices(changed);
			subscribeHost(changed);
		},
		render: dottedIcon,
	});
	sync();
}
