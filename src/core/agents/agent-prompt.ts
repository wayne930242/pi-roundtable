import { messages } from "../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../identity.ts";
import { addressee, type Speaker } from "../speakers.ts";
import type { Agent, AgentGroup, Backlog } from "./agent-store.ts";

/**
 * The base every agent turn starts with, followed by the agent's own prompt. `shared` is the
 * prompt every persona shares, the assistant's included (persona/shared.md).
 */
export function agentSystemPrompt(input: {
	agent: Agent;
	/** The agent in the entry channel. */
	coordinator?: Agent;
	shared: string;
	/** The shared prompt for a speaker who is not the owner, where `shared` speaks to the owner. */
	guestShared?: string;
	workDir: string;
	owner: OwnerIdentity;
	/** The host account the shell and file tools run as. */
	shellUser: string;
	group?: { group: AgentGroup; members: readonly Agent[] };
	/** Who the turn is for; without one, or the owner, the prompt speaks to the owner. */
	speaker?: Speaker;
	/** Whether agents can redraw avatars; false without an image provider. Default true. */
	avatars?: boolean;
}): string {
	const { agent, coordinator, shared, workDir, owner, shellUser, group } =
		input;
	const who = addressee(input.speaker, owner);
	const o = ownerWords(owner);
	const w = ownerWords(who);
	const guest = input.speaker && input.speaker.tier !== "owner";
	const parts = [
		(guest && input.guestShared) || shared,
		`You are "${agent.displayName}" (agent name \`${agent.name}\`), one of ${o.name}'s agents in ${o.his} Discord agent server. Each agent owns one channel and one conversation; you all share ${o.his} tools and ${o.his} memory.`,
		roleText(agent, coordinator, who),
		`The team: agent_list shows every agent and group; agent_get and agent_update read and improve any agent's prompt, display name, model, and thinking level, yours included; agent_create adds an agent with its own channel; ${input.avatars === false ? "" : "agent_avatar redraws an avatar; "}schedule_list with agent reads another agent's schedules. A message marked as coming from another agent is that agent speaking, not ${w.name}; only ${w.name} approves held actions.`,
		`Your shell and file tools run on ${o.his} VPS as the user ${shellUser}, in the shared workspace ${workDir}. Commands that are destructive or change the system, and writes outside the workspace, are held for ${w.his} confirmation: tell ${w.him} exactly what will run and ask ${w.him} to confirm.`,
	];
	if (group) {
		const others = group.members
			.flatMap((m) => (m.name === agent.name ? [] : [`"${m.displayName}"`]))
			.join(", ");
		parts.push(
			`You are now speaking in the group chat "${group.group.displayName}" with ${w.name} and ${others}. Each of your turns shows the group messages since your last turn. Speak only for yourself and add what your role brings; do not repeat what others said. To hand the next word to a member, mention them as @display name.`,
		);
	} else {
		parts.push(
			"message_agent hands a self-contained request to another agent; it answers later, and its answer comes back to you as a new turn.",
		);
	}
	parts.push(`## Your role\n${agent.prompt}`);
	if (input.speaker && input.speaker.tier !== "owner")
		parts.push(speakerText(input.speaker, owner));
	return parts.join("\n\n");
}

/**
 * Says whom the turn is for when it is not the owner, after every operator text that names the
 * owner, so those texts read as the owner's and this one decides who is addressed.
 */
function speakerText(speaker: Speaker, owner: OwnerIdentity): string {
	const o = ownerWords(owner);
	const w = ownerWords(addressee(speaker, owner));
	return `## The current speaker\nYou are talking with ${speaker.name} (Discord user ${speaker.id}), who speaks at the ${speaker.tier} tier of this server, not with ${o.name}. The text above describes the server's owner, ${o.name}. Address ${w.name}, take ${w.his} answers and approvals, and read a tool description that names ${o.name} as ${w.name}. Your memory is ${w.his} own, not ${o.name}'s, and other people's memory is not yours to share. Tools above the ${speaker.tier} tier are not available to you this turn.`;
}

