import type { AgentTeam, Logger } from "pi-roundtable";
import type { ServerFrame } from "../api-types.ts";
import type { Sockets } from "./sockets.ts";

/** Changes closer together than this reach the sockets as one `presence` frame. */
const PRESENCE_COALESCE_MS = 250;

type PresenceFrame = Extract<ServerFrame, { type: "presence" }>;

export interface PresenceOptions {
	team: Pick<AgentTeam, "status" | "onChange">;
	sockets: Sockets;
	/** The agents working in the app's own rooms now, which the team's status does not list. */
	working(): ReadonlySet<string>;
	logger: Logger;
	/** How long changes are gathered; default 250 ms. */
	coalesceMs?: number;
}

/**
 * Which agents are busy, anywhere: a turn in a Discord channel shows in the team's status, and a
 * turn in an app room shows in the surface. A frame goes out only when the table differs from the
 * one last sent, so a turn's churn costs the sockets nothing.
 */
export class Presence {
	readonly #options: PresenceOptions;
	#pending: ReturnType<typeof setTimeout> | undefined;
	#last = "";
	#stopped = false;

	constructor(options: PresenceOptions) {
		this.#options = options;
		options.team.onChange(() => this.schedule());
	}

	/** The table now, as a frame. */
	async frame(): Promise<PresenceFrame> {
		const { team, working } = this.#options;
		const status = await team.status();
		const here = working();
		const agents: PresenceFrame["agents"] = {};
		for (const agent of status.agents)
			agents[agent.name] = {
				busy: agent.workingIn !== undefined || here.has(agent.name),
			};
		return { type: "presence", agents };
	}

	/** Sends the table to every socket once changes settle, if it changed. */
	schedule(): void {
		if (this.#pending || this.#stopped) return;
		this.#pending = setTimeout(() => {
			this.#pending = undefined;
			this.#send().catch((error: unknown) =>
				this.#options.logger.warn({ err: error }, "presence was not sent"),
			);
		}, this.#options.coalesceMs ?? PRESENCE_COALESCE_MS);
	}

	async #send(): Promise<void> {
		const frame = await this.frame();
		const text = JSON.stringify(frame.agents);
		if (text === this.#last || this.#stopped) return;
		this.#last = text;
		this.#options.sockets.broadcast(frame);
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#pending);
		this.#pending = undefined;
	}
}
