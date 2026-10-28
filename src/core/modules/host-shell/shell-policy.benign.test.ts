// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text, where ${...} is bash syntax
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPANDED, lexShell } from "./shell-lexer.ts";
import { shellHoldRule } from "./shell-policy.ts";

/**
 * Holds apply in every mode, so a line an agent writes every day must not be held: each false
 * positive is a card for the owner. These lines run nothing the rule holds.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "shell-benign-")));
const work = join(root, "work");
const scratch = join(root, "scratch");
mkdirSync(work);
mkdirSync(scratch);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function classes(command: string): readonly string[] | undefined {
	return shellHoldRule.holdClasses?.(
		"bash",
		{ command },
		{ workspace: work, scratchDir: scratch },
	);
}

const BENIGN: readonly string[] = [
	// Arithmetic.
	"echo $(( $n + 1 ))",
	"n=$(( $(date +%s) - start )); echo $n",
	'echo "$(( $(date +%s) - $s ))"',
	"echo $(( ${#arr[@]} * 2 ))",
	"(( $n > 3 )) && echo big",
	"(( n > 3 )) && echo big",
	"(( i++ ))",
	"for ((i=0; i<3; i++)); do echo $i; done",
	"for (( i = 0; i < ${#a[@]}; i++ )); do echo ${a[$i]}; done",
	"echo $(( (1 + 2) * 3 ))",
	"echo $(( 1 << 3 | 2 ))",
	"x=$(( $x > 3 ? 1 : 2 ))",
	"while (( $n < 10 )); do n=$(( n + 1 )); done",
	"if (( $a >= $b )); then echo ge; fi",
	"echo $[ $n * 2 ]",
	// A script another shell reads.
	"bash -c 'echo $(date)'",
	"bash -c 'echo `date`'",
	'bash -c "echo \\$(date)"',
	"sh -c 'x=$(git rev-parse HEAD); echo $x'",
	"bash -lc 'echo $HOME'",
	// git and gh with messages.
	'git commit -m "fix: handle empty input"',
	"git commit -m \"$(cat <<'EOF'\nfeat: add the thing\n\nBody with 'quotes' and (parens).\nEOF\n)\"",
	"git commit -F - <<'EOF'\nmessage\nEOF",
	"git status --short",
	"git diff --stat HEAD~1",
	"git log --oneline -n 5",
	"git add src/a.ts src/b.ts && git commit -m wip",
	'git commit -am "$(git log -1 --format=%s)"',
	"git checkout -b feat/x",
	"git branch --show-current",
	"git rev-parse --short HEAD",
	"git fetch origin && git rebase origin/main",
	"git stash list",
	"gh pr view 12 --json title,body",
	"gh pr list --state open",
	"gh issue view 7",
	"gh run list --limit 5",
	// Build and test.
	"bun test",
	"bun test ./src --timeout 30000",
	"bun run typecheck && bun run lint",
	"bunx biome check .",
	"npm test",
	"npm run build -- --watch=false",
	"npx tsc --noEmit",
	"pnpm install --frozen-lockfile",
	"pytest -q tests/",
	"pytest -k 'not slow' -x",
	"python3 -m pytest tests/unit",
	"python3 -c 'print(1+1)'",
	"node -e 'console.log(1)'",
	"cargo test --quiet",
	"go test ./...",
	"make build",
	"tsc -p tsconfig.json",
	// Reading and searching.
	"ls -la",
	"cat package.json | jq .name",
	"jq '.scripts' package.json",
	"jq -r '.items[] | .name' data.json",
	"find . -name '*.ts' -not -path './node_modules/*'",
	"find src -type f -name '*.test.ts' | wc -l",
	"find . -name '*.log' -exec grep -l error {} \\;",
	"grep -rn 'TODO' src | head -20",
	"grep -R --include='*.ts' foo src | head",
	"rg 'foo|bar' src",
	"head -n 20 README.md",
	"tail -n 50 server.log",
	"wc -l src/*.ts",
	"sort -u names.txt | uniq -c | sort -rn | head",
	"awk '{print $1}' access.log | sort | uniq -c",
	"sed -n '1,20p' file.txt",
	"sed -i.bak 's/a/b/' file.txt",
	"diff -u a.txt b.txt",
	"tree -L 2",
	"du -sh .",
	"df -h",
	"ps aux | grep node",
	"which bun",
	"pwd",
	"date +%s",
	"uname -a",
	"env | sort",
	"echo $PATH | tr ':' '\\n'",
	"stat -f %z file.txt",
	"file image.png",
	"curl -s https://example.com | head",
	"curl -fsSL https://example.com/api -o out.json",
	// Variables and substitutions.
	"x=$(git rev-parse HEAD); echo $x",
	'x="$(ls | wc -l)"; echo "count: $x"',
	'echo "$@"',
	'for f in "$@"; do echo "$f"; done',
	"echo ${x:-default}",
	"echo ${#x} ${x%.ts} ${x##*/}",
	'branch=$(git branch --show-current) && echo "on $branch"',
	'echo "today is $(date +%F)"',
	"files=$(find . -name '*.ts' | head -5); echo $files",
	'name=${1:-world}; echo "hello $name"',
	"export FOO=bar && echo $FOO",
	"cd src && ls",
	"cd /tmp && pwd",
	// Loops, conditions and xargs.
	"for f in src/*.ts; do echo $f; done",
	"for i in 1 2 3; do echo $i; done",
	"for f in $(ls); do echo $f; done",
	"while read -r line; do echo $line; done < names.txt",
	'while IFS= read -r l; do echo "$l"; done <<< "$x"',
	"if [ -f package.json ]; then echo yes; else echo no; fi",
	"[ -d src ] && echo dir",
	"[[ $x == foo* ]] && echo match",
	'test -n "$x" || echo empty',
	"case $1 in start) echo go;; stop) echo no;; *) echo ?;; esac",
	"ls | xargs -n1 echo",
	"git ls-files | xargs wc -l",
	"find . -name '*.js' | xargs grep -l foo",
	"printf '%s\\n' a b c | while read x; do echo $x; done",
	"echo a && echo b || echo c",
	"{ echo a; echo b; } | sort",
	"(cd src && ls)",
	"time bun test",
	"true & wait",
	// Traps, exports and aliases that run nothing held.
	"trap 'echo done' EXIT",
	"trap 'rm -f tmp.txt' EXIT",
	"trap - EXIT",
	"trap -p",
	"export PATH=$PATH:/x && bun test",
	"env FOO=1 bun test",
	"FOO=1 BAR=2 bun test",
	"alias",
	// Redirects and heredocs inside the workspace.
	"echo hi > out.txt",
	"echo hi >> out.txt",
	"echo hi > /dev/null 2>&1",
	"ls nonexistent 2>/dev/null || echo none",
	"cat <<EOF > notes.txt\nsome text\nEOF",
	"cat <<'EOF'\n$(not run) `not run`\nEOF",
	"cat file.txt | tee out.log",
	"mkdir -p build/out && touch build/out/a",
	"cp a.txt b.txt",
	"mv a.txt b.txt",
	"rm -f build/out/a",
];

