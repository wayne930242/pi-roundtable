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
	const made = textFile("pasted-text-1.txt", "你好 hello");
	expect(made.type).toStartWith("text/plain");
	expect(made.size).toBe(new TextEncoder().encode("你好 hello").length);
	expect(await made.text()).toBe("你好 hello");
});
