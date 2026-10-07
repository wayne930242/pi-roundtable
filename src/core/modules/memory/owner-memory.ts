import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { messages } from "../../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import type { MemoryStore } from "../../services.ts";
import { toolError, toolText } from "../../shared/tool-result.ts";
import type { Speaker } from "../../speakers.ts";
import { timeZone, zonedToday } from "../../time.ts";
import type { Memory, PromptMemory } from "./owner-memory-store.ts";

function line(memory: Memory): string {
	return memory.eventDate
		? `- ${memory.eventDate}: ${memory.fact}`
		: `- ${memory.fact}`;
}

export function ownerMemorySection(
	memory: PromptMemory,
	today: string,
	/** Whose memory it is, when not the owner's. */
	speaker?: Speaker,
): string {
	const core =
		memory.core.length > 0
			? memory.core.map(line).join("\n")
			: "(nothing remembered yet)";
	const events =
		memory.events.length > 0 ? memory.events.map(line).join("\n") : "(none)";
	return [
		speaker ? `## Memory of ${speaker.name}` : "## Owner memory",
		`Today in ${messages().zoneName(timeZone())} is ${today}. What is stored right now, including anything you added earlier in this conversation; each appears once.`,
		`### Core facts\n${core}`,
		`### Upcoming events\n${events}`,
		"Notes (projects, people, references, past events) are not listed here. Use memory_search when a request may depend on them.",
	].join("\n\n");
}

/**
 * Adds the owner's core facts and upcoming events to every run, and registers
 * memory_add, memory_search, and memory_remove. The section goes into appendSystemPrompt
 * because claude-bridge forwards only the prompt's option sections to Claude Code, not a
 * replaced system prompt.
 */
export function ownerMemoryExtension(
	memories: MemoryStore,
	/** The owner's Discord id: the speaker whose memory a turn reads when no other speaks. */
	ownerId: string,
	owner: OwnerIdentity,
	/**
	 * The person the running turn is for, when it may be someone other than the owner. Their
	 * memory, not the owner's, is what the turn reads and changes; without it every turn is the owner's.
	 */
	speaker?: () => Speaker | undefined,
	/** Whether the tools tell the model that each speaker has a memory of their own. */
	describesSpeakers = speaker !== undefined,
): ExtensionFactory {
	const o = ownerWords(owner);
	/** The running turn's other speaker; undefined when the owner's own memory applies. */
	const other = (): Speaker | undefined => {
		const current = speaker?.();
		return current && current.id !== ownerId ? current : undefined;
	};
	const storeOf = () => memories.forSpeaker(other()?.id ?? ownerId);
	const shared = describesSpeakers
		? " Whoever is speaking has a memory of their own, shared by every agent; this reads and changes theirs, not someone else's."
		: "";
	return (pi) => {
		pi.on("before_agent_start", async (event) => {
			const today = zonedToday();
			const section = ownerMemorySection(
				await storeOf().forPrompt(today),
				today,
				other(),
			);
			const appended = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = appended
				? `${appended}\n\n${section}`
				: section;
		});

		pi.registerTool({
			name: "memory_add",
			label: "Remember",
			description: `Remember one fact about ${o.name} for future conversations, when ${o.he} asks you to or when it will clearly matter later. Search first and do not store what is already there. kind core: a stable fact about who ${o.he} is or how ${o.he} wants things done; it is shown in every conversation, so keep core facts few and short. kind note: projects, people, references, and other details worth finding later with memory_search. kind event: something happening on a date, shown until that date passes.${shared}`,
			parameters: Type.Object({
				fact: Type.String({
					description:
						"One self-contained fact, written so it makes sense on its own later.",
				}),
				kind: Type.Union(
					[Type.Literal("core"), Type.Literal("note"), Type.Literal("event")],
					{ description: "core, note, or event." },
				),
				date: Type.Optional(
					Type.String({
						description: "For an event: its date as YYYY-MM-DD.",
					}),
				),
			}),
			execute: async (_toolCallId, params) => {
				const saved = await storeOf().add(
					params.fact,
					params.kind,
					params.date,
				);
				return toolText(`Remembered as ${saved.kind}: ${line(saved).slice(2)}`);
			},
		});

		pi.registerTool({
			name: "memory_search",
			label: "Search memory",
			description: `Search everything remembered about ${o.name}, including notes and past events. Give a few short keywords separated by spaces, in the language the memory is likely written in; results contain any of them, best matches first.${shared}`,
			parameters: Type.Object({
				query: Type.String({ description: "Keywords separated by spaces." }),
			}),
			execute: async (_toolCallId, params) => {
				const found = await storeOf().search(params.query);
				return toolText(
					found.length === 0
						? `Nothing remembered matches "${params.query}".`
						: found
								.map((memory) => `- [${memory.kind}] ${line(memory).slice(2)}`)
								.join("\n"),
				);
			},
		});

		pi.registerTool({
			name: "memory_remove",
			label: "Forget",
			description: `Forget remembered facts about ${o.name}. Removes every remembered fact that contains the given text.${shared}`,
			parameters: Type.Object({
				text: Type.String({
					description: "Text contained in the fact or facts to forget.",
				}),
			}),
			execute: async (_toolCallId, params) => {
				const removed = await storeOf().remove(params.text);
				if (removed.length === 0) {
					return toolError(
						`No remembered fact contains "${params.text}". Nothing was forgotten.`,
					);
				}
				return toolText(
					`Forgot:\n${removed.map((fact) => `- ${fact}`).join("\n")}`,
				);
			},
		});
	};
}
