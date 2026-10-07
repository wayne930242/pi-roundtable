/** Crockford's base 32, the alphabet of a ulid: no I, L, O, or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PRINCIPAL_ID = /^p_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `count` base-32 digits of `value`, most significant first. */
function digits(value: bigint, count: number): string {
	let out = "";
	let rest = value;
	for (let i = 0; i < count; i++) {
		out = ALPHABET.charAt(Number(rest & 31n)) + out;
		rest >>= 5n;
	}
	return out;
}

/**
 * A ulid: 48 bits of the time in milliseconds, then 80 random bits, as 26 base-32 digits, so ids
 * made later sort after earlier ones.
 */
function ulid(now = Date.now()): string {
	const random = crypto.getRandomValues(new Uint8Array(10));
	let entropy = 0n;
	for (const byte of random) entropy = (entropy << 8n) | BigInt(byte);
	return digits(BigInt(now), 10) + digits(entropy, 16);
}

/** The id of a principal the host creates: `p_` and a ulid. A principal carried over from 0.8 keeps its old speaker id instead. */
export function newPrincipalId(): string {
	return `p_${ulid()}`;
}

/** Whether `id` has the form `newPrincipalId` makes. */
export function isPrincipalId(id: string): boolean {
	return PRINCIPAL_ID.test(id);
}