describe("everyday lines are not held", () => {
	test("the corpus is a hundred lines", () => {
		expect(BENIGN.length).toBeGreaterThanOrEqual(100);
	});

	for (const line of BENIGN)
		test(JSON.stringify(line), () =>
			expect([line, classes(line)]).toEqual([line, undefined]),
		);
});

describe("arithmetic is not a command", () => {
	test("words in an arithmetic expression are no command", () => {
		for (const line of [
			"echo $(( $n + 1 ))",
			"(( $n > 3 ))",
			"for ((i=0; i<3; i++)); do :; done",
		])
			expect([line, lexShell(line).commands.map((c) => c[0])]).not.toContain(
				"$n",
			);
		expect(lexShell("echo $(( $n + 1 ))").commands).toEqual([
			["echo", `$(${EXPANDED}`],
		]);
		expect(lexShell("(( $n > 3 )) && echo big").commands).toEqual([
			["echo", "big"],
		]);
	});

	test("a command inside arithmetic still runs and is held", () => {
		for (const line of [
			"echo $(( $(sudo x) ))",
			"echo $((1 + $(sudo x)))",
			"echo $(( `sudo x` + 1 ))",
			"(( $(sudo x) ))",
			"(( x = $(sudo x) + 1 ))",
			"echo $[ $(sudo x) ]",
			'echo "$(( $(sudo x) + 1 ))"',
			"echo $( (sudo x) )",
			"echo $( (sudo x); true )",
			"echo $((sudo x); (true))",
			"((sudo x); (true))",
			"(( 1 )); sudo x",
			"echo $(( 1 )); sudo x",
		])
			expect([line, classes(line)]).toEqual([line, ["shell.privilege"]]);
	});

	test("a script is judged by who expands what is in it", () => {
		for (const line of [
			"bash -c 'sudo x'",
			"bash -c 'echo $(sudo x)'",
			"bash -c 'echo `sudo x`'",
			"sh -c 'x=$(sudo x)'",
			"bash -c \"bash -c 'sudo x'\"",
		])
			expect([line, classes(line)]).toEqual([line, ["shell.privilege"]]);
		for (const line of [
			'bash -c "echo $(date)"',
			'bash -c "echo `date`"',
			'bash -c "$(echo sudo x)"',
			"bash -c $x",
		])
			expect([line, classes(line)]).toEqual([line, ["shell.unreadable"]]);
	});
});

describe("what runs later from a variable or a trap is held", () => {
	test("held as written", () => {
		for (const line of [
			"trap 'sudo x' EXIT",
			"trap 'sudo x' ERR; false",
			"trap -- 'sudo x' DEBUG",
		])
			expect([line, classes(line)]).toEqual([line, ["shell.privilege"]]);
		for (const line of [
			"alias s=sudo",
			"shopt -s expand_aliases\nalias s='sudo x'\ns",
			"PS4='$(x)' bash -x script.sh",
			"export PROMPT_COMMAND='x'",
			"env BASH_ENV=f bash -c true",
			"x='a[$(x)]'; echo $((x))",
			"x='a[$(x)]'; let x",
			"x='a[$(x)]'; [[ $x -eq 1 ]]",
			"x='$(x)'; echo ${x@P}",
		])
			expect([line, classes(line)]).toEqual([line, ["shell.unreadable"]]);
	});

	test("a literal $( next to arithmetic stays held, the cost of following a value into arithmetic", () => {
		expect(classes("echo '$(date)'; echo $((1 + 2))")).toEqual([
			"shell.unreadable",
		]);
		expect(classes("echo '$(date)'")).toBeUndefined();
		expect(classes("echo $((1 + 2))")).toBeUndefined();
	});

	test("a NUL byte is dropped as bash drops it", () => {
		expect(classes("\u0000sudo x")).toEqual(["shell.privilege"]);
		expect(classes("su\u0000do x")).toEqual(["shell.privilege"]);
	});
});
