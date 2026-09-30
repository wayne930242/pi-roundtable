import type { Http } from "../http.ts";
import type { Project } from "../project.ts";
import { fail, ok, type Result, skipped } from "../report.ts";

/**
 * The public address is a well-formed http(s) URL; with `reachable`, it also answers, which is
 * only true while the bot runs, so it is opt-in.
 */
export async function checkPublicUrl(
	project: Project,
	http: Http,
	reachable: boolean,
): Promise<Result> {
	const value = await project.text("http", "publicUrl");
	if (!value) return skipped("http.publicUrl has no value");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail(
			`${JSON.stringify(value)} is not a URL.`,
			"Write the full address, such as https://bot.example.com, in PUBLIC_URL in .env.",
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return fail(
			`${value} does not start with http:// or https://.`,
			"Discord fetches the agents' avatars from this address; use an http(s) URL.",
		);
	if (!reachable) return ok(`${value} is well formed`);
	try {
		const { status } = await http.get(value);
		return ok(`${value} answered ${status}`);
	} catch (error) {
		return fail(
			`${value} did not answer: ${error instanceof Error ? error.message : String(error)}`,
			"Start the bot (`roundtable start`) and check the tunnel or proxy that publishes this address.",
		);
	}
}
