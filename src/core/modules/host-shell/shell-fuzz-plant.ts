// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text, where ${...} is bash syntax
import {
	ansiQuote,
	backslashQuote,
	backtickBody,
	doubleQuote,
	type Rng,
	singleQuote,
} from "./shell-fuzz-rng.ts";

/**
 * The planted command: `sudo marker`, written in the many ways bash has of naming and running a
 * command. The test judges whether bash ran the stub, not whether the text looks like `sudo`, so a
 * form that does not run costs nothing and a form that does is a line the rule has to hold.
 */

/** Ways to spell the name `sudo` so that bash still runs the program of that name. */
const NAMES: readonly string[] = [
	"sudo",
	"sudo",
	"sudo",
	"\\sudo",
	"s\\udo",
	"'sudo'",
	'"sudo"',
	"su''do",
	's"u"do',
	'""sudo',
	"'s'u\"d\"o",
	"$'sudo'",
	"$'\\x73udo'",
	"$'\\163udo'",
	"$'\\u0073udo'",
	"$'s\\165do'",
	"$'sudo\\0x'",
	"$'sudo\\x00x'",
	"$'sudo\\000x'",
	"$'\\U00000073udo'",
	'$"sudo"',
	"su\\\ndo",
	"{sudo,}",
	"{sudo,ls}",
	"s{u,}do",
	"{s,s}udo",
	"${V:-sudo}",
	"${V:-s}udo",
	"s${V}udo",
	"s${V-}udo",
	"su$@do",
	"${PATH:+sudo}",
	"${0:+sudo}",
	"${x:=sudo}",
	"$(echo sudo)",
	"`echo sudo`",
	'"$(printf sudo)"',
	"$(echo s)udo",
	"`echo su`do",
	"$(echo ${V:-sudo})",
	"s`:`udo",
	"s$(:)udo",
	"$(:)sudo",
	"/usr/bin/../../../sudo",
	"./../sudo",
];

/** Builds the planted command and the lines that run something through arithmetic or a prompt. */
export class Planter {
	constructor(readonly rng: Rng) {}

	/** The program name, spelled one way. */
	name(): string {
		return this.rng.pick(NAMES);
	}

	/** `sudo marker`, spelled one way, with arguments that mean nothing to the stub. */
	command(): string {
		const args = this.rng.pick([
			"marker",
			"marker",
			"-n marker",
			"marker a b",
			"",
			"-- marker",
			"marker > /dev/null",
		]);
		return `${this.name()}${args === "" ? "" : " "}${args}`;
	}

	/** A script as an argument: the script, quoted in a way that keeps it a script. */
	quoted(script: string): string {
		return this.rng.weighted<string>([
			[4, singleQuote(script)],
			[3, doubleQuote(script)],
			[2, ansiQuote(script)],
			[1, backslashQuote(script)],
		]);
	}

