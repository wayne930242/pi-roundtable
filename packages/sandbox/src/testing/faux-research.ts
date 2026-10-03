import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolText } from "pi-roundtable/kit";

/** A model that calls the host's fetch tool, then a tool the host left inactive, and reports both results. */
export default function fauxResearch(pi: ExtensionAPI) {
	const core = createFauxCore({ provider: "faux", models: [{ id: "worker" }] });
	core.setResponses([
		fauxAssistantMessage(
			fauxToolCall("fetch_content", { url: "https://example.invalid/page" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("host_secret_tool", {}), {
			stopReason: "toolUse",
		}),
		(context) =>
			fauxAssistantMessage(
				`results=${JSON.stringify(context.messages.filter((message) => message.role === "toolResult"))}`,
			),
	]);
	for (const name of ["web_search", "fetch_content", "get_search_content"])
		pi.registerTool({
			name,
			label: name,
			description: `host ${name}`,
			parameters: { type: "object", properties: {} } as never,
			execute: async () => toolText(`HOST ${name} ran`),
		});
	pi.registerTool({
		name: "host_secret_tool",
		label: "secret",
		description: "must stay inactive",
		parameters: { type: "object", properties: {} } as never,
		execute: async () => toolText("no"),
	});
	pi.registerProvider("faux", {
		api: core.api,
		apiKey: "offline",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: core.models,
	});
}
