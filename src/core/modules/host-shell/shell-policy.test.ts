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
			["echo", "hi", ">", "/etc/x", "2", "dup", "1"],
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
