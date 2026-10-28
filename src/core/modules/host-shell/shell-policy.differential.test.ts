// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text, where ${...} is bash syntax
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellHoldRule } from "./shell-policy.ts";

/**
 * The invariant of the shell hold rule, checked against real bash: if bash runs `sudo`, the rule
 * holds the line. Every corpus line puts `sudo marker` where a destructive command would be; bash
 * runs it with a PATH that holds only stubs, so the one program that can run is a script that
 * creates a marker file. Nothing destructive is ever executed.
 */

const SUDO = "sudo marker";

/** Lines that run `X` (read as `sudo marker`) when bash executes them. */
const RUNS: readonly string[] = [
	// Plain placements.
	"X",
	"echo hi; X",
	"echo hi && X",
	"false || X",
	"echo hi | X",
	"echo hi\nX",
	"\tX",
	"echo\thi;\tX",
	"X & wait",
	"true & X; wait",
	"true && X || false",
	"false || false || X",
	"FOO=bar X",
	"FOO=$(true) X",
	"env X",
	"env FOO=1 X",
	"command X",
	"exec X",
	"time X",
	"! X",
	"echo a | xargs X",
	"find . -exec X {} \\;",
	"eval 'X'",
	'eval "echo hi; X"',
	"bash -c 'X'",
	'bash -ec "X"',
	"sh -c 'echo hi; X'",
	"bash -o pipefail -c 'X'",
	`bash -c "echo 'it'\\"'\\"'s'; X"`,
	// Grouping.
	"(X)",
	"( (X) )",
	"{ X; }",
	"{ echo a; X; }",
	"(echo a; (echo b; X))",
	"( X ) | cat",
	"f() { X; }; f",
	"function f { X; }; f",
	"[[ a == a ]] && X",
	"test a = a && X",
	// Control flow.
	"if true; then X; fi",
	"if false; then :; else X; fi",
	"if false; then :; elif true; then X; fi",
	"for i in 1; do X; done",
	"while true; do X; break; done",
	"until false; do X; break; done",
	"case a in a) X;; esac",
	"case a in (a) X ;; esac",
	"case a in b) :;; a|c) X;; esac",
	"case a in\n  a)\n    X\n    ;;\nesac",
	"case a in a) case b in b) X;; esac;; esac",
	"case $(echo a) in (a) (X) ;; (z) :;; esac",
	"{ case a in (a) (X) ;; esac; }",
	"case a in a) (X) ;; esac",
	// Substitutions.
	"x=$(X)",
	"echo $(X)",
	"echo `X`",
	'echo "$(X)"',
	'echo "`X`"',
	'echo "a $(echo "$(X)") b"',
	'echo "$(echo "$(echo "$(X)")")"',
	"echo `echo \\`X\\``",
	'echo "`echo \\"\\`X\\`\\"`"',
	"echo $( (X) )",
	"echo $((1 + $(X)))",
	"echo $[1 + $(X)]",
	'echo "${x:-$(X)}"',
	"echo ${x:-$(X)}",
	"echo ${x:-`X`}",
	'echo "${x:-"$(X)"}"',
	": ${x:=$(X)}",
	"cat <<< $(X)",
	"echo $(X) | cat",
	"FOO=$(X) true",
	// The reviewer's inputs.
	`echo "$(echo "x$(echo ")")" ; X)"`,
	'echo "$(echo hi # )\nX)"',
	'echo "$(case x in x) X;; esac)"',
	"echo $'\\'' ; X",
	"cat <<EOF\nit's\nEOF\nX",
	'echo "$(cat <<EOF\nit\'s\nEOF\n)" ; X',
	'git() { :; }; git commit -m "$(cat <<EOF\nit\'s\nEOF\n)" ; X',
	// Names built at run time.
	"{sudo,ls} marker",
	"s{u,}do marker",
	"echo hi; {sudo,true} marker",
	"$'\\x73udo' marker",
	"$'\\163udo' marker",
	"$'\\u0073udo' marker",
	"x=sudo; $x marker",
	"x=sudo; ${x} marker",
	'cmd=sudo\n"$cmd" marker',
	"$(echo sudo) marker",
	"`echo sudo` marker",
	"for c in sudo; do $c marker; done",
	"s\"\"u'd'o marker",
	"\\sudo marker",
	// Scripts built at run time.
	'eval "echo $a\\b ; x=$(echo $# X)"',
	'bash -c "echo $(echo X)"',
	"x=$(echo X); eval $x",
	'eval "$(echo X)"',
	// Parentheses that bash versions read differently.
	`echo "$(case x in y|x) echo )' ;; y) :;; esac # $(\nX)"`,
	'echo "$(case x in x) echo ) ;; esac; X)"',
	// Comments.
	"echo a # c\nX",
	'echo "$(echo $((1 << 2)) echo a # "\nx=\'$(X)\')" # `\necho `if true; then X; fi # (\necho ${#x} echo a`',
	"echo a #it's\nX",
	'echo "a" # "\nX',
	"echo ${#PATH}; X",
	"echo {#}; X",
	"echo a{b,#c}; X",
	"echo $#; X",
	"echo a\\ #b; X",
	"echo a#b; X",
	"echo $(echo # it's \nX)",
	'echo "$(echo # it\'s\nX)"',
	'echo "$(echo hi # "\nX)"',
	// Case inside substitutions.
	'echo "$(case x in (x) echo a;; y) echo b;; esac; X)"',
	'echo "$(case x in x) case y in y) :;; esac;; esac; X)"',
	'echo "$(case x in x) echo case;; esac; X)"',
	'echo "$(case x in x) echo esac;; esac; X)"',
	'echo "$(case x in x|y) :;; esac)" ; X',
	'echo "$(case x in x) ;; esac)"; X',
	// ANSI-C and locale quotes.
	"echo $'a\\'b' ; X",
	"echo $'\\\\' ; X",
	'echo $"x" ; X',
	"echo $'it\\'s' $(X)",
	"echo $'\\'' $(X)",
	"echo $'\\'' \"$(X)\"",
	// Heredocs and here-strings.
	"cat <<-EOF\n\tit's\n\tEOF\nX",
	"cat <<'EOF'\nit's\nEOF\nX",
	'cat <<"EOF"\n"\nEOF\nX',
	"cat <<\\EOF\n'\nEOF\nX",
	"cat <<EOF\n$(X)\nEOF",
	"cat <<EOF\n`X`\nEOF",
	"cat <<EOF\nit's $(X)\nEOF",
	"cat <<EOF\n${x:-$(X)}\nEOF",
	'x="$(cat <<EOF\nit\'s\nEOF\n)"; X',
	"cat <<A <<B\nit's\nA\n\"\nB\nX",
	"cat <<EOF | cat\nit's\nEOF\nX",
	"cat <<EOF; X\nit's\nEOF",
	'cat <<EOF\n"\nEOF\nX',
	"echo $(cat <<EOF\nx'\nEOF\n); X",
	"cat <<EOF\nEOF\nX",
	"cat <<EOF\r\nit's\r\nEOF\r\nX",
	"cat <<EOF\r\nbody\r\nEOF\nX",
	"cat <<'EOF'\n$(echo hi)\nEOF\nX",
	"cat <<EOF\n\\$(echo hi)\nEOF\nX",
	'cat <<<"it\'s"; X',
	"cat <<<'$(echo)'; X",
	'cat <<< "$(echo it\'s)"; X',
	"cat <<'EOF'\n#\nEOF\nX",
	"cat <<EOF >/dev/null\nit's\nEOF\nX",
	"cat <<EOF\nit's\nEOF\n\nX",
	"{ cat <<EOF\nit's\nEOF\nX; }",
	"if true; then cat <<EOF\nit's\nEOF\nX; fi",
	"f() { cat <<EOF\nit's\nEOF\n}; X",
	// Arithmetic and shifts.
	"echo $((1<<2)); X",
	"echo $((1<<2)) $(X)",
	"(( 1<<2 )); X",
	"echo $[1<<2]; X",
	"echo $(( $(X) ))",
	"x=$((1+2)); X",
	"echo $((2 > 1)) ; X",
	"(( x = 1 << 3 )) && X",
	"echo $((1<<2))\nX",
	// Line continuation.
	"su\\\ndo marker",
	"echo a \\\n ; X",
	'echo "a\\\nb"; X',
	"ec\\\nho; X",
	"echo a\\\n&& X",
	"echo $(echo \\\n); X",
	// Quotes.
	"echo 'a' \"b\" 'c'; X",
	'echo "a\'b"; X',
	"echo 'a\"b'; X",
	'echo "a\\"b"; X',
	'echo a\\"b; X',
	'echo "$(echo \\")"; X',
	"echo '$(' ; X",
	"echo '`' ; X",
	'echo "\'" ; X',
	"echo '\"' ; X",
	'echo "\\\\" ; X',
	"echo \\' ; X",
	// Redirections.
	"echo hi >/dev/null; X",
	"echo hi 2>&1; X",
	"echo hi >&2; X",
	"echo hi >| /dev/null; X",
	"echo hi &>/dev/null; X",
	"cat </dev/null; X",
	"echo hi <>/dev/null; X",
	"echo hi >>/dev/null; X",
	"3>&1 X",
	"X >/dev/null",
	"X 2>&1",
	// Deeper nesting.
	`echo ${'"$(echo '.repeat(8)}X${')"'.repeat(8)}`,
	`echo ${"$(".repeat(30)}X${")".repeat(30)}`,
	`echo ${'"$('.repeat(60)}X${')"'.repeat(60)}`,
];

