// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text, where ${...} is bash syntax
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HoldRule } from "../../holds.ts";
import {
	shellHoldRule,
	shellHoldRuleFor,
	simpleCommands,
	YOLO_CARDED_SHELL_CLASSES,
} from "./shell-policy.ts";

describe("simpleCommands", () => {
	test("splits on operators and removes quotes", () => {
		expect(simpleCommands(`echo 'a b' && ls -la | grep "x y"; df -h`)).toEqual([
			["echo", "a b"],
			["ls", "-la"],
			["grep", "x y"],
			["df", "-h"],
		]);
	});

	test("keeps redirections as words", () => {
		expect(simpleCommands("echo hi > /etc/x 2>&1")).toEqual([
			["echo", "hi", ">", "/etc/x", "dup", "1"],
		]);
		// A number set apart from the operator is an argument, not the descriptor.
		expect(simpleCommands("nice -n 5 </dev/null ls")).toEqual([
			["nice", "-n", "5", "<", "/dev/null", "ls"],
		]);
	});
});

const OWN = shellHoldRuleFor({
	ownPushOwners: ["octocat"],
	heldPushRepos: ["octocat/deployed-app", "octocat/held-app"],
});

/** A workspace with GitHub-remote repos, a scratch dir, and a dir outside both. */
let root: string;
let work: string;
let scratch: string;
let outside: string;

