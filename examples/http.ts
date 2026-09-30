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
