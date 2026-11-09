import type { ChannelKey } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import type { Visitor } from "./visitors.ts";
import type {
	HostPage,
	HostPages,
	HostRoomKind,
	HostRooms,
	LinkProver,
	Notices,
	OnboardingStep,
	Viewer,
	WebApp,
} from "./web-app-types.ts";

export * from "./web-app-types.ts";

// ── Where the pieces of the app plug in ────────────────────────────────────────────────────────

/** A kind's id and a page's id as they appear in keys and routes. */
const KIND_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const PAGE_ID = /^[a-z0-9-]{1,40}$/;
const RESERVED_KINDS: ReadonlySet<string> = new Set([
	"agent",
	"group",
	"thread",
	"home",
]);

/** The services the pieces of the app provide once built; the registry hands them to the host. */
export interface WebAppParts {
	rooms: HostRooms;
	pages: HostPages;
	notices: Notices;
	onboarding: WebApp["onboarding"];
	push: WebApp["push"];
}

/** Whether a person waived a required step; the onboarding service supplies it. */
export interface WaiverRead {
	waived(principalId: string, step: string): Promise<boolean>;
}

/** What a socket frame handler of a plugged-in piece is given. */
export interface FrameContext<F> {
	frame: F;
	viewer: Viewer;
	/** The connection the frame came on, for what is per socket: the subscriptions, the focus. */
	connection: import("./app/sockets.ts").AppSocket;
	/** Answers a frame that cannot be taken. `id` echoes the frame's own reference. */
	refuse(code: import("./api-types.ts").RefusalCode, id?: string): void;
}

export type FrameHandler<F> = (context: FrameContext<F>) => Promise<void>;

/** The frames the pieces of the app handle: host rooms (D) and notices (E). */
export type PluggedFrames = {
	[K in import("./api-types.ts").ClientFrame["type"] &
		("subscribe" | "unsubscribe" | "act" | "ack" | "read")]: Extract<
		import("./api-types.ts").ClientFrame,
		{ type: K }
	>;
} & {
	/** A `send` or `stop` into a host room; an agent room's goes the app's own way. */
	hostSend: Extract<import("./api-types.ts").ClientFrame, { type: "send" }>;
	hostStop: Extract<import("./api-types.ts").ClientFrame, { type: "stop" }>;
};

/**
 * What decides who reads a host room right now. The delivery of room frames asks `readNow` for
 * every frame and every connection, so it answers from a memo; `read` asks the kind itself.
 */
export interface HostRoomAccess {
	read(viewer: Viewer, room: ChannelKey): Promise<boolean>;
	readNow(
		connection: import("./app/sockets.ts").AppSocket,
		room: string,
	): boolean;
}

/** A REST area the pieces of the app answer, below `<mount>/api/`. */
export interface RouteArea {
	/** The first segment after `api/`, such as `host`. */
	area: string;
	handle(
		request: Request,
		parts: readonly string[],
		context: { visitor: Visitor; viewer: Viewer },
	): Promise<Response>;
}

const unbound = (what: string): never => {
	throw new PluginError(
		`web app: ${what} is not available yet. It is provided when the web service starts; use it from a callback or after start`,
	);
};

/**
 * The registries behind `WEB_APP`: what hosts register in `setup`, validated when the web service
 * starts, and the places where the other pieces of the app plug in: socket frame handlers, REST
 * areas, the room-access rule, and the services (`rooms`, `notices`, `onboarding`, `push`) a host
 * reaches through the `WebApp`.
 */
export class WebAppRegistry implements WebApp {
	readonly surface: string;
	readonly #kinds = new Map<string, HostRoomKind>();
	readonly #pages = new Map<string, HostPage>();
	readonly #steps = new Map<string, OnboardingStep>();
	readonly #provers = new Map<string, LinkProver>();
	readonly #frames = new Map<string, FrameHandler<never>>();
	readonly #areas = new Map<string, RouteArea>();
	readonly #listeners = new Set<() => void>();
	#parts: Partial<WebAppParts> = {};
	#waivers: WaiverRead | undefined;
	#access: HostRoomAccess | undefined;
	#started = false;

	constructor(surface: string) {
		this.surface = surface;
	}

	// ── What a host registers ──

