import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiTurnContext } from "../src/pi-protocol.ts";
import type { PiWorkerToolSpec } from "./pi-tools.ts";

/** Trusted operator code baked into the image, never selected by guest input. */
export interface PiWorkerContent {
	model: { provider: string; id: string };
	prompt?: readonly string[];
	skillsDir?: string;
	brokerTools?: readonly PiWorkerToolSpec[];
	/** Explicit local tool allow-list. Built-in shell/read/write/edit remain disabled. */
	toolNames?: readonly string[];
	extensions?: (
		turn: () => PiTurnContext,
	) => { name: string; factory: ExtensionFactory }[];
}