/** Lines that run `X` through the less common ways bash has of running a command. */
const WIDE: readonly string[] = [
	// Here-strings and here-documents.
	'cat <<< "$(X)"',
	"cat <<<$(X)",
	"cat <<< `X`",
	"cat <<-EOF\n\t$(X)\n\tEOF",
	"cat <<-EOF\n\tit's\n\tEOF\nX",
	"cat <<-'EOF'\n\t$(X)\n\tEOF\nX",
	'cat <<E"O"F\nit\'s\nEOF\nX',
	"cat <<E\\OF\nit's\nEOF\nX",
	"cat <<EOF <<EOF2\n$(X)\nEOF\nb\nEOF2",
	"cat <<A; cat <<B\n$(X)\nA\nb\nB",
	"cat <<A <<B\na\nA\n$(X)\nB",
	"cat <<A <<'B'\n$(X)\nA\nb\nB",
	"cat <<A | cat <<B\na\nA\nb\nB\nX",
	"echo `cat <<EOF\n$(X)\nEOF\n`",
	"echo $(cat <<EOF\n`X`\nEOF\n)",
	"echo $(echo `cat <<EOF\n$(X)\nEOF\n`)",
	"echo $(cat <<EOF\nit's\nEOF\n; X)",
	"cat <<EOF\n$(cat <<IN\n$(X)\nIN\n)\nEOF",
	"cat <<EOF\r\n$(X)\r\nEOF\r\n",
	// Functions, coprocesses, aliases, select, traps.
	"coproc X; wait",
	"coproc NAME { X; }; wait",
	"f() (X); f",
	"f() ( X ); f",
	"f () { X; }; f",
	"function f() { X; }; f",
	"function f { X; }\nf",
	"f() { g; }; g() { X; }; f",
	"shopt -s expand_aliases\nalias s='X'\ns",
	"shopt -s expand_aliases; alias s='X'\ns",
	"shopt -s expand_aliases\nalias s=sudo\ns marker",
	"shopt -s expand_aliases\nalias echo='X;'\necho hi",
	"select i in a; do X; break; done <<< 1",
	"echo 1 | { select i in a; do X; break; done; }",
	"trap 'X' EXIT",
	'trap "X" EXIT',
	"trap -- 'X' EXIT",
	"trap 'X' ERR; false",
	"trap 'echo hi; X' EXIT",
	'trap "X" DEBUG; true',
	// Tests, arithmetic and expansions that run commands.
	"[[ $(X) ]]",
	"[[ -n $(X) ]]",
	'[ -z "$(X)" ]',
	"(( $(X) ))",
	"(( x = $(X) + 1 ))",
	"echo $(( $(X) + 1 ))",
	"echo $(( `X` + 1 ))",
	'echo "$(( $(X) + 1 ))"',
	"for ((i=0; i<$(X)+1; i++)); do :; done",
	"echo $[ $(X) ]",
	"(((X)))",
	"((X); (true))",
	"echo $((X); (true))",
	"echo $( (X) )",
	"echo $( (X); true )",
	"echo $( ((X); (true)) )",
	"echo $(( 1 )); X",
	"(( 1 )); X",
	"x='a[$(X)]'; echo $((x))",
	"x='a[$(X)]'; (( x ))",
	"x='a[$(X)]'; [[ $x -eq 1 ]]",
	"x='a[$(X)]'; let x",
	"x='a[$(X)]'; declare -i y; y=$x",
	"x='$(X)'; echo ${x@P}",
	"x='$(X)'; echo \"${x@P}\"",
	"PS4='$(X)' bash -xc true",
	"PS4='$(X) ' bash -xc 'true'",
	"cat <(X)",
	"diff <(X) <(X)",
	"echo hi > >(X); wait",
	"echo hi | tee >(X) > /dev/null; wait",
	// Redirections and execution wrappers.
	"exec 3>&1; X",
	"exec >/dev/null; X",
	"exec 3</dev/null; X",
	"exec 2>&1\nX",
	"exec 3>/dev/null 4>&1 X",
	"time -p X",
	"time -p -- X",
	"command -p X",
	"command -- X",
	"builtin command X",
	"env -i X",
	"env -u FOO X",
	"nohup X",
	"nice -n 5 X",
	"timeout 5 X",
	"timeout -s KILL 5 X",
	"stdbuf -oL X",
	"xargs -n1 X <<< 1",
	// Environment that makes a shell run something.
	"BASH_ENV=/dev/null bash -c 'X'",
	"PROMPT_COMMAND='X'; true",
	"PS1='$(X)'; true",
	"export PROMPT_COMMAND='X'",
	// Escapes, line endings and unusual characters.
	"echo $'a\\nb'; X",
	"echo $'a\\nX'",
	"x=$'\\n'; X",
	"echo hi\r\nX",
	"X\r\necho hi\r\n",
	"echo hi\r\n\r\nX\r\n",
	"echo ‘hi’; X",
	"echo “hi”; X",
	"echo “$(X)”",
	"echo ‘$(X)’",
	"echo ＄(X)",
	"echo hi # ‘\nX",
	"echo \\\r\nX",
	"echo hi;\nX",
	"echo hi;;\nX",
	"echo a\u00a0b; X",
	"echo\u00a0hi; X",
	"echo hi\u2028X",
];

