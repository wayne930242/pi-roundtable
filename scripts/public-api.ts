import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";

export const PUBLIC_ENTRIES = {
	main: "src/index.ts",
	testing: "src/testing.ts",
	kit: "src/kit/index.ts",
	discord: "src/discord/index.ts",
} as const;

/** The packages whose types only the Discord entry may name. */
const DISCORD_PACKAGES = /^(discord\.js|discord-api-types)(\/|$)/;
interface Binding {
	file: string;
	name: string;
}
interface Module {
	declarations: Map<string, string>;
	imports: Map<string, Binding>;
	exports: Map<string, Binding>;
	/** Names imported from a discord package, by local name. */
	discord: Map<string, string>;
}
export interface Leak {
	id: string;
	references: string[];
}
export interface ApiReport {
	entries: Record<string, Record<string, string>>;
	declarations: Record<string, string>;
	leaks: Leak[];
	/**
	 * The discord.js types each entry reaches through its public declarations, as
	 * `<declaration> uses <package>:<name>`; only the Discord entry may have any.
	 */
	discordTypes: Record<string, string[]>;
}

/** Parse exports, not text resembling exports in comments. */
export function entryNames(source: string): {
	values: string[];
	types: string[];
} {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
		allowUndeclaredExports: true,
	});
	const values: string[] = [],
		types: string[] = [];
	for (const node of ast.program.body) {
		if (
			node.type === "ExportAllDeclaration" ||
			node.type === "ExportDefaultDeclaration"
		)
			throw new Error("Entries must use explicit named exports");
		if (node.type !== "ExportNamedDeclaration") continue;
		for (const spec of node.specifiers) {
			if (spec.type !== "ExportSpecifier")
				throw new Error("Unsupported entry export");
			const name =
				spec.exported.type === "Identifier"
					? spec.exported.name
					: spec.exported.value;
			(node.exportKind === "type" || spec.exportKind === "type"
				? types
				: values
			).push(name);
		}
		const declaration = node.declaration;
		if (!declaration) continue;
		if (declaration.type === "VariableDeclaration") {
			for (const item of declaration.declarations) {
				if (item.id.type !== "Identifier")
					throw new Error("Entry exports cannot destructure");
				values.push(item.id.name);
			}
		} else if ("id" in declaration && declaration.id?.type === "Identifier") {
			(declaration.type === "TSInterfaceDeclaration" ||
			declaration.type === "TSTypeAliasDeclaration"
				? types
				: values
			).push(declaration.id.name);
		}
	}
	return { values: values.sort(), types: types.sort() };
}

