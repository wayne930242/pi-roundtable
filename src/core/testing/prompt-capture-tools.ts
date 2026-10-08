import type { ChatSurface } from "../contract/surface.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin.ts";

/**
 * Every built-in tool a deployment may select for its conversations, as an app's selection
 * names them; a host without a tool's plugin runs without it.
 */
const SELECTED = [
	"delegate_task",
	"discord_add_member_role",
	"discord_ban_member",
	"discord_create_channel",
	"discord_create_role",
	"discord_create_thread",
	"discord_delete_channel",
	"discord_delete_channel_permissions",
	"discord_delete_message",
	"discord_delete_role",
	"discord_edit_channel",
	"discord_edit_message",
	"discord_edit_role",
	"discord_edit_thread",
	"discord_find_members",
	"discord_get_channel_info",
	"discord_get_messages",
	"discord_get_pinned_messages",
	"discord_kick_member",
	"discord_list_channels",
	"discord_list_roles",
	"discord_list_servers",
	"discord_list_threads",
	"discord_pin_message",
	"discord_remove_member_role",
	"discord_search_messages",
	"discord_send_message",
	"discord_set_channel_permissions",
	"discord_set_nickname",
	"discord_timeout_member",
	"discord_unban_member",
	"discord_unpin_message",
	"memory_add",
	"memory_remove",
	"memory_search",
	"notify_owner",
	"schedule_cancel",
	"schedule_create",
	"schedule_list",
	"schedule_update",
];

/**
 * A surface whose conversations run persona turns through `context.turns`; hands over its context.
 * With `background`, a claim of its conversations answers background turns there, as a plugin's
 * conversations on a Discord host do, so their sessions schedule and delegate; without it, as the
 * 0.8 web chat's, they take none.
 */
export const personas = (
	seen: (context: PluginContext) => void,
	background: boolean,
): RoundtablePlugin => ({
	name: "capture-personas",
	setup: (context) => {
		seen(context);
		const surface: ChatSurface = {
			surface: "fake",
			start: async () => undefined,
			sendReply: async () => undefined,
		};
		return {
			// As the self-compact plugin of a project `roundtable init` creates.
			piPackages: ["pi-self-compact"],
			agentSelection: () => ({ tools: SELECTED, groups: [] }),
			surfaces: [surface],
			channels: [
				{
					name: "capture-personas",
					priority: 0,
					owns: (channel) => channel.startsWith("fake:"),
					admit: () => undefined,
					...(background
						? {
								background: async () => ({
									status: "skipped" as const,
									reason: "the capture host runs no background turns",
								}),
							}
						: {}),
					startFresh: async () => "study",
				},
			],
			personas: [
				{ kind: "study", prompt: () => "You are a tutor." },
				{ kind: "chat", prompt: () => "You answer on the web." },
			],
		};
	},
});
