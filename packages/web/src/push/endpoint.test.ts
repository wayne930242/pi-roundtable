import { expect, test } from "bun:test";
import { EndpointPolicy, isHostPattern } from "./endpoint.ts";

const policy = new EndpointPolicy(["push.example.org", "*.relay.example.net"]);
const allowed = (endpoint: unknown) => "url" in policy.check(endpoint);

test("the browsers' own push services are allowed, over https only", () => {
	expect(allowed("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
	expect(
		allowed("https://updates.push.services.mozilla.com/wpush/v2/abc"),
	).toBe(true);
	expect(allowed("https://web.push.apple.com/QAb")).toBe(true);
	expect(allowed("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(
		true,
	);
	expect(allowed("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
});

test("a host the operator adds is allowed, with its subdomains only when written with *.", () => {
	expect(allowed("https://push.example.org/x")).toBe(true);
	expect(allowed("https://a.push.example.org/x")).toBe(false);
	expect(allowed("https://a.relay.example.net/x")).toBe(true);
	expect(allowed("https://relay.example.net/x")).toBe(false);
});

test("an address that only looks like an allowed one is refused", () => {
	for (const endpoint of [
		"https://evil.example/x",
		"https://fcm.googleapis.com.evil.example/x",
		"https://evilfcm.googleapis.com/x",
		"https://fcm.googleapis.com@evil.example/x",
		"https://user:pw@fcm.googleapis.com/x",
		"https://fcm.googleapis.com:8443/x",
		"https://127.0.0.1/x",
		"https://localhost/x",
		"https://web.push.apple.com.evil.example/x",
		"https://notapple.com/x",
		"file:///etc/passwd",
		"not a url",
		"",
		42,
		undefined,
		`https://fcm.googleapis.com/${"a".repeat(3000)}`,
	])
		expect(allowed(endpoint)).toBe(false);
});

test("host patterns are plain names, with *. first to allow subdomains", () => {
	expect(isHostPattern("push.example.com")).toBe(true);
	expect(isHostPattern("*.push.example.com")).toBe(true);
	for (const bad of [
		"*",
		"https://push.example.com",
		"push.example.com/x",
		"a*.example.com",
		"localhost",
		"1.2.3.4",
		"push.example.com:8443",
	])
		expect(isHostPattern(bad)).toBe(false);
});
