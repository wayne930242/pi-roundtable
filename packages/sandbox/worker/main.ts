import { boundedText, isSandboxTurn } from "../src/protocol.ts";
import { runWorkerTurn } from "./agent.ts";

try {
	const raw: unknown = JSON.parse(
		await boundedText(Bun.stdin.stream(), 256 * 1024),
	);
	if (!isSandboxTurn(raw)) throw new Error("invalid turn");
	const reply = await runWorkerTurn(raw);
	process.stdout.write(JSON.stringify(reply));
} catch {
	process.stdout.write(
		JSON.stringify({ ok: false, text: "The sandbox worker failed." }),
	);
	process.exitCode = 1;
}
