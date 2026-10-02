import { expect, test } from "bun:test";
import type { ChatSurface } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { imageReply } from "./reply-files.ts";

test("reply_image records its attachment without posting ahead of the agent", async () => {
	let posted = false;
	const surface: ChatSurface = {
		surface: "fake",
		supportsFiles: true,
		start: async () => undefined,
		sendReply: async () => {
			posted = true;
		},
	};
	const harness = await testPlugin(imageReply, { surfaces: [surface] });
	try {
		expect(
			await harness.runTool("reply_image", {}, { channel: "fake:room" }),
		).toBe("The sample image is attached to this turn's reply.");
		expect(posted).toBe(false);
		expect(harness.files).toHaveLength(1);
		expect(harness.files[0]?.channel).toBe("fake:room");
		expect(harness.files[0]?.file.name).toBe("sample.png");
		expect(harness.files[0]?.file.data.slice(0, 8)).toEqual(
			new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		);
		await expect(harness.runTool("reply_image", {})).rejects.toThrow(
			"does not support reply files",
		);
	} finally {
		await harness.stop();
	}
});
