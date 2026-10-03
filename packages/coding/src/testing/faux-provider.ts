import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fauxProvider(pi: ExtensionAPI) {
	writeFileSync(join(process.cwd(), "worker.pid"), String(process.pid));
	if (existsSync(join(process.cwd(), "start-descendant"))) {
		const child = Bun.spawn(["sleep", "60"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		writeFileSync(join(process.cwd(), "descendant.pid"), String(child.pid));
	}
	const core = createFauxCore({ provider: "faux", models: [{ id: "worker" }] });
	core.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", {
				path: join(process.cwd(), "..", "approval-marker.txt"),
				content: "approved",
			}),
			{ stopReason: "toolUse" },
		),
		(context) =>
			fauxAssistantMessage(
				`Worker pid=${process.pid}. externalContext=${JSON.stringify(context.messages).includes("EXTERNAL_CONTEXT_CANARY")}, repoContext=${JSON.stringify(context.messages).includes("REPO_CONTEXT_CANARY")}, hostPrompt=${JSON.stringify(context.messages).includes("HOST_PROMPT_CANARY")}. ${JSON.stringify(context.messages.filter((message) => message.role === "toolResult"))}`,
			),
	]);
	pi.registerProvider("faux", {
		api: core.api,
		apiKey: "offline",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: core.models,
	});
}
