/** One file of a zip: the name it is stored under and its bytes. */
export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

/** General purpose flag bit 11: the entry's name is UTF-8. */
const UTF8_NAME = 0x0800;
/** The version a store-only, UTF-8-named entry needs: 2.0. */
const VERSION = 20;
/** "Made by" Unix, spec 2.0: unzip then reads names as they are instead of as a DOS code page. */
const MADE_BY = (3 << 8) | VERSION;
/** A regular file readable by all, writable by its owner, in the Unix half of the attributes. */
const FILE_MODE = 0o100644 << 16;
/** The most bytes or entries a zip without the 64-bit extension can describe. */
const MAX_BYTES = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

/** The DOS date and time of `at`, as zip headers keep them, in UTC. */
function dosTime(at: Date): { time: number; date: number } {
	const year = Math.max(at.getUTCFullYear(), 1980);
	return {
		time:
			(at.getUTCHours() << 11) |
			(at.getUTCMinutes() << 5) |
			Math.floor(at.getUTCSeconds() / 2),
		date:
			((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
	};
}

/**
 * Packs the entries into one zip, stored without compression: a local header and the bytes of
 * each entry, then the central directory that lists them. Throws past what a zip without the
 * 64-bit extension holds; the caller caps the total well below that.
 */
export function zipStore(
	entries: readonly ZipEntry[],
	at = new Date(),
): Uint8Array {
	if (entries.length > MAX_ENTRIES)
		throw new Error("too many files for one zip");
	const encoder = new TextEncoder();
	const { time, date } = dosTime(at);
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const crc = Bun.hash.crc32(entry.data);
		const size = entry.data.byteLength;
		if (size > MAX_BYTES || offset > MAX_BYTES)
			throw new Error("the files are too large for one zip");
		const local = new Uint8Array(30 + name.byteLength);
		const l = new DataView(local.buffer);
		l.setUint32(0, 0x04034b50, true);
		l.setUint16(4, VERSION, true);
		l.setUint16(6, UTF8_NAME, true);
		l.setUint16(8, 0, true);
		l.setUint16(10, time, true);
		l.setUint16(12, date, true);
		l.setUint32(14, crc, true);
		l.setUint32(18, size, true);
		l.setUint32(22, size, true);
		l.setUint16(26, name.byteLength, true);
		l.setUint16(28, 0, true);
		local.set(name, 30);
		const central = new Uint8Array(46 + name.byteLength);
		const c = new DataView(central.buffer);
		c.setUint32(0, 0x02014b50, true);
		c.setUint16(4, MADE_BY, true);
		c.setUint16(6, VERSION, true);
		c.setUint16(8, UTF8_NAME, true);
		c.setUint16(10, 0, true);
		c.setUint16(12, time, true);
		c.setUint16(14, date, true);
		c.setUint32(16, crc, true);
		c.setUint32(20, size, true);
		c.setUint32(24, size, true);
		c.setUint16(28, name.byteLength, true);
		// Extra and comment lengths, disk number and internal attributes stay 0.
		c.setUint32(38, FILE_MODE >>> 0, true);
		c.setUint32(42, offset, true);
		central.set(name, 46);
		locals.push(local, entry.data);
		centrals.push(central);
		offset += local.byteLength + size;
	}
	const directorySize = centrals.reduce(
		(sum, part) => sum + part.byteLength,
		0,
	);
	if (offset + directorySize > MAX_BYTES)
		throw new Error("the files are too large for one zip");
	const end = new Uint8Array(22);
	const e = new DataView(end.buffer);
	e.setUint32(0, 0x06054b50, true);
	e.setUint16(8, entries.length, true);
	e.setUint16(10, entries.length, true);
	e.setUint32(12, directorySize, true);
	e.setUint32(16, offset, true);
	const out = new Uint8Array(offset + directorySize + end.byteLength);
	let cursor = 0;
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, cursor);
		cursor += part.byteLength;
	}
	return out;
}

/** The names made unique the way a download folder does: `a.pdf`, `a-2.pdf`, `a-3.pdf`. */
export function uniqueNames(names: readonly string[]): string[] {
	const taken = new Set<string>();
	return names.map((name) => {
		const dot = name.lastIndexOf(".");
		const [stem, ext] =
			dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
		let candidate = name;
		for (let n = 2; taken.has(candidate.toLowerCase()); n++)
			candidate = `${stem}-${n}${ext}`;
		taken.add(candidate.toLowerCase());
		return candidate;
	});
}
