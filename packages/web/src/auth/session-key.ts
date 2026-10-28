import { randomBytes } from "node:crypto";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "pi-roundtable";
import { PluginError } from "pi-roundtable";

const KEY_BYTES = 32;

const readKey = (file: string): Buffer => {
	const key = readFileSync(file);
	if (key.length !== KEY_BYTES)
		throw new PluginError(
			`pi-roundtable-web: ${file} holds ${key.length} bytes, not ${KEY_BYTES}. It is the console's session key: delete it to sign everyone out and make a new one, or restore it`,
		);
	return key;
};

/**
 * The console's session key, `<dataDir>/web/session.key`: 32 random bytes, readable by its owner
 * only, made at the first start and kept so a restart does not sign anyone out. A file of the
 * wrong size stops startup instead of being used, since a short key would be a weak one.
 */
export function loadSessionKey(dataDir: string, logger: Logger): Buffer {
	const dir = join(dataDir, "web");
	const file = join(dir, "session.key");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let key: Buffer;
	try {
		key = readKey(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// Written whole under a temporary name, then linked into place: a second start never
		// reads a half-written key, and the first link wins.
		const temp = join(
			dir,
			`.session.key.${process.pid}.${randomBytes(4).toString("hex")}`,
		);
		writeFileSync(temp, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
		try {
			linkSync(temp, file);
		} catch (linkError) {
			if ((linkError as NodeJS.ErrnoException).code !== "EEXIST")
				throw linkError;
		} finally {
			unlinkSync(temp);
		}
		key = readKey(file);
	}
	if (statSync(file).mode & 0o077) {
		chmodSync(file, 0o600);
		logger.warn(
			{ file },
			"web-console: the session key was readable by others; its mode is now 0600",
		);
	}
	return key;
}
