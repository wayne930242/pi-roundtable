import { request } from "node:http";
import { BROKER_PATH, DUMMY_KEY } from "../src/protocol.ts";

/** Bun fetch adds Connection automatically; this client sends only the explicit safe headers. */
export function unixBrokerRequest(
	route: string,
	body: Record<string, unknown>,
	socketPath = BROKER_PATH,
): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const encoded = JSON.stringify(body);
		const outgoing = request(
			{
				socketPath,
				path: route,
				method: "POST",
				setDefaultHeaders: false,
				headers: {
					host: "broker",
					"content-type": "application/json",
					"content-length": Buffer.byteLength(encoded),
					authorization: `Bearer ${DUMMY_KEY}`,
				},
				signal: AbortSignal.timeout(65_000),
			},
			(incoming) => {
				let size = 0;
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 1024 * 1024) {
						outgoing.destroy(new Error("broker response too large"));
						return;
					}
					chunks.push(chunk);
				});
				incoming.on("error", reject);
				incoming.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if (incoming.statusCode !== 200) {
						resolve({
							status: incoming.statusCode ?? 502,
							body: { error: "broker refused" },
						});
						return;
					}
					try {
						resolve({
							status: incoming.statusCode ?? 502,
							body: JSON.parse(text),
						});
					} catch {
						reject(new Error("broker returned no JSON"));
					}
				});
			},
		);
		outgoing.on("error", reject);
		outgoing.end(encoded);
	});
}
