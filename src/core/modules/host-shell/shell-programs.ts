import { assistantName } from "../../i18n/index.ts";
import { ownPush, type PushPolicy } from "./git-push.ts";
import { type LineState, writable } from "./shell-paths.ts";

/**
 * The hold classes of the shell rule, as `shell.<class>` ids that `HoldRule.holdClasses` lists for
 * every command a call holds. Yolo mode approves `shell.write` (a write outside the scratch roots)
 * and `shell.push` (a plain `git push` the push policy holds), and cards the rest unless
 * `autonomy.yolo.allow` lists them.
 */
export const SHELL_CLASSES = Object.freeze([
	"shell.privilege",
	"shell.disk",
	"shell.power",
	"shell.kill",
	"shell.rm",
	"shell.write",
	"shell.service",
	"shell.docker",
	"shell.firewall",
	"shell.packages",
	"shell.push",
	"shell.force-push",
	"shell.reset-hard",
	"shell.gh",
	"shell.crontab",
] as const);

export type ShellClass = (typeof SHELL_CLASSES)[number];

/**
 * The shell classes yolo mode never approves unless `autonomy.yolo.allow` lists them: all of them
 * but `shell.write` and `shell.push`, the non-destructive ones. A plain push to `main` deploys, so
 * list `shell.push` in `autonomy.yolo.card` to keep it behind a card.
 */
export const YOLO_CARDED_SHELL_CLASSES: readonly string[] = Object.freeze(
	SHELL_CLASSES.filter((id) => id !== "shell.write" && id !== "shell.push"),
);

/** Why a command is held, and the class of that reason. */
export interface Held {
	reason: string;
	class: ShellClass;
}

const SYSTEMD_VERBS = new Set([
	"start",
	"stop",
	"restart",
	"reload",
	"try-restart",
	"reload-or-restart",
	"enable",
	"disable",
	"mask",
	"unmask",
	"kill",
	"isolate",
]);
const DOCKER_VERBS = new Set(["stop", "kill", "restart", "rm", "rmi", "prune"]);
const DOCKER_OBJECTS = new Set([
	"container",
	"image",
	"volume",
	"network",
	"system",
	"builder",
]);
const COMPOSE_VERBS = new Set(["down", "stop", "kill", "restart", "rm"]);
const PACKAGE_VERBS = new Set([
	"install",
	"reinstall",
	"remove",
	"purge",
	"autoremove",
	"upgrade",
	"full-upgrade",
	"dist-upgrade",
]);

/** Whether a push argument forces, deletes or mirrors refs rather than adding commits to them. */
function rewritesRemote(arg: string): boolean {
	return (
		arg === "--mirror" ||
		arg === "--delete" ||
		arg === "-d" ||
		arg.startsWith("+") ||
		arg.startsWith(":")
	);
}

/** Why a program that is held only with some arguments is, when it is; each has a single reason. */
export function verbHeld(
	name: string,
	args: string[],
	prefix: string[],
	state: LineState,
	policy: PushPolicy,
): Held | undefined {
	const verbs = args.filter((a) => !a.startsWith("-"));
	const because = (
		held: boolean,
		reason: string,
		heldClass: ShellClass,
	): Held | undefined => (held ? { reason, class: heldClass } : undefined);
	switch (name) {
		case "systemctl":
			return because(
				verbs.some((v) => SYSTEMD_VERBS.has(v)),
				"changes a systemd unit",
				"shell.service",
			);
		case "service":
			return because(
				verbs.some((v) => ["start", "stop", "restart", "reload"].includes(v)),
				"changes a service",
				"shell.service",
			);
		case "docker": {
			const [first, second] = verbs;
			if (first === "compose")
				return because(
					second !== undefined && COMPOSE_VERBS.has(second),
					`docker compose ${second}`,
					"shell.docker",
				);
			if (first && DOCKER_VERBS.has(first))
				return { reason: `docker ${first}`, class: "shell.docker" };
			return because(
				first !== undefined &&
					DOCKER_OBJECTS.has(first) &&
					second !== undefined &&
					(DOCKER_VERBS.has(second) || second === "remove"),
				`docker ${first} ${second}`,
				"shell.docker",
			);
		}
		case "docker-compose":
			return because(
				verbs[0] !== undefined && COMPOSE_VERBS.has(verbs[0]),
				`docker-compose ${verbs[0]}`,
				"shell.docker",
			);
		case "ufw":
			return because(
				!(verbs[0] === "status" || verbs.length === 0),
				"changes the firewall",
				"shell.firewall",
			);
		case "iptables":
		case "ip6tables":
		case "nft":
			return because(
				!args.some((a) => ["-L", "--list", "-S", "list"].includes(a)),
				"changes the firewall",
				"shell.firewall",
			);
		case "apt":
		case "apt-get":
		case "snap":
			return because(
				verbs.some((v) => PACKAGE_VERBS.has(v)),
				"installs or removes packages",
				"shell.packages",
			);
		case "dpkg":
			return because(
				args.some((a) =>
					["-i", "-r", "-P", "--install", "--remove", "--purge"].includes(a),
				),
				"installs or removes packages",
				"shell.packages",
			);
		case "git":
			return gitHeld(args, prefix, state, policy);
		case "gh": {
			const reason = ghHeld(args);
			return reason ? { reason, class: "shell.gh" } : undefined;
		}
		case "crontab":
			return because(args.includes("-r"), "removes a crontab", "shell.crontab");
		case "tee": {
			const target = args.find(
				(a) => !a.startsWith("-") && !writable(a, state),
			);
			return target
				? { reason: `writes to ${target}`, class: "shell.write" }
				: undefined;
		}
		default:
			return undefined;
	}
}

