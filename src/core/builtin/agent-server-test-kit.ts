import type { PlaceProvider } from "../contract/places.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { RoundtablePlugin } from "../plugin-api/plugin.ts";

/** The surfaces and place providers the host would link: a stand-in surface for each provider and a room surface for each of `rooms`. */
export function placesPlugin(
	rooms: readonly string[],
	providers: readonly PlaceProvider[],
): RoundtablePlugin[] {
	if (rooms.length + providers.length === 0) return [];
	const surface = (name: string, agentRooms: boolean): ChatSurface => ({
		surface: name,
		start: async () => undefined,
		sendReply: async () => undefined,
		...(agentRooms ? { agentRooms: true } : {}),
	});
	return [
		{
			name: "places-fixture",
			setup: () => ({
				surfaces: [
					...providers.map((p) => surface(p.surface, false)),
					...rooms.map((room) => surface(room, true)),
				],
				places: [...providers],
			}),
		},
	];
}