	/** `command` run through a wrapper, or inside a construct, once. */
	wrap(command: string): string {
		const run = (word: string) => `${word} ${command}`;
		const choices: ReadonlyArray<readonly [number, () => string]> = [
			[2, () => run("command")],
			[1, () => run("command -p")],
			[1, () => run("command --")],
			[3, () => run("env")],
			[1, () => run("env -i")],
			[1, () => run("env -u FOO")],
			[1, () => run("env FOO=1")],
			[2, () => run("exec")],
			[1, () => run("exec -a name")],
			[1, () => `exec 3>&1 ${command}`],
			[2, () => run("time")],
			[1, () => run("time -p")],
			[1, () => run("time --")],
			[2, () => run("!")],
			[1, () => run("nice")],
			[1, () => run("nice -n 5")],
			[1, () => run("ionice -c3")],
			[1, () => run("timeout 5")],
			[1, () => run("timeout -s KILL 5")],
			[1, () => run("nohup")],
			[1, () => run("stdbuf -oL")],
			[1, () => run("setsid")],
			[1, () => run("xargs")],
			[1, () => run("xargs -n1")],
			[1, () => run("builtin")],
			[2, () => `FOO=bar ${command}`],
			[1, () => `FOO=$(true) ${command}`],
			[1, () => `FOO=a BAR=b ${command}`],
			[1, () => `${command} >/dev/null`],
			[1, () => `${command} 2>&1`],
			[1, () => `>/dev/null ${command}`],
			[1, () => `3>&1 ${command}`],
			[1, () => `</dev/null ${command}`],
			[1, () => `>| /dev/null ${command}`],
			[1, () => `${command} <>/dev/null`],
			[1, () => `${command} &>/dev/null`],
			[1, () => `${command} <<< word`],
			[2, () => `eval ${this.quoted(command)}`],
			[1, () => `eval ${this.quoted(`echo hi; ${command}`)}`],
			[
				1,
				() => `eval "echo $a\\b ; x=$(echo $# ${command.replaceAll('"', "")})"`,
			],
			[2, () => `bash -c ${this.quoted(command)}`],
			[1, () => `sh -c ${this.quoted(command)}`],
			[1, () => `bash -ec ${this.quoted(command)}`],
			[1, () => `bash -o pipefail -c ${this.quoted(command)}`],
			[1, () => `bash --norc -c ${this.quoted(command)}`],
			[1, () => `bash -c "echo $(echo ${command})"`],
			[1, () => `find . -exec ${command} \\;`],
			[1, () => `find . -exec ${command} {} +`],
			[1, () => `(${command})`],
			[1, () => `( ${command} )`],
			[2, () => `{ ${command}; }`],
			[1, () => `{ echo a; ${command}; }`],
			[2, () => `$(${command})`],
			[1, () => `echo "$(${command})"`],
			[1, () => `echo \`${backtickBody(command)}\``],
			[1, () => `echo "\`${backtickBody(command).replaceAll('"', '\\"')}\`"`],
			[1, () => `x=$(${command})`],
			[1, () => `echo \${x:-$(${command})}`],
			[1, () => `echo "\${x:-"$(${command})"}"`],
			[1, () => `: \${x:=$(${command})}`],
			[1, () => `cat <(${command})`],
			[1, () => `echo hi > >(${command}); wait`],
			[1, () => `${command} & wait`],
			[
				2,
				() =>
					`echo ${this.quoted(command)} | ${this.rng.pick(["bash", "sh", "bash -s", "env bash", "command sh", "exec bash"])}`,
			],
			[1, () => `printf '%s\\n' ${this.quoted(command)} | bash -s --`],
			[
				2,
				() =>
					`${this.rng.pick(["bash", "sh", "bash -s", "env sh"])} <<< ${this.quoted(command)}`,
			],
			[
				1,
				() =>
					`${this.rng.pick(["bash", "sh"])} <<${this.rng.pick(["EOF", "'EOF'", '"EOF"', "\\EOF"])}\n${command}\nEOF`,
			],
			[1, () => `bash < <(echo ${this.quoted(command)})`],
			[
				1,
				() =>
					`${this.rng.pick(["source", "."])} <(echo ${this.quoted(command)})`,
			],
			[
				1,
				() =>
					`${this.rng.pick(["source", "."])} /dev/stdin <<< ${this.quoted(command)}`,
			],
			[
				1,
				() =>
					`echo ${this.quoted(command)} > f; ${this.rng.pick(["bash f", "sh ./f", ". f", "source ./f"])}`,
			],
			[1, () => `echo ${this.quoted(command)} | tee f; bash f`],
			[1, () => `echo ${this.quoted(command)} | xargs -I{} sh -c {}`],
			[1, () => `echo ${this.quoted(command)} | xargs -I % bash -c %`],
			[1, () => `trap ${singleQuote(command)} EXIT`],
			[1, () => `trap -- ${singleQuote(command)} EXIT`],
			[1, () => `trap ${singleQuote(command)} ERR; false`],
			[1, () => `trap ${doubleQuote(command)} DEBUG; true`],
			[1, () => `coproc ${command}; wait`],
			[1, () => `coproc NAME { ${command}; }; wait`],
			[1, () => `f() { ${command}; }; f`],
			[1, () => `function f { ${command}; }; f`],
			[1, () => `f() ( ${command} ); f`],
			[1, () => `if true; then ${command}; fi`],
			[1, () => `for i in 1; do ${command}; done`],
			[1, () => `while true; do ${command}; break; done`],
			[1, () => `case a in a) ${command};; esac`],
			[1, () => `case a in (a) (${command}) ;; esac`],
			[1, () => `[[ a == a ]] && ${command}`],
			[1, () => `false || ${command}`],
			[1, () => `echo hi | ${command}`],
			[1, () => `echo a | xargs ${command}`],
			[1, () => `echo $(( 1 + $(${command}) ))`],
			[1, () => `(( $(${command}) ))`],
			[1, () => `echo $[1 + $(${command})]`],
			[1, () => `cat <<< $(${command})`],
			[1, () => `cat <<EOF\n$(${command})\nEOF`],
			[1, () => `cat <<EOF\n\`${backtickBody(command)}\`\nEOF`],
			[1, () => `shopt -s expand_aliases\nalias s=${singleQuote(command)}\ns`],
			[1, () => `shopt -s expand_aliases; alias s=sudo\ns marker`],
			[
				1,
				() =>
					`shopt -s expand_aliases\nalias echo=${singleQuote(`${command};`)}\necho hi`,
			],
		];
		return this.rng.weighted(choices)();
	}