/** Why a `git` command is held: a push the policy does not let run, or a hard reset. */
function gitHeld(
	args: string[],
	prefix: string[],
	state: LineState,
	policy: PushPolicy,
): Held | undefined {
	const [globals, [verb, ...rest]] = gitCommand(args);
	if (verb === "push") {
		const plain = !prefix.some((w) => w.startsWith("GIT_"));
		if (plain && ownPush(globals, rest, state, policy)) return undefined;
		if (
			rest.some(
				(a) => /^-[A-Za-z]*f[A-Za-z]*$/.test(a) || a.startsWith("--force"),
			)
		)
			return { reason: "force-pushes", class: "shell.force-push" };
		if (rest.some(rewritesRemote))
			return {
				reason: "rewrites or deletes remote refs",
				class: "shell.force-push",
			};
		return {
			reason: `pushes to GitHub, which deploys ${assistantName()} when the branch is main`,
			class: "shell.push",
		};
	}
	if (verb === "reset" && rest.includes("--hard"))
		return { reason: "git reset --hard", class: "shell.reset-hard" };
	return undefined;
}

/** Git's global options that take a value, as separate words. */
const GIT_VALUE_OPTIONS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
]);

/** Git's global options, such as `-C <dir>`, and the subcommand with its arguments. */
function gitCommand(args: string[]): [string[], string[]] {
	let i = 0;
	while (i < args.length && (args[i] as string).startsWith("-"))
		i += GIT_VALUE_OPTIONS.has(args[i] as string) ? 2 : 1;
	return [args.slice(0, i), args.slice(i)];
}

const GH_BODY_FLAGS = ["-f", "-F", "--field", "--raw-field", "--input"];
const GH_READ_VERBS = new Set(["list", "view", "download"]);
const GH_REPO_CHANGES = new Set([
	"create",
	"delete",
	"edit",
	"rename",
	"archive",
	"unarchive",
]);

/** Why a `gh` command writes to GitHub in a way the owner approves, or undefined. */
function ghHeld(args: string[]): string | undefined {
	const [group, verb] = args.filter((a) => !a.startsWith("-"));
	switch (group) {
		case "pr":
			return verb === "merge" ? "merges a pull request" : undefined;
		case "api": {
			const body = args.some((a) =>
				GH_BODY_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)),
			);
			if (verb === "graphql")
				return args.some((a) => /\bmutation\b/.test(a))
					? "changes GitHub through the API"
					: undefined;
			const index = args.findIndex((a) => a === "-X" || a === "--method");
			const method = (
				index === -1
					? args.find((a) => a.startsWith("--method="))?.slice(9)
					: args[index + 1]
			)?.toUpperCase();
			return body || (method !== undefined && method !== "GET")
				? "changes GitHub through the API"
				: undefined;
		}
		case "release":
		case "secret":
		case "variable":
			return verb && !GH_READ_VERBS.has(verb)
				? `changes GitHub ${group}s`
				: undefined;
		case "repo":
			return verb && GH_REPO_CHANGES.has(verb)
				? `changes a GitHub repository (${verb})`
				: undefined;
		default:
			return undefined;
	}
}
