import { expect, test } from "bun:test";
import { MAX_MESSAGE_CHARS } from "../src/api-types.ts";
import {
	firstLine,
	fitsBack,
	joinBack,
	LONG_TEXT_NOTE,
	PASTE_AS_FILE_CHARS,
	pastedTextName,
	planFiles,
	planPaste,
	planSend,
	textFile,
	uploadForSend,
	usedSlots,
} from "./lib/attach.ts";

const LIMITS = { perMessage: 4, maxBytes: 100 * 1024 * 1024 };
const file = (name: string, size = 10) =>
	new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
const long = "x".repeat(PASTE_AS_FILE_CHARS);

test("a paste of files attaches them, whatever text comes with them, as a pasted image does", () => {
	const image = new File([new Uint8Array(3)], "image.png", {
		type: "image/png",
	});
	expect(
		planPaste({ files: [image], text: "some caption" }, 0, LIMITS),
	).toEqual({ kind: "files", files: [image] });
});

test("a paste of long text becomes a file, a short one goes into the box, and no slot left says so", () => {
	expect(planPaste({ files: [], text: "short" }, 0, LIMITS)).toEqual({
		kind: "insert",
	});
	expect(planPaste({ files: [], text: long.slice(1) }, 0, LIMITS).kind).toBe(
		"insert",
	);
	expect(planPaste({ files: [], text: long }, 3, LIMITS)).toEqual({
		kind: "text",
		text: long,
	});
	expect(planPaste({ files: [], text: long }, 4, LIMITS)).toEqual({
		kind: "full",
	});
});

test("picked, pasted or dropped files are taken up to the message's slots, and the rest are named as refused", () => {
	const plan = planFiles(
		[
			file("a"),
			file("b"),
			file("huge", LIMITS.maxBytes + 1),
			file("c"),
			file("d"),
		],
		1,
		LIMITS,
	);
	expect(plan.accepted.map((f) => f.name)).toEqual(["a", "b", "c"]);
	expect(plan.tooLarge.map((f) => f.name)).toEqual(["huge"]);
	expect(plan.full.map((f) => f.name)).toEqual(["d"]);
	// A file of any type is taken: the app has no list of types any more.
	expect(
		planFiles([file("x.zip"), file("y.ts")], 0, LIMITS).accepted,
	).toHaveLength(2);
	// Before the server has said what the limits are, nothing is refused here.
	expect(planFiles([file("a")], 9, undefined).accepted).toHaveLength(1);
});

test("a message within the limit is sent as typed; over it, it goes as message.txt with a short line", () => {
	expect(planSend("  hello  ", 0, LIMITS)).toEqual({ ok: true, text: "hello" });
	const atLimit = "y".repeat(MAX_MESSAGE_CHARS);
	expect(planSend(atLimit, 0, LIMITS)).toEqual({ ok: true, text: atLimit });
	const over = "z".repeat(MAX_MESSAGE_CHARS + 1);
	expect(planSend(over, 0, LIMITS)).toEqual({
		ok: true,
		text: LONG_TEXT_NOTE,
		overflow: over,
	});
	// The file takes a slot; with none left the send is stopped, with a reason to show.
	expect(planSend(over, 4, LIMITS)).toEqual({ ok: false, reason: "full" });
	expect(planSend(over, 3, LIMITS).ok).toBe(true);
});

test("a long text taken back goes after what is typed, when it fits", () => {
	expect(joinBack("", "pasted")).toBe("pasted");
	expect(joinBack("note", "pasted")).toBe("note\npasted");
	expect(joinBack("note\n", "pasted")).toBe("note\npasted");
	expect(fitsBack("", "a".repeat(MAX_MESSAGE_CHARS))).toBe(true);
	expect(fitsBack("b", "a".repeat(MAX_MESSAGE_CHARS))).toBe(false);
});

test("pasted text files are numbered from the first free number, and the chip previews the first line with something on it", () => {
	expect(pastedTextName([])).toBe("pasted-text-1.txt");
	expect(pastedTextName(["pasted-text-1.txt", "pasted-text-3.txt"])).toBe(
		"pasted-text-2.txt",
	);
	expect(firstLine("\n\n  First   line here \nsecond")).toBe("First line here");
	expect(firstLine("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
	expect(firstLine("   \n  ")).toBe("");
});

test("a text file is UTF-8, so the server keeps it as text and its size is the bytes", async () => {
	const made = textFile("pasted-text-1.txt", "\u4f60\u597d hello");
	expect(made.type).toStartWith("text/plain");
	expect(made.size).toBe(new TextEncoder().encode("\u4f60\u597d hello").length);
	expect(await made.text()).toBe("\u4f60\u597d hello");
});

test("RV-F004: only chips that can be sent take a slot, so a failed upload does not block a long message", () => {
	expect(
		usedSlots([{ failed: "x" }, {}, { failed: undefined }, { failed: "y" }]),
	).toBe(2);
	expect(usedSlots([])).toBe(0);
	// With three failed chips and one good one, a message over the limit still fits as a file.
	const used = usedSlots([
		{ failed: "a" },
		{ failed: "b" },
		{ failed: "c" },
		{},
	]);
	expect(planSend("z".repeat(MAX_MESSAGE_CHARS + 1), used, LIMITS).ok).toBe(
		true,
	);
});

const view = (id: string, name: string) => ({
	id,
	name,
	type: "text/plain",
	size: 1,
});

test("RV-F003/F004: a send uploads held texts in order, skips failed chips, and puts the overflow last", async () => {
	const uploaded: string[] = [];
	const io = {
		upload: async (file: File) => {
			uploaded.push(file.name);
			return view(`id-${uploaded.length}`, file.name);
		},
		discard: async () => undefined,
	};
	const result = await uploadForSend(
		[
			{ name: "a.png", upload: view("have-a", "a.png") },
			{ name: "pasted-text-1.txt", text: "long" },
			{ name: "bad.bin", failed: "nope" },
		],
		"overflow",
		io,
	);
	expect(result.map((r) => r.id)).toEqual(["have-a", "id-1", "id-2"]);
	expect(uploaded).toEqual(["pasted-text-1.txt", "message.txt"]);
});

test("RV-F003: when a send fails midway, the files it made are deleted again and the chips' own uploads are kept", async () => {
	const discarded: string[] = [];
	let calls = 0;
	const io = {
		upload: async (file: File) => {
			calls += 1;
			if (calls === 2) throw new Error("too much is waiting");
			return view(`made-${calls}`, file.name);
		},
		discard: async (id: string) => {
			discarded.push(id);
		},
	};
	await expect(
		uploadForSend(
			[
				{ name: "keep.png", upload: view("kept", "keep.png") },
				{ name: "pasted-text-1.txt", text: "one" },
				{ name: "pasted-text-2.txt", text: "two" },
			],
			undefined,
			io,
		),
	).rejects.toThrow("too much is waiting");
	expect(discarded).toEqual(["made-1"]);
	// A failing discard does not hide the error that matters.
	calls = 0;
	const flaky = {
		...io,
		discard: async () => {
			throw new Error("offline");
		},
	};
	await expect(
		uploadForSend(
			[
				{ name: "pasted-text-1.txt", text: "one" },
				{ name: "pasted-text-2.txt", text: "two" },
			],
			undefined,
			flaky,
		),
	).rejects.toThrow("too much is waiting");
});
