import { definePlugin } from "pi-roundtable";

/** Pi packages are npm packages whose Pi extensions every session loads; install each one in your project first. */
export const webSearch = definePlugin({
	name: "web-search",
	setup: () => ({
		piPackages: ["pi-web-access"],
	}),
});
