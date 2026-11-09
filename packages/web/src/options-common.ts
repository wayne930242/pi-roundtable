import { PluginError } from "pi-roundtable";

export function fail(message: string): never {
	throw new PluginError(`pi-roundtable-web: ${message}`);
}
