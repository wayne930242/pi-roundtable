import { isIP } from "node:net";

/**
 * Whether an address is a globally routable unicast one. Everything else is refused: loopback,
 * private, link-local (cloud metadata lives there), carrier-grade NAT, documentation, benchmarking,
 * multicast, reserved, and the IPv6 transition ranges that can wrap an IPv4 one (Teredo, 6to4,
 * IPv4-mapped). A scoped IPv6 address (`fe80::1%eth0`) and anything that is not an IP literal is refused.
 */
export function isPublicAddress(raw: string): boolean {
	let address = raw.toLowerCase().replace(/^\[|\]$/g, "");
	if (address.includes("%")) return false;
	if (isIP(address) === 4) {
		const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 &&
				(b === 168 ||
					(b === 0 && (c === 0 || c === 2)) ||
					(b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (isIP(address) !== 6) return false;
	// URL canonicalization normalizes expanded IPv6 and dotted IPv4-mapped representations.
	address = new URL(`http://[${address}]/`).hostname.slice(1, -1);
	if (address.startsWith("::ffff:")) {
		const parts = address.slice(7).split(":");
		if (parts.length !== 2) return false;
		const high = Number.parseInt(parts[0] ?? "", 16);
		const low = Number.parseInt(parts[1] ?? "", 16);
		return isPublicAddress(
			`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`,
		);
	}
	// Only ordinary global IPv6, excluding documentation, benchmarking, Teredo and 6to4.
	// Hextets are read numerically after expansion, so compressed forms such as 2001::1 are caught too.
	const [head = "", tail = ""] = address.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const hextets = address.includes("::")
		? [
				...left,
				...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
				...right,
			]
		: left;
	const first = Number.parseInt(hextets[0] ?? "", 16);
	const second = Number.parseInt(hextets[1] ?? "", 16);
	return (
		first >= 0x2000 &&
		first <= 0x3fff &&
		first !== 0x2002 &&
		!(
			first === 0x2001 &&
			(second === 0 ||
				second === 2 ||
				second === 0xdb8 ||
				(second >= 0x10 && second <= 0x2f))
		) &&
		first !== 0x3fff
	);
}