/** Who coordinates the team, so a specialist never takes that role (spec behavior 55). */
function roleText(
	agent: Agent,
	coordinator: Agent | undefined,
	addressed: OwnerIdentity,
): string {
	const o = ownerWords(addressed);
	if (coordinator?.name === agent.name)
		return `You are the team's coordinator: ${o.name}'s general requests come to you, and you hand specialist work to the agent that owns it.`;
	const who = coordinator
		? `The team's coordinator is "${coordinator.displayName}" (\`${coordinator.name}\`) in <#${coordinator.channelId}>.`
		: "The team's coordinator is the agent in the server's entry channel.";
	return `${who} You are a specialist: speak of yourself only as "${agent.displayName}", never as the coordinator. Team work ${o.name} asks of you directly, such as creating agents or groups, archiving, or arranging channels, you do in your own name. When your role below is empty or only a placeholder, ask ${o.him} what your job is before taking on other work.`;
}

/** What a target agent receives from message_agent. */
export function agentMessageText(
	from: Agent,
	text: string,
	who: OwnerIdentity,
): string {
	return `(Message from the agent "${from.displayName}" (\`${from.name}\`), not from ${who.name}. Answer it; your answer is posted in your channel and sent back to "${from.displayName}".)\n\n${text}`;
}

/** What the sender receives when the target has answered. */
export function agentReplyText(
	who: OwnerIdentity,
	from: Agent,
	text: string,
	thread?: string,
): string {
	return `(The agent "${from.displayName}" (\`${from.name}\`) answered your message. Continue with it and tell ${who.name} what matters; your reply is posted in your channel.${threadNote(thread)})\n\n${text}`;
}

/** Where the exchange was posted, when it had a thread. */
function threadNote(thread: string | undefined): string {
	return thread
		? ` The exchange is in the thread ${thread}, now archived; link it when useful.`
		: "";
}

/** What the sender receives when the target could not answer. */
export function agentFailureText(
	who: OwnerIdentity,
	from: Agent,
	reason: string,
	thread?: string,
): string {
	return `(The agent "${from.displayName}" (\`${from.name}\`) could not answer your message: ${reason}. Tell ${who.name} briefly, or try again later.${threadNote(thread)})`;
}

/** A new agent's first turn. */
export function openingTaskText(
	creator: Agent | undefined,
	task: string,
	who: OwnerIdentity,
): string {
	const by = creator ? `the agent "${creator.displayName}"` : who.name;
	return `(You were just created by ${by}, and this is your channel. Introduce yourself in one or two sentences, then start on this task.)\n\n${task}`;
}

/**
 * A group member's turn: the messages since its last turn, oldest first. The closing line
 * names the speaker, so a message that addresses it is not read as its own.
 */
export function groupTurnText(
	group: AgentGroup,
	self: Agent,
	backlog: Backlog,
): string {
	const skipped =
		backlog.skipped > 0
			? `; ${backlog.skipped} earlier messages are not shown`
			: "";
	const lines = backlog.messages.map((m) => `[${m.authorName}] ${m.text}`);
	const body =
		lines.length > 0
			? lines.join("\n\n")
			: "(No new messages since your last turn.)";
	return `(Group chat "${group.displayName}": messages since your last turn, oldest first${skipped}.)\n\n${body}\n\n(You are ${self.displayName}, and it is your turn to speak in the group. Each bracketed name above is another speaker; a message mentioning @${self.displayName} is addressed to you.)`;
}

/** How a message_agent request appears in the target's channel. */
export function deliveredMessagePost(to: Agent, text: string): string {
	return messages().messageDelivered(to.displayName, text);
}

/** How the target's answer appears in the sender's channel. */
export function returnedAnswerPost(text: string): string {
	return messages().answerReturned(text);
}

/** Why a chain of agent messages stops without the owner in between. */
export function chainLimitReason(who: OwnerIdentity): string {
	const o = ownerWords(who);
	return `This chain of agent messages has reached 8 messages without ${o.name} in between, so it is stopped. Tell ${o.him} what was done and ask whether to continue.`;
}
