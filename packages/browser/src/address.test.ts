import { expect, test } from "bun:test";
import { isPublicAddress } from "./address.ts";

const ipv4 = (...octets: number[]) => octets.join(".");

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
	"fe80::1%eth0",
	"::ffff:127.0.0.1",
	"0:0:0:0:0:ffff:7f00:1",
	"2001:db8::1",
	"2002:7f00:1::",
	"2001::1",
	"2001:0:4136:e378:8000:63bf:3fff:fdd2",
	"64:ff9b::7f00:1",
	`::ffff:${ipv4(169, 254, 169, 254)}`,
	"localhost",
	"example.com",
	"",
])("refuses non-public address %j", (address) =>
	expect(isPublicAddress(address)).toBe(false),
);

test.each([
	ipv4(8, 8, 8, 8),
	ipv4(1, 1, 1, 1),
	ipv4(192, 0, 1, 1),
	"2606:4700:4700::1111",
	"[2001:4860:4860::8888]",
	`::ffff:${ipv4(8, 8, 8, 8)}`,
])("accepts public address %s", (address) =>
	expect(isPublicAddress(address)).toBe(true),
);