	registerRoomKind(kind: HostRoomKind): void {
		this.#open("registerRoomKind");
		if (!KIND_NAME.test(kind.kind) || RESERVED_KINDS.has(kind.kind))
			throw new PluginError(
				`web app: room kind ${JSON.stringify(kind.kind)} must be a lower-case word and not agent, group, thread or home`,
			);
		if (this.#kinds.has(kind.kind))
			throw new PluginError(
				`web app: room kind ${kind.kind} is registered twice`,
			);
		this.#kinds.set(kind.kind, kind);
		this.#changed();
	}

	registerPage(page: HostPage): void {
		this.#open("registerPage");
		if (!PAGE_ID.test(page.id))
			throw new PluginError(
				`web app: page id ${JSON.stringify(page.id)} must match [a-z0-9-]{1,40}`,
			);
		if (this.#pages.has(page.id))
			throw new PluginError(`web app: page ${page.id} is registered twice`);
		this.#pages.set(page.id, page);
		this.#changed();
	}

	registerStep(step: OnboardingStep): void {
		this.#open("registerStep");
		if (this.#steps.has(step.id))
			throw new PluginError(`web app: step ${step.id} is registered twice`);
		this.#steps.set(step.id, step);
		this.#changed();
	}

	registerLinkProver(prover: LinkProver): void {
		this.#open("registerLinkProver");
		if (this.#provers.has(prover.provider))
			throw new PluginError(
				`web app: a link prover for ${prover.provider} is registered twice`,
			);
		this.#provers.set(prover.provider, prover);
		this.#changed();
	}

	#open(what: string): void {
		if (this.#started)
			throw new PluginError(
				`web app: ${what} was called after the web service started; register from setup`,
			);
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}

	// ── What a host reaches ──

	get rooms(): HostRooms {
		return this.#parts.rooms ?? unbound("rooms");
	}
	get pages(): HostPages {
		return this.#parts.pages ?? unbound("pages");
	}
	get notices(): Notices {
		return this.#parts.notices ?? unbound("notices");
	}
	get onboarding(): WebApp["onboarding"] {
		return this.#parts.onboarding ?? unbound("onboarding");
	}
	get push(): WebApp["push"] {
		return this.#parts.push ?? unbound("push");
	}

	// ── What the pieces of the app read and plug in ──

	kinds(): readonly HostRoomKind[] {
		return [...this.#kinds.values()];
	}
	kind(name: string): HostRoomKind | undefined {
		return this.#kinds.get(name);
	}
	hostPages(): readonly HostPage[] {
		return [...this.#pages.values()];
	}
	page(id: string): HostPage | undefined {
		return this.#pages.get(id);
	}
	steps(): readonly OnboardingStep[] {
		return [...this.#steps.values()];
	}
	step(id: string): OnboardingStep | undefined {
		return this.#steps.get(id);
	}
	provers(): readonly LinkProver[] {
		return [...this.#provers.values()];
	}
	prover(provider: string): LinkProver | undefined {
		return this.#provers.get(provider);
	}

	/** Hears of a registration, so a gate or a list built from them can be rebuilt. */
	onRegister(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The services the pieces of the app provide; each of `rooms`, `notices`, `onboarding` and `push` once. */
	provide(parts: Partial<WebAppParts>): void {
		for (const name of Object.keys(parts) as (keyof WebAppParts)[])
			if (this.#parts[name])
				throw new PluginError(`web app: ${name} is provided twice`);
		this.#parts = { ...this.#parts, ...parts };
	}

	/** Where the person's waivers are read from. */
	setWaivers(waivers: WaiverRead): void {
		this.#waivers = waivers;
	}
	waived(principalId: string, step: string): Promise<boolean> {
		return this.#waivers?.waived(principalId, step) ?? Promise.resolve(false);
	}

	/** Replaces the deny-all room-access rule. */
	setAccess(access: HostRoomAccess): void {
		this.#access = access;
	}
	get access(): HostRoomAccess {
		return this.#access ?? DENY_ACCESS;
	}

	/** Registers the handler of a frame the pieces of the app take. One handler per frame. */
	onFrame<K extends keyof PluggedFrames>(
		type: K,
		handler: FrameHandler<PluggedFrames[K]>,
	): void {
		if (this.#frames.has(type))
			throw new PluginError(`web app: the ${type} frame has two handlers`);
		this.#frames.set(type, handler as FrameHandler<never>);
	}
	frameHandler<K extends keyof PluggedFrames>(
		type: K,
	): FrameHandler<PluggedFrames[K]> | undefined {
		return this.#frames.get(type) as FrameHandler<PluggedFrames[K]> | undefined;
	}

	/** Registers the REST area the pieces of the app answer. */
	onArea(area: RouteArea): void {
		if (this.#areas.has(area.area))
			throw new PluginError(`web app: api/${area.area} has two handlers`);
		this.#areas.set(area.area, area);
	}
	areaFor(name: string): RouteArea | undefined {
		return this.#areas.get(name);
	}

	/** Whether the key is a room of a host kind: `<surface>:<kind>.<id>` with a registered kind. */
	isHostRoom(key: string): boolean {
		return this.hostKindOf(key) !== undefined;
	}
	/** The registered kind and id a host room key names. */
	hostKindOf(key: string): { kind: HostRoomKind; id: string } | undefined {
		const prefix = `${this.surface}:`;
		if (!key.startsWith(prefix)) return undefined;
		const rest = key.slice(prefix.length);
		const dot = rest.indexOf(".");
		if (dot <= 0) return undefined;
		const kind = this.#kinds.get(rest.slice(0, dot));
		return kind ? { kind, id: rest.slice(dot + 1) } : undefined;
	}

	/** Closes registration; the web service calls it at start, after checking what was registered. */
	seal(): void {
		this.#started = true;
	}
}

const DENY_ACCESS: HostRoomAccess = {
	read: async () => false,
	readNow: () => false,
};