/** Lines that carry a NUL byte, which cannot be an argument; bash reads them from standard input. */
const NUL: readonly string[] = [
	"echo a\u0000b; X",
	"echo a\u0000\nX",
	"X\u0000",
	"\u0000X",
	"echo '\u0000'; X",
	"echo $'\\0'; X",
];

/** Lines whose `X` bash does not run; they only have to be handled without error. */
const INERT: readonly string[] = [
	"echo '$(X)'",
	"echo '`X`'",
	"echo a # X",
	"echo a #X; echo b",
	"cat <<'EOF'\n$(X)\nEOF",
	"cat <<'EOF'\nX\nEOF",
	"cat <<EOF\nX\nEOF",
	"cat <<EOF\n\\$(X)\nEOF",
	'echo "\\$(X)"',
	"echo $'X'",
	"echo \\$(X)",
	"echo $((1<<2)) # X",
	"echo {#}; echo a # X",
	"case a in b) X;; esac",
	"if false; then X; fi",
	"false && X",
	"true || X",
	"echo 'it''s' ; echo \"X\"",
	'cat <<E"O"F\n$(X)\nEOF',
	"cat <<-'EOF'\n\t$(X)\n\tEOF",
	"cat <<A <<'B'\na\nA\n$(X)\nB",
	"echo ＄(X)",
	"echo ‘$(X)’",
	"builtin X",
	"echo $((1 + 2)) '$(X)'",
	"x=1; echo $((x))",
];