function repo(dir: string, url?: string): string {
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
	git("init", "-q");
	git(
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"x",
	);
	if (url) git("remote", "add", "origin", url);
	return dir;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "shell-policy-")));
	work = join(root, "work");
	scratch = join(root, "scratch");
	outside = join(root, "outside");
	mkdirSync(scratch);
	mkdirSync(outside);
	repo(
		join(work, "repos/octocat/knowledge-base"),
		"https://github.com/octocat/knowledge-base.git",
	);
	const prep = repo(
		join(work, "tmp/kb-prep"),
		"git@github.com:octocat/knowledge-base.git",
	);
	execFileSync("git", ["-C", prep, "tag", "v1"]);
	repo(join(work, "other"), "https://github.com/someone/else.git");
	repo(join(work, "held"), "ssh://git@github.com/octocat/held-app.git");
	repo(join(work, "bare"));
	symlinkSync(outside, join(scratch, "link"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function held(
	command: string,
	rule: Readonly<HoldRule> = OWN,
): string | undefined {
	return rule.describe(
		"bash",
		{ command },
		{ workspace: work, scratchDir: scratch },
	);
}

function heldFile(tool: string, path: string): string | undefined {
	return OWN.describe(tool, { path }, { workspace: work, scratchDir: scratch });
}

describe("shell holds with scratch roots", () => {
	test("the live worktree and push commands run", () => {
		expect(
			held(
				`cd ${work}/repos/octocat/knowledge-base && git fetch -q && W=${work}/tmp/kb-prep && rm -rf $W && git worktree prune && git worktree add -q --detach $W origin/main && ls`,
			),
		).toBeUndefined();
		expect(
			held(
				`cd ${work}/tmp/kb-prep && git add -A && git commit -qm "notes: prep" && git push -q origin HEAD:main`,
			),
		).toBeUndefined();
	});

	test("a redirect into the scratch dir runs, into the rest of /tmp it is held", () => {
		expect(
			held("bun run typecheck >$TMPDIR/o.txt 2>&1; tail $TMPDIR/o.txt"),
		).toBeUndefined();
		expect(held(`bun run typecheck > ${scratch}/o.txt`)).toBeUndefined();
		expect(held("bun run typecheck >/tmp/o.txt 2>&1")).toContain(
			"writes to /tmp/o.txt",
		);
		expect(held("echo x > /tmp/x")).toBeString();
		expect(held("echo x > /etc/x")).toBeString();
		expect(held("echo x | tee ~/.bashrc")).toBeString();
		expect(held(`echo x | tee ${scratch}/x`)).toBeUndefined();
	});

	test("write and edit run under the scratch dir and the workspace only", () => {
		expect(heldFile("write", `${scratch}/notes.md`)).toBeUndefined();
		expect(heldFile("edit", `${scratch}/notes.md`)).toBeUndefined();
		expect(heldFile("write", `${work}/notes.md`)).toBeUndefined();
		expect(heldFile("write", "/tmp/x")).toBeString();
		expect(heldFile("edit", "/etc/hosts")).toBeString();
	});
});

describe("rm", () => {
	test("runs when every operand is inside a scratch root", () => {
		expect(held(`rm -rf ${scratch}/a ${work}/b`)).toBeUndefined();
		expect(held("rm -f $TMPDIR/a.txt")).toBeUndefined();
		expect(held(`D=${scratch}/d; rm -r "$D" "\${D}2"`)).toBeUndefined();
		expect(held(`export D=${scratch}/d && rm -r $D`)).toBeUndefined();
		expect(held(`rm -rf ${scratch}/*.log`)).toBeUndefined();
		expect(held(`cd ${scratch} && rm x`)).toBeUndefined();
		expect(held("rm build/out.txt")).toBeUndefined();
	});

	test("is held outside the roots, on a root itself, or when an operand is unknown", () => {
		for (const command of [
			`rm -rf ${outside}/a`,
			`rm -rf ${scratch}/a ${outside}/b`,
			`rm -rf ${scratch}`,
			`rm -rf ${scratch}/`,
			`rm -rf ${work}`,
			`rm -rf ${scratch}/..`,
			"rm -rf /",
			"rm -rf /tmp/x",
			`rm -rf "$(mktemp -d)"`,
			"rm -rf $(mktemp -d)",
			`W=$(mktemp -d) && rm -rf $W`,
			"rm -rf $UNKNOWN/x",
			"rm -rf ~other/x",
			`rm -rf ${scratch}/link/x`,
			`rm -rf ${scratch}/link`,
			`rm -rf ${outside}/*`,
			`rm -rf ${scratch}/.*`,
			"rm -rf",
			"rm",
			`find . | xargs rm -f ${scratch}/a`,
			`cd ${outside} && rm x`,
			"sudo rm -rf ./x",
		])
			expect(held(command)).toBeString();
	});
});

describe("git push", () => {
	const prep = () => `cd ${work}/tmp/kb-prep && `;

	test("runs to the owner's own repository", () => {
		expect(held(`${prep()}git push origin HEAD:main`)).toBeUndefined();
		expect(held(`${prep()}git push -u origin feature`)).toBeUndefined();
		expect(held(`git -C ${work}/tmp/kb-prep push`)).toBeUndefined();
		expect(
			held(`${prep()}git push https://github.com/octocat/knowledge-base main`),
		).toBeUndefined();
	});

	test("is held when it forces, deletes, or pushes tags", () => {
		for (const tail of [
			"git push -f origin main",
			"git push --force-with-lease origin main",
			"git push origin +main",
			"git push origin --delete old",
			"git push -d origin old",
			"git push origin :old",
			"git push --tags",
			"git push --follow-tags origin main",
			"git push --mirror",
			"git push --all origin",
			"git push --prune origin",
			"git push origin refs/tags/v2",
			"git push origin v1",
			"git push origin HEAD:v1",
			"git -c remote.origin.url=x push",
			"GIT_DIR=/x git push",
		])
			expect(held(prep() + tail)).toBeString();
	});

	test("is held for another owner, a held repository, an unknown remote or directory", () => {
		expect(held(`cd ${work}/other && git push origin main`)).toBeString();
		expect(held(`cd ${work}/held && git push origin main`)).toBeString();
		expect(held(`cd ${work}/bare && git push origin main`)).toBeString();
		expect(held(`${prep()}git push upstream main`)).toBeString();
		expect(held(`cd $NOWHERE && git push`)).toBeString();
		expect(held(`(cd ${work}/tmp/kb-prep) && git push`)).toBeString();
		expect(
			held(`${prep()}git push https://github.com/someone/else main`),
		).toBeString();
	});

	test("the strict default holds every push", () => {
		expect(held(`${prep()}git push origin HEAD:main`, shellHoldRule)).toContain(
			"pushes to GitHub",
		);
		expect(held(`${prep()}git push -f origin main`, shellHoldRule)).toContain(
			"force-pushes",
		);
	});
});

function classes(
	command: string,
	rule: Readonly<HoldRule> = shellHoldRule,
): readonly string[] | undefined {
	return rule.holdClasses?.(
		"bash",
		{ command },
		{ workspace: work, scratchDir: scratch },
	);
}

describe("the classes of a held shell call", () => {
	const prep = () => `cd ${work}/tmp/kb-prep && `;

	test("a call that runs has none", () => {
		expect(classes("ls -la && echo hi")).toBeUndefined();
		expect(classes(`echo x > ${scratch}/o.txt`)).toBeUndefined();
		expect(classes("rm -rf $TMPDIR/x")).toBeUndefined();
	});

	test("each destructive program has its own class", () => {
		const table: [string, string][] = [
			["sudo ls", "shell.privilege"],
			["su -c ls", "shell.privilege"],
			["doas ls", "shell.privilege"],
			["dd if=/dev/zero of=/dev/sda", "shell.disk"],
			["mkfs.ext4 /dev/sda1", "shell.disk"],
			["shutdown -h now", "shell.power"],
			["reboot", "shell.power"],
			["kill -9 1", "shell.kill"],
			["pkill node", "shell.kill"],
			["rm -rf /var/x", "shell.rm"],
			["systemctl restart nginx", "shell.service"],
			["service nginx stop", "shell.service"],
			["docker rm web", "shell.docker"],
			["docker compose down", "shell.docker"],
			["ufw allow 22", "shell.firewall"],
			["iptables -F", "shell.firewall"],
			["apt-get install jq", "shell.packages"],
			["dpkg -i x.deb", "shell.packages"],
			["git reset --hard HEAD~1", "shell.reset-hard"],
			["gh pr merge 3", "shell.gh"],
			["gh api -X DELETE /repos/a/b", "shell.gh"],
			["crontab -r", "shell.crontab"],
			["echo x > /etc/f", "shell.write"],
			["echo x | tee /etc/f", "shell.write"],
		];
		for (const [command, expected] of table)
			expect([command, classes(command)]).toEqual([command, [expected]]);
	});

	test("a plain push is shell.push, a forced one shell.force-push", () => {
		expect(classes(`${prep()}git push origin HEAD:main`)).toEqual([
			"shell.push",
		]);
		expect(classes(`${prep()}git push --force origin main`)).toEqual([
			"shell.force-push",
		]);
		expect(classes(`${prep()}git push -f origin main`)).toEqual([
			"shell.force-push",
		]);
		expect(classes(`${prep()}git push origin +main`)).toEqual([
			"shell.force-push",
		]);
		expect(classes(`${prep()}git push origin --delete main`)).toEqual([
			"shell.force-push",
		]);
	});

	test("a push that prunes remote refs is shell.force-push", () => {
		expect(classes(`${prep()}git push --prune origin`)).toEqual([
			"shell.force-push",
		]);
		expect(classes(`${prep()}git push origin --prune refs/heads/*`)).toEqual([
			"shell.force-push",
		]);
	});

	test("a redirect or tee to a device other than /dev/null is shell.disk", () => {
		const table: [string, string][] = [
			["echo x > /dev/sda", "shell.disk"],
			["cat img >> /dev/nvme0n1", "shell.disk"],
			["echo x | tee /dev/sda", "shell.disk"],
			["echo x | tee -a /dev/disk0", "shell.disk"],
			["echo x 2> /dev/sda", "shell.disk"],
		];
		for (const [command, expected] of table)
			expect([command, classes(command)]).toEqual([command, [expected]]);
		expect(classes("echo x > /dev/null")).toBeUndefined();
	});

	test("a redirect or tee target that cannot be expanded is shell.disk", () => {
		for (const command of [
			"echo x > $(printf /dev/sda)",
			"echo x > $DISK",
			"echo x | tee $(printf /dev/sda)",
			"echo x | /usr/bin/tee $(printf /dev/sda)",
			"echo x | env tee $(printf /dev/sda)",
			"echo x >| /dev/sda",
			"echo x >& /dev/sda",
			"1<>/dev/sda",
			"echo x <> /dev/sda",
		])
			expect([command, classes(command)]).toEqual([command, ["shell.disk"]]);
		expect(classes("echo x | tee /dev/null")).toBeUndefined();
	});

	test("a substitution inside double quotes is judged like an unquoted one", () => {
		expect(classes(`echo "$(rm -rf ~)"`)).toEqual(["shell.rm"]);
		expect(classes(`x="$(dd if=/dev/zero of=/dev/sda)"`)).toEqual([
			"shell.disk",
		]);
		expect(classes('echo "`sudo reboot`"')).toEqual(["shell.privilege"]);
		expect(classes(`echo "a $(echo "$(sudo ls)") b"`)).toEqual([
			"shell.privilege",
		]);
		expect(classes(`echo "$(sudo ls`)).toEqual(["shell.privilege"]);
		expect(classes(`echo '$(rm -rf ~)'`)).toBeUndefined();
		expect(classes(`echo "$(date)" > ${scratch}/out.txt`)).toBeUndefined();
		expect(classes(`echo "$(date)" > /etc/out.txt`)).toEqual(["shell.write"]);
		expect(classes("echo x 2>&1")).toBeUndefined();
		expect(classes("echo x >&2")).toBeUndefined();
	});

	test("a push the policy lets run has no class", () => {
		expect(classes(`${prep()}git push origin HEAD:main`, OWN)).toBeUndefined();
	});

	test("every held command of a line counts, not only the first", () => {
		expect(classes("echo x > /etc/f; sudo ls")).toEqual([
			"shell.write",
			"shell.privilege",
		]);
		expect(classes("sudo ls && rm -rf /var/x")).toEqual([
			"shell.privilege",
			"shell.rm",
		]);
	});

	test("one command can be held for two reasons", () => {
		expect(classes("sudo tee /etc/f > /etc/g")).toEqual([
			"shell.write",
			"shell.privilege",
		]);
	});

	test("commands inside bash -c count, at any depth", () => {
		expect(classes(`bash -c "rm -rf /x"`)).toEqual(["shell.rm"]);
		expect(classes(`sh -c 'echo > /etc/x; sudo ls'`)).toEqual([
			"shell.write",
			"shell.privilege",
		]);
		expect(classes(`bash -c "bash -c 'sudo ls'"`)).toEqual(["shell.privilege"]);
		expect(classes(`echo hi > /etc/x; bash -c "git reset --hard"`)).toEqual([
			"shell.write",
			"shell.reset-hard",
		]);
	});

	test("wrappers and substitutions do not hide a class", () => {
		expect(classes("env FOO=1 sudo ls")).toEqual(["shell.privilege"]);
		expect(classes("echo $(sudo ls)")).toEqual(["shell.privilege"]);
		expect(classes("ls | xargs rm")).toEqual(["shell.rm"]);
	});

	test("a class is listed once", () => {
		expect(classes("sudo ls; sudo ls")).toEqual(["shell.privilege"]);
	});

	test("write and edit outside the roots are shell.write", () => {
		const context = { workspace: work, scratchDir: scratch };
		expect(
			shellHoldRule.holdClasses?.("write", { path: "/etc/x" }, context),
		).toEqual(["shell.write"]);
		expect(
			shellHoldRule.holdClasses?.("edit", { path: "/etc/x" }, context),
		).toEqual(["shell.write"]);
		expect(
			shellHoldRule.holdClasses?.("write", { path: `${scratch}/x` }, context),
		).toBeUndefined();
	});

	test("the descriptions stay as they were", () => {
		expect(held("echo x > /etc/f; sudo ls", shellHoldRule)).toContain(
			"writes to /etc/f",
		);
	});
});

describe("a command line the lexer must read to the end", () => {
	const rm = ["shell.rm"];
	const cases: [string, string, string[]][] = [
		[
			"RV4-F001: a quote closed inside a nested substitution",
			`echo "$(echo "x$(echo ")")" ; rm -rf ~)"`,
			rm,
		],
		[
			"RV4-F002: a comment in a quoted substitution hides its )",
			'echo "$(echo hi # )\nrm -rf ~)"',
			rm,
		],
		[
			"RV4-F003: a case pattern's ) does not close the substitution",
			'echo "$(case x in x) rm -rf ~;; esac)"',
			rm,
		],
		[
			"RV4-F003: nested cases and a leading parenthesis",
			'echo "$(case x in (x) case y in y) :;; esac;; esac; rm -rf ~)"',
			rm,
		],
		["RV4-F004: \\' closes nothing in $'...'", "echo $'\\'' ; rm -rf ~", rm],
		[
			"RV4-F005: an apostrophe in a here-document body",
			"cat <<EOF\nit's\nEOF\nrm -rf ~",
			rm,
		],
		[
			"RV4-F005: and inside a substitution",
			'git commit -m "$(cat <<EOF\nit\'s\nEOF\n)" ; rm -rf ~',
			rm,
		],
		[
			"a substitution in an unquoted here-document runs",
			"cat <<EOF\n$(rm -rf ~)\nEOF",
			rm,
		],
		[
			"a quoted delimiter is a literal body, and the line after it still runs",
			"cat <<'EOF'\n$(rm -rf ~)\nEOF\nsudo ls",
			["shell.privilege"],
		],
		[
			"a hash inside ${} is not a comment",
			"echo ${#x}; sudo ls",
			["shell.privilege"],
		],
		[
			"a hash behind a brace is not a comment",
			"echo {#}; sudo ls",
			["shell.privilege"],
		],
		[
			"an escaped space keeps the word going",
			"echo a\\ #b; sudo ls",
			["shell.privilege"],
		],
		["a line continuation joins a word", "su\\\ndo ls", ["shell.privilege"]],
		[
			"a keyword before the command",
			"if true; then sudo ls; fi",
			["shell.privilege"],
		],
		["a loop body", "for i in 1; do rm -rf /x; done", rm],
		["a descriptor before the command", "3>&1 sudo ls", ["shell.privilege"]],
		["eval", "eval 'sudo ls'", ["shell.privilege"]],
		["eval of a variable", "x=$(echo sudo ls); eval $x", ["shell.unreadable"]],
		[
			"a shell with clustered options",
			"bash -ec 'sudo ls'",
			["shell.privilege"],
		],
		["find -exec", "find . -exec sudo ls {} \\;", ["shell.privilege"]],
		[
			"a brace expansion builds the command",
			"{sudo,ls} -l",
			["shell.unreadable"],
		],
		[
			"a brace expansion in the middle of the name",
			"s{u,}do ls",
			["shell.unreadable"],
		],
		[
			"an ANSI-C escape spells the command",
			"$'\\x73udo' ls",
			["shell.privilege"],
		],
		[
			"an octal escape spells the command",
			"$'\\163udo' ls",
			["shell.privilege"],
		],
		[
			"a variable the line binds holds the command, which bash may find empty",
			"x=sudo; $x ls",
			["shell.privilege", "shell.unreadable"],
		],
		["a variable not known names the command", "$cmd ls", ["shell.unreadable"]],
		["a pattern names the command", "/usr/bin/su* ls", ["shell.unreadable"]],
		[
			"an rm operand that is a brace expansion",
			"rm -rf /etc/{a,b}",
			["shell.rm"],
		],
		[
			"a shift is not a here-document",
			"echo $((1<<2)); sudo ls",
			["shell.privilege"],
		],
	];
	for (const [name, command, expected] of cases)
		test(name, () => expect(classes(command)).toEqual(expected));

	test("lines that look like these but run nothing stay unheld", () => {
		for (const command of [
			'git commit -m "fix: $(date)"',
			'echo "$HOME"',
			'printf "%s" "$(git rev-parse HEAD)"',
			`echo "$(git log --format='%h %s' -1)"`,
			'echo "today: `date`"',
			'x="$(ls | wc -l)"',
			"git commit -m \"$(cat <<'EOF'\nit's fine\nEOF\n)\"",
			"echo x 2>&1",
			"[ -f x ] && echo yes",
			"[[ -f x ]] && echo yes",
			"echo {a,b} ${HOME}/x",
			"ls $HOME",
			"$HOME/bin/tool --version",
			"{ echo a; echo b; }",
			"echo '$(rm -rf ~)'",
			"echo $'it\\'s'",
			"echo $(( 1 << 2 ))",
			"echo ${x:-default} # sudo ls",
			"cat <<'EOF'\nsudo ls\nEOF",
			"case $1 in start) echo go;; stop|halt) echo no;; esac",
			'echo "$(case x in x) echo a;; esac)"',
			"cat <<EOF\nplain text with 'quotes' and (parens\nEOF",
		])
			expect([command, classes(command)]).toEqual([command, undefined]);
	});

	test("a line too long or too deep to read is held as unreadable", () => {
		const deep = `echo ${'"$('.repeat(20_000)}date${')"'.repeat(20_000)}`;
		expect(classes(deep)).toEqual(["shell.unreadable"]);
		expect(held(deep)).toContain("too long or too nested");
		const nested = `echo ${'"$(echo '.repeat(60)}hi${')"'.repeat(60)}`;
		expect(classes(nested)).toEqual(["shell.unreadable"]);
		expect(classes(`echo ${"a".repeat(300_000)}`)).toEqual([
			"shell.unreadable",
		]);
		expect(
			classes(`echo ${'"$(echo '.repeat(30)}hi${')"'.repeat(30)}`),
		).toBeUndefined();
	});

	test("a long line of plain commands is read in linear time", () => {
		const started = performance.now();
		expect(
			classes(
				`echo ${Array.from({ length: 5000 }, () => '"$(date)"').join(" ")}`,
			),
		).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("a heredoc body of 200k continuation characters is read in linear time", () => {
		const started = performance.now();
		classes(`cat <<EOF\n${"a\\\n".repeat(100_000)}EOF\n`);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("continuation-heavy heredoc bodies are read in linear time", () => {
		const timed = (command: string) => {
			const started = performance.now();
			const result = classes(command);
			return { result, ms: performance.now() - started };
		};
		const tabs = timed(`cat <<-EOF\n${"\t\t\\\n".repeat(50_000)}EOF\n`);
		expect(tabs.ms).toBeLessThan(50);
		const long = "D".repeat(500);
		const ab = timed(`cat <<${long}\n${"ab\\\n".repeat(10_000)}${long}\n`);
		expect(ab.ms).toBeLessThan(50);
		const message = `git commit -m "$(cat <<'EOF'\n${"line\n".repeat(5000)}EOF\n)"`;
		expect(classes(message)).toBeUndefined();
		const script = `cat <<-EOF\n${"\techo hi\n".repeat(5000)}\tEOF\n`;
		expect(classes(script)).toBeUndefined();
	});

	test("a rule that throws holds the call", () => {
		const context = { workspace: work, scratchDir: scratch };
		// An input whose command cannot be read makes the classifier fail.
		const input = {
			get command(): string {
				throw new Error("boom");
			},
		};
		expect(shellHoldRule.describe("bash", input, context)).toContain(
			"could not be checked",
		);
		expect(shellHoldRule.holdClasses?.("bash", input, context)).toEqual([
			"shell.unreadable",
		]);
	});
});

describe("YOLO_CARDED_SHELL_CLASSES", () => {
	test("is every shell class except write and push", () => {
		expect([...YOLO_CARDED_SHELL_CLASSES].map(String).sort()).toEqual(
			[
				"shell.crontab",
				"shell.disk",
				"shell.docker",
				"shell.firewall",
				"shell.force-push",
				"shell.gh",
				"shell.kill",
				"shell.packages",
				"shell.power",
				"shell.privilege",
				"shell.reset-hard",
				"shell.rm",
				"shell.service",
				"shell.unreadable",
			].sort(),
		);
		expect(YOLO_CARDED_SHELL_CLASSES).not.toContain("shell.write");
		expect(YOLO_CARDED_SHELL_CLASSES).not.toContain("shell.push");
	});
});
