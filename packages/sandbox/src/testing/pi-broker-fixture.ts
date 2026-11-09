import type { PiSandboxBroker } from "../pi-broker.ts";
import type { PiThinkingLevel } from "../pi-protocol.ts";

export const post = (path: string, body: unknown) =>
	new Request(`http://broker${path}`, {
		method: "POST",
		headers: { authorization: "Bearer guest-token", cookie: "guest=1" },
		body: JSON.stringify(body),
	});

export const message = {
	model: "guest-choice",
	messages: [{ role: "user", content: "Hello" }],
	max_tokens: 1_000_000,
};

export function bound(
	broker: PiSandboxBroker,
	thinking: PiThinkingLevel = "xhigh",
) {
	const controller = new AbortController();
	const release = broker.bind({
		channel: "discord:channel",
		profile: "profile",
		speaker: { id: "guest", name: "Guest" },
		thinking,
		signal: controller.signal,
	});
	return { controller, release };
}