const BASHES = [
	...new Set(
		[Bun.which("bash"), "/bin/bash"].filter(
			(path): path is string => path !== null && existsSync(path),
		),
	),
];

/** The directory of stub programs, and a scratch directory to run in; nothing real is on the PATH. */
function sandbox(): {
	root: string;
	stubs: string;
	cwd: string;
	marker: string;
} {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "shell-diff-")));
	const stubs = join(root, "bin");
	const cwd = join(root, "cwd");
	mkdirSync(stubs);
	mkdirSync(cwd);
	const stub = (name: string, body: string) => {
		const file = join(stubs, name);
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
	};
	stub("sudo", `: >> "$MARKER"`);
	stub("cat", `while IFS= read -r line; do echo "$line"; done`);
	stub(
		"env",
		`for a; do case "$a" in *=*) shift;; *) break;; esac; done\nexec "$@"`,
	);
	stub("xargs", `exec "$@"`);
	for (const shell of ["bash", "sh"])
		if (BASHES[0]) stub(shell, `exec ${BASHES[0]} "$@"`);
	stub(
		"find",
		`while [ "$#" -gt 0 ] && [ "$1" != "-exec" ]; do shift; done\nshift\nexec "$@"`,
	);
	return { root, stubs, cwd, marker: join(root, "marker") };
}

