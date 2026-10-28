import { expect, test } from "bun:test";
import { fileResponse, safeName } from "./files.ts";

test("RV-F006: a file name in the download header is percent-encoded to the characters RFC 5987 allows", () => {
	const meta = { id: "i", name: "a(b)*'c d.txt", type: "text/plain", size: 1 };
	const header =
		fileResponse(meta, new Blob(["x"])).headers.get("content-disposition") ??
		"";
	expect(header).toBe("attachment; filename*=UTF-8''a%28b%29%2A%27c%20d.txt");
	for (const char of ["(", ")", "*", "'"])
		expect(header.slice(header.indexOf("''") + 2)).not.toContain(char);
	// Non-ASCII stays encoded as before.
	expect(
		fileResponse(
			{ ...meta, name: "\u6a94\u6848.md" },
			new Blob(["x"]),
		).headers.get("content-disposition"),
	).toBe("attachment; filename*=UTF-8''%E6%AA%94%E6%A1%88.md");
});

test("RV-F006: a file name loses the bidirectional controls that make 'invoice\\u202Egpj.exe' read as something else", () => {
	expect(safeName("invoice\u202Egpj.exe")).toBe("invoicegpj.exe");
	expect(safeName("a\u2066b\u2069c\u202Ad\u202C.txt")).toBe("abcd.txt");
	expect(safeName("\u202E")).toBe("file");
	// Ordinary right-to-left text is not touched.
	expect(safeName("שלום.txt")).toBe("שלום.txt");
});
