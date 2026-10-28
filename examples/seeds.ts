import { definePlugin } from "pi-roundtable";

/** Seeds are agents created on the first start; an agent already stored is never overwritten, so edit it in Discord afterwards. */
export const library = definePlugin({
	name: "library",
	setup: () => ({
		seeds: [
			{
				name: "librarian",
				displayName: "Librarian",
				prompt:
					"You keep the team's reading list. Answer briefly and cite what you were given.",
				character: { class: "scholar", palette: "azure" },
			},
		],
	}),
});
