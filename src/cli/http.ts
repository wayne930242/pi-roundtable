/** One HTTP answer: its status and its JSON body, undefined when the body is not JSON. */
export interface HttpResponse {
	status: number;
	body: unknown;
}

/** The one network call the checks make, so tests never touch the network. */
export interface Http {
	get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}

const TIMEOUT_MS = 10_000;

export const fetchHttp: Http = {
	async get(url, headers) {
		const response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const body: unknown = await response.json().catch(() => undefined);
		return { status: response.status, body };
	},
};
