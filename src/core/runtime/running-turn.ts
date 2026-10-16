import type { ClientPort } from "../domain/client.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { Speaker, Tier } from "../speakers.ts";

/** What the runtime keeps about a conversation's running turn, for its tools to read. */
export interface RunningTurn {
	/** The channel the turn replies in, as `TurnRequest.channel` says; its surface formats the reply. */
	channel: TurnRequest["channel"];
	tier: Tier;
	speaker: Speaker;
	/** Where the turn's request came from, as `TurnRequest.origin` says. */
	origin?: string;
	/** What the client that started the turn can do, as `TurnRequest.client` says. */
	client?: ClientPort;
	/** Whether the turn loads no memory. */
	withheld: boolean;
}

/** The record of a turn that starts: what its tools read while it runs. */
export function runningTurn(
	request: TurnRequest,
	tier: Tier,
	withheld: boolean,
): RunningTurn {
	return {
		channel: request.channel,
		tier,
		speaker: request.speaker,
		...(request.origin === undefined ? {} : { origin: request.origin }),
		...(request.client === undefined ? {} : { client: request.client }),
		withheld,
	};
}
