import {
	CharacterError,
	type CharacterInput,
	type CharacterSpec,
	resolveCharacter,
} from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";
import { characterOf, overBase } from "./agent-rules.ts";
import type { Agent } from "./agent-store.ts";
import type { AvatarMode } from "./agent-tools.ts";
import type { TeamContext } from "./team-options.ts";

/** Said when an avatar is to be redrawn on a host without an image provider. */
const NO_IMAGE_PROVIDER =
	"No image provider is configured, so avatars cannot be redrawn; the current picture stays. A plugin fills the images slot to draw them.";

/** An input over a base look (see overBase); a bad field is an AgentError that names it. */
export function resolveLook(
	input: CharacterInput,
	base: CharacterSpec,
): CharacterSpec {
	try {
		return resolveCharacter(overBase(input, base), base);
	} catch (error) {
		if (error instanceof CharacterError)
			throw new AgentError(`The look is not usable: ${error.message}.`);
		throw error;
	}
}

/** Changing an agent's look and picture. */
export class TeamLooks {
	readonly #ctx: TeamContext;

	constructor(ctx: TeamContext) {
		this.#ctx = ctx;
	}

	/** The agent tool: changes a look, then says what the owner sees. */
	async avatar(name: string, look: CharacterInput): Promise<string> {
		const agent = await this.dress(name, look);
		return `"${agent.displayName}" now looks like a ${characterOf(agent).class}; the new picture shows from its next message.`;
	}

	/**
	 * Changes an agent's look. The input is resolved over the agent's current character; a new
	 * class keeps the agent's colors unless the input names a palette or colors. The picture is
	 * rendered before anything is stored, and the character and picture are stored together.
	 */
	async dress(name: string, input: CharacterInput): Promise<Agent> {
		const { store, studio, logger } = this.#ctx.options;
		const agent = store.activeAgent(name);
		const base = characterOf(agent);
		const character = resolveLook(input, base);
		let avatarHash: string;
		try {
			avatarHash = await studio.render(character);
		} catch (error) {
			throw new AgentError(
				`The picture could not be rendered: ${error instanceof Error ? error.message : String(error)}. The previous look stays.`,
			);
		}
		const dressed = await store.updateAgent(name, { character, avatarHash });
		logger.info({ agent: name, class: character.class }, "agent dressed");
		this.#ctx.changed();
		return dressed;
	}

	/** @deprecated Use `dress`; removed in 1.0. Draws and stores a new picture. */
	async redrawAvatar(
		name: string,
		mode: AvatarMode,
		text?: string,
	): Promise<Agent> {
		const { store, studio, logger } = this.#ctx.options;
		const agent = store.activeAgent(name);
		if (studio.canDraw === false) throw new AgentError(NO_IMAGE_PROVIDER);
		if (mode !== "redraw" && !text?.trim())
			throw new AgentError(
				mode === "edit"
					? "Give the edit instruction as text."
					: "Give the new avatar prompt as text.",
			);
		const avatarPrompt =
			mode === "new_prompt" ? (text as string) : agent.avatarPrompt;
		if (mode === "new_prompt") await store.updateAgent(name, { avatarPrompt });
		let hash: string;
		try {
			hash =
				mode === "edit"
					? await studio.edit(agent.avatarHash, text as string)
					: await studio.draw(avatarPrompt);
		} catch (error) {
			logger.warn({ agent: name, mode, err: error }, "avatar drawing failed");
			throw new AgentError(
				`The avatar could not be drawn: ${error instanceof Error ? error.message : String(error)}. The previous picture stays.`,
			);
		}
		logger.info({ agent: name, mode }, "avatar redrawn");
		return store.updateAgent(name, { avatarHash: hash });
	}
}
