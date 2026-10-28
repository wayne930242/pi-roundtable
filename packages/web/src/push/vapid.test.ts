import { afterAll, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJWK, jwtVerify } from "jose";
import { loadVapid, vapidAuthorization } from "./vapid.ts";

const dir = mkdtempSync(join(tmpdir(), "vapid-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the key is made once, kept readable by this user alone, and read back the same", async () => {
	const path = join(dir, "web", "vapid.json");
	const first = await loadVapid(path);
	expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	const again = await loadVapid(path);
	expect(again.publicKey).toBe(first.publicKey);
});

test("a public key that is not the private key's stops startup", async () => {
	const path = join(dir, "web", "mismatch.json");
	const good = await loadVapid(join(dir, "web", "other.json"));
	const other = await loadVapid(path);
	const file = JSON.parse(readFileSync(path, "utf8"));
	file.publicKey = good.publicKey;
	writeFileSync(path, JSON.stringify(file));
	expect(other.publicKey).not.toBe(good.publicKey);
	await expect(loadVapid(path)).rejects.toThrow("does not belong");
});

test("a key file that cannot be read stops startup instead of being replaced", async () => {
	const path = join(dir, "broken.json");
	writeFileSync(path, "not json");
	await expect(loadVapid(path)).rejects.toThrow("delete it");
	writeFileSync(
		path,
		JSON.stringify({ publicKey: "x", privateKey: { kty: "EC" } }),
	);
	await expect(loadVapid(path)).rejects.toThrow("delete it");
});

test("the header carries a token for the push service's origin that the public key verifies", async () => {
	const vapid = await loadVapid(join(dir, "again.json"));
	const header = await vapidAuthorization(
		vapid,
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://app.example.test",
	);
	const [, token, key] = /^vapid t=(.+), k=(.+)$/.exec(header) ?? [];
	expect(key).toBe(vapid.publicKey);
	const raw = Buffer.from(vapid.publicKey, "base64url");
	const verifier = await importJWK(
		{
			kty: "EC",
			crv: "P-256",
			x: raw.subarray(1, 33).toString("base64url"),
			y: raw.subarray(33).toString("base64url"),
		},
		"ES256",
	);
	const { payload } = await jwtVerify(token ?? "", verifier, {
		audience: "https://fcm.googleapis.com",
	});
	expect(payload.sub).toBe("https://app.example.test");
	expect(
		(payload.exp ?? 0) - Math.floor(Date.now() / 1000),
	).toBeLessThanOrEqual(86_400);
});
