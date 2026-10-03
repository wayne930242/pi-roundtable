import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
	assertPublicUrl,
	isPublicAddress,
	pinnedTransport,
	ResponseTooLargeError,
	safeFetch,
} from "./safe-fetch.ts";

const ipv4 = (...octets: number[]) => octets.join(".");

const result = (url: URL, status = 200, location?: string, data = "ok") => ({
	url: url.href,
	status,
	headers: new Headers(location ? { location } : {}),
	data: Buffer.from(data),
});
const publicResolve = async () => [{ address: ipv4(8, 8, 8, 8), family: 4 }];
test.each([
	"127.0.0.1",
	"10.2.3.4",
	"172.31.1.1",
	ipv4(169, 254, 169, 254),
	"192.168.1.1",
	ipv4(100, 64, 0, 1),
	"0.0.0.0",
	ipv4(224, 0, 0, 1),
	ipv4(198, 18, 0, 1),
	"192.0.2.1",
	ipv4(192, 0, 0, 9),
	"::1",
	"::",
	"fc00::1",
	"fe80::1",
	"::ffff:127.0.0.1",
	"0:0:0:0:0:ffff:7f00:1",
	"2001:db8::1",
	"2002:7f00:1::",
	"2001::1",
	"2001::abcd:1",
	"2001:0:4136:e378:8000:63bf:3fff:fdd2",
	"2001:10::1",
	"2001:2f::1",
	"64:ff9b::7f00:1",
	`::ffff:${ipv4(169, 254, 169, 254)}`,
])("refuses non-public address %s", (address) =>
	expect(isPublicAddress(address)).toBe(false),
);
test.each([
	ipv4(8, 8, 8, 8),
	ipv4(1, 1, 1, 1),
	// Only the two reserved /24 blocks of that range are refused; the rest of it is ordinary public space.
	ipv4(192, 0, 1, 1),
	"2606:4700:4700::1111",
	"2001:4860:4860::8888",
	"2001:30::1",
	`::ffff:${ipv4(8, 8, 8, 8)}`,
])("accepts public address %s", (address) =>
	expect(isPublicAddress(address)).toBe(true),
);
test.each([
	"file:///etc/passwd",
	"gopher://example.test/",
	"http://user:password@example.test",
	"http://2130706433",
	"http://0x7f000001",
	`http://0${ipv4(177, 0, 0, 1)}`,
	"http://[::ffff:7f00:1]",
])("refuses encoded or unsupported URL %s", async (url) => {
	let called = false;
	await expect(
		safeFetch(url, {
			transport: async (url) => {
				called = true;
				return result(url);
			},
		}),
	).rejects.toThrow();
	expect(called).toBe(false);
});
test("pins to the vetted resolution and never resolves twice for one hop", async () => {
	let lookups = 0;
	const addresses: string[] = [];
	const response = await safeFetch("https://example.test", {
		resolve: async () => {
			lookups++;
			return lookups === 1
				? [{ address: ipv4(8, 8, 8, 8), family: 4 }]
				: [{ address: "127.0.0.1", family: 4 }];
		},
		transport: async (url, address) => {
			addresses.push(address.address);
			return result(url);
		},
	});
	expect(Buffer.from(response.data).toString()).toBe("ok");
	expect(lookups).toBe(1);
	expect(addresses).toEqual([ipv4(8, 8, 8, 8)]);
});
test("unreachable first address fails over only inside the initial vetted list", async () => {
	let lookups = 0;
	const connected: string[] = [];
	const response = await safeFetch("https://example.test", {
		resolve: async () => {
			lookups++;
			return [
				{ address: "2606:4700:4700::1111", family: 6 },
				{ address: ipv4(8, 8, 8, 8), family: 4 },
			];
		},
		transport: async (url, address) => {
			connected.push(address.address);
			if (address.family === 6)
				throw Object.assign(new Error("No IPv6 route"), {
					code: "ENETUNREACH",
				});
			return result(url);
		},
	});
	expect(response.status).toBe(200);
	expect(lookups).toBe(1);
	expect(connected).toEqual(["2606:4700:4700::1111", ipv4(8, 8, 8, 8)]);
});

