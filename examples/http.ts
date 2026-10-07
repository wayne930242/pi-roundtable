import { definePlugin } from "pi-roundtable";

/** A route answers requests on a listener the host runs; "public" is the one the configuration's `http` block opens. */
export const health = definePlugin({
	name: "health",
	setup: () => ({
		http: [
			{
				name: "health-check",
				listener: "public",
				path: { exact: "/healthz" },
				methods: ["GET"],
				handle: () => new Response("ok"),
			},
		],
	}),
});

/**
 * A route with `websocket` also takes upgrades. The Origin check and `accept` run before any
 * socket opens, so a browser on another site, or a client without a ticket, never connects.
 * A ticket opens one socket: `accept` spends it, so one that leaks from a log or the browser's
 * history opens nothing. Whoever issues the tickets should also let them expire within seconds.
 */
export const echo = (tickets: Set<string>) =>
	definePlugin({
		name: "echo",
		setup: () => ({
			http: [
				{
					name: "echo",
					listener: "public",
					path: { exact: "/echo" },
					methods: ["GET"],
					handle: () => new Response("Upgrade Required", { status: 426 }),
					websocket: {
						origins: ["https://chat.example.com"],
						accept: (request) => {
							const ticket = URL.parse(request.url)?.searchParams.get("ticket");
							return ticket && tickets.delete(ticket)
								? { data: { since: Date.now() } }
								: new Response("Unauthorized", { status: 401 });
						},
						maxMessageBytes: 4096,
						rate: { messages: 20, perMs: 10_000 },
						maxBufferedBytes: 64 * 1024,
						maxConnections: 50,
						message: (socket, message) => {
							// "dropped" means the client stopped reading and the host cut it; an echo has nothing to resend.
							socket.send(message);
						},
					},
				},
			],
		}),
	});