/** Emit the actual consumer declarations once, then collect their reachable signatures. */
export function publicApi(root: string): ApiReport {
	const out = mkdtempSync(join(tmpdir(), "roundtable-api-"));
	try {
		const config = join(out, "tsconfig.json");
		writeFileSync(
			config,
			JSON.stringify({
				extends: join(root, "tsconfig.json"),
				compilerOptions: {
					noEmit: false,
					declaration: true,
					emitDeclarationOnly: true,
					rootDir: root,
					typeRoots: [join(root, "node_modules/@types")],
					outDir: join(out, "dts"),
				},
				include: Object.values(PUBLIC_ENTRIES).map((entry) =>
					join(root, entry),
				),
				exclude: [],
			}),
		);
		const run = Bun.spawnSync(
			[join(root, "node_modules/.bin/tsc"), "-p", config],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		if (run.exitCode !== 0)
			throw new Error(
				`Declaration emit failed:\n${run.stdout.toString()}${run.stderr.toString()}`,
			);
		return inspectDeclarations(join(out, "dts"));
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

export function inspectDeclarations(root: string): ApiReport {
	const cache = new Map<string, Module>();
	function target(file: string, specifier: string): string | undefined {
		if (!specifier.startsWith(".")) return undefined;
		const path = resolve(dirname(file), specifier).replace(/\.ts$/, ".d.ts");
		return existsSync(path) ? path : undefined;
	}
	function load(file: string): Module {
		const cached = cache.get(file);
		if (cached) return cached;
		const source = readFileSync(file, "utf8");
		const ast = parse(source, {
			sourceType: "module",
			plugins: ["typescript"],
		});
		const module: Module = {
			declarations: new Map(),
			imports: new Map(),
			exports: new Map(),
			discord: new Map(),
		};
		cache.set(file, module);
		for (const node of ast.program.body) {
			if (
				node.type === "ImportDeclaration" ||
				(node.type === "ExportNamedDeclaration" && node.source)
			) {
				const specifier = node.source?.value;
				if (specifier && DISCORD_PACKAGES.test(specifier))
					for (const spec of node.specifiers)
						if (spec.type === "ImportSpecifier")
							module.discord.set(spec.local.name, specifier);
				const from = specifier ? target(file, specifier) : undefined;
				if (!from) continue;
				for (const spec of node.specifiers) {
					if (
						spec.type === "ImportSpecifier" &&
						spec.imported.type === "Identifier"
					)
						module.imports.set(spec.local.name, {
							file: from,
							name: spec.imported.name,
						});
					else if (
						spec.type === "ExportSpecifier" &&
						spec.local.type === "Identifier" &&
						spec.exported.type === "Identifier"
					)
						module.exports.set(spec.exported.name, {
							file: from,
							name: spec.local.name,
						});
				}
			}
			const declaration =
				node.type === "ExportNamedDeclaration" ? node.declaration : node;
			if (!declaration) continue;
			const names =
				declaration.type === "VariableDeclaration"
					? declaration.declarations.flatMap((item) =>
							item.id.type === "Identifier" ? [item.id.name] : [],
						)
					: "id" in declaration && declaration.id?.type === "Identifier"
						? [declaration.id.name]
						: [];
			for (const name of names) {
				const text = source
					.slice(declaration.start ?? 0, declaration.end ?? 0)
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.trim();
				module.declarations.set(
					name,
					[module.declarations.get(name), text].filter(Boolean).join("\n"),
				);
				if (node.type === "ExportNamedDeclaration")
					module.exports.set(name, { file, name });
			}
		}
		return module;
	}
	function origin(
		binding: Binding,
		seen = new Set<string>(),
	): Binding | undefined {
		const id = `${binding.file}#${binding.name}`;
		if (seen.has(id)) return undefined;
		seen.add(id);
		const module = load(binding.file);
		if (module.declarations.has(binding.name)) return binding;
		const next =
			module.exports.get(binding.name) ?? module.imports.get(binding.name);
		return next ? origin(next, seen) : undefined;
	}
	const key = (binding: Binding) =>
		`${relative(root, binding.file)}#${binding.name}`;
	const publicIds = new Set<string>();
	const entries: ApiReport["entries"] = {};
	const roots: { label: string; binding: Binding }[] = [];
	for (const [entry, path] of Object.entries(PUBLIC_ENTRIES)) {
		const file = join(root, path.replace(/\.ts$/, ".d.ts"));
		entries[entry] = {};
		for (const name of [...load(file).exports.keys()].sort()) {
			const binding = origin({ file, name });
			if (!binding) continue; // External dependency types are not package-private types.
			publicIds.add(key(binding));
			entries[entry][name] = key(binding);
			roots.push({ label: `${entry}:${name}`, binding });
		}
	}
	/** What a declaration refers to: the package's own declarations, and the discord types it names. */
	function references(binding: Binding): {
		next: Binding[];
		discord: string[];
	} {
		const module = load(binding.file);
		const text = module.declarations.get(binding.name) ?? "";
		const ast = parse(text, { sourceType: "module", plugins: ["typescript"] });
		const names = new Set<string>();
		const parameters = new Set<string>();
		const discord = new Set<string>();
		function visit(value: unknown): void {
			if (!value || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const child of value) visit(child);
				return;
			}
			const node = value as Record<string, unknown>;
			if (node.type === "TSAnyKeyword")
				throw new Error(`Public declaration contains any: ${key(binding)}`);
			if (node.type === "TSTypeParameter" && typeof node.name === "string")
				parameters.add(node.name);
			// A declaration file writes a type it did not import as import("pkg").Name.
			if (node.type === "TSImportType") {
				const from = (node.argument as { value?: string } | undefined)?.value;
				if (from && DISCORD_PACKAGES.test(from)) {
					const qualifier = node.qualifier as { name?: string } | undefined;
					discord.add(`${from}:${qualifier?.name ?? "*"}`);
				}
			}
			if (
				[
					"TSTypeReference",
					"TSExpressionWithTypeArguments",
					"TSTypeQuery",
				].includes(String(node.type))
			) {
				const id = (node.typeName ?? node.expression ?? node.exprName) as
					| { type?: string; name?: string }
					| undefined;
				if (id?.type === "Identifier" && id.name) names.add(id.name);
			}
			for (const child of Object.values(node)) visit(child);
		}
		visit(ast.program);
		for (const name of names) {
			const from = module.discord.get(name);
			if (from) discord.add(`${from}:${name}`);
		}
		const next = [...names]
			.filter((name) => !parameters.has(name) && name !== binding.name)
			.flatMap((name) => {
				const found = origin({ file: binding.file, name });
				return found ? [found] : [];
			});
		return { next, discord: [...discord] };
	}
	const declarations: Record<string, string> = {};
	const leaks = new Map<string, Set<string>>();
	const discordTypes: Record<string, Set<string>> = Object.fromEntries(
		Object.keys(PUBLIC_ENTRIES).map((entry) => [entry, new Set<string>()]),
	);
	for (const { label, binding } of roots) {
		const entry = label.slice(0, label.indexOf(":"));
		const visited = new Set<string>();
		function walk(current: Binding): void {
			const id = key(current);
			if (visited.has(id)) return;
			visited.add(id);
			declarations[id] =
				load(current.file).declarations.get(current.name) ?? "";
			const found = references(current);
			for (const used of found.discord)
				discordTypes[entry]?.add(`${id} uses ${used}`);
			for (const next of found.next) {
				const nextId = key(next);
				if (!publicIds.has(nextId)) {
					const labels = leaks.get(nextId) ?? new Set<string>();
					labels.add(`${label} via ${id}`);
					leaks.set(nextId, labels);
				}
				walk(next);
			}
		}
		walk(binding);
	}
	return {
		entries,
		declarations: Object.fromEntries(
			Object.entries(declarations).sort(([a], [b]) => a.localeCompare(b)),
		),
		leaks: [...leaks]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([id, labels]) => ({ id, references: [...labels].sort() })),
		discordTypes: Object.fromEntries(
			Object.entries(discordTypes).map(([entry, used]) => [
				entry,
				[...used].sort(),
			]),
		),
	};
}

if (import.meta.main) {
	const root = resolve(process.argv[2] ?? ".");
	const report = publicApi(root);
	console.log(JSON.stringify(report, null, "\t"));
}