test("a redirect rechecks DNS, including the same hostname rebinding", async () => {
	let lookups = 0;
	let calls = 0;
	await expect(
		safeFetch("https://example.test", {
			resolve: async () =>
				++lookups === 1
					? await publicResolve()
					: [{ address: ipv4(10, 0, 0, 1), family: 4 }],
			transport: async (url) => {
				calls++;
				return result(url, 302, "/private");
			},
		}),
	).rejects.toThrow("non-public");
	expect(calls).toBe(1);
});
test("a redirect to metadata or non-HTTP is refused before connecting", async () => {
	for (const location of [
		`http://${ipv4(169, 254, 169, 254)}/latest/meta-data`,
		"file:///etc/passwd",
		"http://[::1]/",
	]) {
		let calls = 0;
		await expect(
			safeFetch("https://example.test", {
				resolve: publicResolve,
				transport: async (url) => {
					calls++;
					return result(url, 302, location);
				},
			}),
		).rejects.toThrow();
		expect(calls).toBe(1);
	}
});
test("mixed public/private answers, body, redirect and deadline budgets fail closed", async () => {
	await expect(
		safeFetch("https://example.test", {
			resolve: async () => [
				...(await publicResolve()),
				{ address: "127.0.0.1", family: 4 },
			],
		}),
	).rejects.toThrow("non-public");
	await expect(
		safeFetch("https://example.test", {
			resolve: publicResolve,
			maxBytes: 2,
			transport: async (url) => result(url, 200, undefined, "large"),
		}),
	).rejects.toThrow("too large");
	await expect(
		safeFetch("https://example.test", {
			resolve: publicResolve,
			maxRedirects: 0,
			transport: async (url) => result(url, 302, "/again"),
		}),
	).rejects.toThrow("redirects");
	await expect(
		safeFetch("https://example.test", {
			timeoutMs: 10,
			resolve: async () => new Promise(() => {}),
		}),
	).rejects.toThrow();
});
test("real native transport pins the socket even when the original hostname has no DNS", async () => {
	const server = createServer((_request, response) => response.end("pinned"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No listening address");
		const response = await pinnedTransport(
			new URL(`http://never-resolve.invalid:${address.port}/`),
			{ address: "127.0.0.1", family: 4 },
			AbortSignal.timeout(1000),
			100,
		);
		expect(Buffer.from(response.data).toString()).toBe("pinned");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
test("native connection failure falls back without a second DNS lookup or changing Host", async () => {
	const server = createServer((request, response) =>
		response.end(request.headers.host),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const listening = server.address();
		if (!listening || typeof listening === "string")
			throw new Error("No address");
		let lookups = 0;
		const connections: string[] = [];
		const response = await safeFetch(
			`http://never-resolve.invalid:${listening.port}/`,
			{
				resolve: async () => {
					lookups++;
					return [
						{ address: ipv4(8, 8, 8, 8), family: 4 },
						{ address: ipv4(1, 1, 1, 1), family: 4 },
					];
				},
				transport: async (url, address, signal, maxBytes) => {
					connections.push(address.address);
					// Only this native fixture maps vetted public answers to its two local endpoints.
					return pinnedTransport(
						url,
						{
							address:
								address.address === ipv4(8, 8, 8, 8)
									? ipv4(127, 0, 0, 2)
									: "127.0.0.1",
							family: 4,
						},
						signal,
						maxBytes,
					);
				},
				timeoutMs: 8000,
			},
		);
		expect(Buffer.from(response.data).toString()).toBe(
			`never-resolve.invalid:${listening.port}`,
		);
		expect(lookups).toBe(1);
		expect(connections).toEqual([ipv4(8, 8, 8, 8), ipv4(1, 1, 1, 1)]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test.each(["gzip", "br"])(
	"public compressed %s responses are bounded after decoding",
	async (encoding) => {
		const server = createServer((request, response) => {
			response.setHeader("content-encoding", encoding);
			const text =
				request.url === "/bomb" ? "x".repeat(10000) : "compressed page";
			response.end(
				encoding === "gzip" ? gzipSync(text) : brotliCompressSync(text),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("No address");
			const url = new URL(`http://never-resolve.invalid:${address.port}/`);
			const response = await pinnedTransport(
				url,
				{ address: "127.0.0.1", family: 4 },
				AbortSignal.timeout(1000),
				200,
			);
			expect(Buffer.from(response.data).toString()).toBe("compressed page");
			url.pathname = "/bomb";
			await expect(
				pinnedTransport(
					url,
					{ address: "127.0.0.1", family: 4 },
					AbortSignal.timeout(1000),
					200,
				),
			).rejects.toThrow("too large");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
);

test("a caller can take one hop at a time, with trusted headers, and still gets every hop vetted", async () => {
	const seen: { url: string; headers?: Record<string, string> }[] = [];
	const hop = await safeFetch("http://start.test/a", {
		followRedirects: false,
		headers: { "user-agent": "host-agent", "accept-encoding": "br" },
		resolve: publicResolve,
		transport: async (url, _address, _signal, _max, headers) => {
			seen.push({ url: url.href, headers });
			return result(url, 302, "http://next.test/b");
		},
	});
	expect(hop.status).toBe(302);
	expect(hop.headers.get("location")).toBe("http://next.test/b");
	expect(seen).toHaveLength(1);
	expect(seen[0]?.headers?.["user-agent"]).toBe("host-agent");
	// The next hop goes back through the same checks, and a private answer is refused.
	await expect(
		safeFetch("http://next.test/b", {
			followRedirects: false,
			resolve: async () => [{ address: "127.0.0.1", family: 4 }],
			transport: async (url) => result(url),
		}),
	).rejects.toThrow("non-public");
});
test("assertPublicUrl refuses non-HTTP, credentials and any non-public DNS answer", async () => {
	await expect(
		assertPublicUrl("http://ok.test/", publicResolve),
	).resolves.toBeInstanceOf(URL);
	for (const raw of ["file:///etc/passwd", "/etc/hosts", "http://u:p@ok.test/"])
		await expect(assertPublicUrl(raw, publicResolve)).rejects.toThrow();
	await expect(
		assertPublicUrl("http://ok.test/", async () => [
			{ address: ipv4(8, 8, 8, 8), family: 4 },
			{ address: "10.0.0.1", family: 4 },
		]),
	).rejects.toThrow("non-public");
});

test("the transport keeps the reason phrase and the server's own length, and reports a declared oversize with its headers", async () => {
	const server = createServer((request, response) => {
		if (request.url === "/teapot") {
			response.writeHead(418, "Short and Stout", { "content-length": "2" });
			response.end("hi");
		} else if (request.url === "/chunked") {
			response.writeHead(200);
			response.end("chunked body");
		} else if (request.url === "/zipped") {
			response.writeHead(200, { "content-encoding": "gzip" });
			response.end(gzipSync("zipped body"));
		} else {
			response.writeHead(200, { "content-length": "5000" });
			response.end("x".repeat(5000));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const listening = server.address();
		if (!listening || typeof listening === "string")
			throw new Error("No address");
		const get = (path: string, max = 1000) =>
			pinnedTransport(
				new URL(`http://never-resolve.invalid:${listening.port}${path}`),
				{ address: "127.0.0.1", family: 4 },
				AbortSignal.timeout(2000),
				max,
			);
		const teapot = await get("/teapot");
		expect(teapot.statusText).toBe("Short and Stout");
		expect(teapot.headers.get("content-length")).toBe("2");
		// A body sent without a length, or decoded from a compressed one, carries none.
		expect((await get("/chunked")).headers.get("content-length")).toBeNull();
		expect((await get("/zipped")).headers.get("content-length")).toBeNull();
		const declared = await get("/declared").catch((error: unknown) => error);
		expect(declared).toBeInstanceOf(ResponseTooLargeError);
		expect(
			(declared as ResponseTooLargeError).headers.get("content-length"),
		).toBe("5000");
		expect((declared as ResponseTooLargeError).status).toBe(200);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