	/** One planted command with up to two wrappers around it. */
	plant(): string {
		let text = this.command();
		for (
			let layers = this.rng.weighted<number>([
				[5, 0],
				[4, 1],
				[2, 2],
			]);
			layers > 0;
			layers--
		)
			text = this.wrap(text);
		return text;
	}

	/** Statements that run `sudo` only through arithmetic, a prompt or an environment variable. */
	hidden(): string {
		return this.rng.pick([
			"x='a[$(sudo marker)]'; echo $((x))",
			"x='a[$(sudo marker)]'; (( x ))",
			"x='a[$(sudo marker)]'; [[ $x -eq 1 ]]",
			"x='a[$(sudo marker)]'; let x",
			"x='a[$(sudo marker)]'; declare -i y; y=$x",
			"x='$(sudo marker)'; echo ${x@P}",
			"PS4='$(sudo marker) ' bash -xc true",
			"PROMPT_COMMAND='sudo marker'; true",
			"export PROMPT_COMMAND='sudo marker'",
			"BASH_ENV=/dev/null bash -c 'sudo marker'",
			"echo $(( a[$(sudo marker)] ))",
			"(( a[`sudo marker`] ))",
			"for ((i=a[$(sudo marker)]; i<1; i++)); do :; done",
			"printf -v 'a[$(sudo marker)]' %s x",
			"declare 'a[$(sudo marker)]=1'",
			"echo ${arr[$(sudo marker)]}",
			"echo ${x:$(sudo marker):1}",
			"echo $((${x:-$(sudo marker)} + 1))",
			"arr[$(sudo marker)]=1",
			"arr=([$(sudo marker)]=1)",
			"echo $(( x ? $(sudo marker) : 1 ))",
			"set -x; PS4='`sudo marker`'; true",
			"PS4='$(sudo marker)'; set -x; true",
			"x=ls; for x in sudo; do $x marker; done",
			"x=; : ${x:=sudo}; $x marker",
			"x=ls; read x <<< sudo; $x marker",
			"x=ls; printf -v x sudo; $x marker",
			"x=ls; declare x=sudo; $x marker",
			"x=ls; eval x=sudo; $x marker",
			"x=sudo; f() { x=ls; }; $x marker; f",
			"x=sudo; [ a = b ] && x=ls; $x marker",
			"x=ls; select x in sudo; do $x marker; break; done <<< 1",
			"x=ls; x+=; x=sudo; $x marker",
			"x=s; x+=udo; $x marker",
			"c=ls; if true; then c=sudo; fi; $c marker",
			"declare 'a[$(sudo marker)]=1'",
			"read 'a[$(sudo marker)]' <<< 1",
			"false && V=1; s${V}udo marker",
			"[ a = b ] && x=ls; $x sudo marker",
			"(V=1); s${V}udo marker",
			"V=1 & s${V}udo marker",
			"case a in b) V=1;; esac; s${V}udo marker",
			"echo x | { V=1; }; s${V}udo marker",
			"f() { V=1; }; s${V}udo marker",
			"mapfile -C 'sudo marker' -c 1 a <<< x",
			"readarray -t -C 'sudo marker' -c 1 a <<< x",
			"echo sudo | xargs -I{} {} marker",
			"echo sudo | xargs -I % % marker",
			"echo sudo marker | xargs env",
			"echo sudo marker | xargs nice",
		]);
	}
}