const box = sandbox();
afterAll(() => rmSync(box.root, { recursive: true, force: true }));

/** Whether bash ran `sudo` for this line. */
function runs(bash: string, line: string): boolean {
	rmSync(box.marker, { force: true });
	const options = {
		cwd: box.cwd,
		env: { PATH: box.stubs, MARKER: box.marker, HOME: box.cwd },
		timeout: 10_000,
		stdio: ["pipe", "ignore", "ignore"] as ["pipe", "ignore", "ignore"],
	};
	// A NUL byte cannot be an argument, so such a line is the script on standard input.
	if (line.includes("\u0000"))
		spawnSync(bash, ["--norc", "--noprofile"], { ...options, input: line });
	else
		spawnSync(bash, ["--norc", "--noprofile", "-c", line], {
			...options,
			input: "",
		});
	return existsSync(box.marker);
}

function held(line: string): boolean {
	return (
		shellHoldRule.describe(
			"bash",
			{ command: line },
			{ workspace: box.cwd, scratchDir: join(box.cwd, "scratch") },
		) !== undefined
	);
}

const ALL = [...RUNS, ...WIDE, ...NUL];

const lines = (corpus: readonly string[]) =>
	corpus.map((template) => template.replaceAll("X", SUDO));

describe.skipIf(BASHES.length === 0)("sudo run by bash is held", () => {
	test("the harness sees bash run the stub", () => {
		for (const bash of BASHES) {
			expect(runs(bash, SUDO)).toBe(true);
			expect(runs(bash, `echo '${SUDO}'`)).toBe(false);
		}
	});

	test("every line of the corpus that runs sudo is held", {
		timeout: 300_000,
	}, () => {
		const missed: string[] = [];
		let executed = 0;
		for (const line of lines(ALL)) {
			for (const bash of BASHES) {
				if (!runs(bash, line)) continue;
				executed++;
				if (!held(line)) missed.push(`${bash}: ${JSON.stringify(line)}`);
			}
		}
		// A corpus whose lines bash does not run proves nothing.
		expect(executed).toBeGreaterThan(ALL.length * BASHES.length * 0.85);
		expect(missed).toEqual([]);
	});

	test("lines that hide sudo from bash are read without error", () => {
		for (const line of lines(INERT)) held(line);
	});
});

describe("the corpus", () => {
	test("never runs anything but stubs", () => {
		for (const line of lines(ALL))
			expect(line).not.toMatch(/\/(usr|bin|sbin)\/|\brm\b|\bdd\b|\bkill/);
	});
});
