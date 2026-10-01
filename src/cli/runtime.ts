import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DefinedRoundtable } from "../core/define-roundtable.ts";
import { defineRoundtable } from "../core/define-roundtable.ts";

/** A credential store that holds nothing and refuses writes, so looking never creates `auth.json`. */
const emptyCredentials: CredentialStore = {
	read: async () => undefined,
	list: async () => [],
	modify: async (): Promise<Credential | undefined> => {
		throw new Error("the doctor does not change logins");
	},
	delete: async () => {
		throw new Error("the doctor does not change logins");
	},
};

/**
 * The model login as the bot would open it, without creating the agent directory or
 * `auth.json` when there is none yet.
 */
export async function openModelRuntime(
	agentDir: string,
): Promise<ModelRuntime> {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const authPath = join(agentDir, "auth.json");
	return ModelRuntime.create(
		existsSync(authPath)
			? { authPath, refreshOnCreate: false }
			: { credentials: emptyCredentials, refreshOnCreate: false },
	);
}

/** Where the configured provider's login comes from (a key variable or the stored login), undefined when there is none. */
export async function providerLogin(
	agentDir: string,
	provider: string,
): Promise<string | undefined> {
	const check = await (await openModelRuntime(agentDir)).checkAuth(provider);
	return check ? (check.source ?? check.type) : undefined;
}

/** The configuration assembled as the bot will run it, over a login that is only read. */
export async function assemble(
	config: Parameters<typeof defineRoundtable>[0],
	agentDir: string,
): Promise<DefinedRoundtable> {
	return defineRoundtable(config, {
		modelRuntime: await openModelRuntime(agentDir),
	});
}
