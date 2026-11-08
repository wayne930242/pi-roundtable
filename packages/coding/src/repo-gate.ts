import { AgentError } from "pi-roundtable/kit";
import type { Integration, RepoShelf, WorkerTree } from "./repo-shelf.ts";

/**
 * Orders the changes to one clone: integrations of its worker branches run one after another, and
 * never during its report or push.
 */
export class RepoGate {
	readonly #shelf: Pick<RepoShelf, "integrate">;
	/** The last integration asked for in each repository, which the next waits for. */
	readonly #integrations = new Map<string, Promise<unknown>>();
	/** Repositories whose clone an integration is changing now. */
	readonly #integrating = new Set<string>();
	/** Reports and pushes in progress, by repository. */
	readonly #shipping = new Map<string, Promise<unknown>>();
	constructor(shelf: Pick<RepoShelf, "integrate">) {
		this.#shelf = shelf;
	}
	/** Refuses while a worker's branch is being merged into the clone; running workers do not count. */
	checkIdle(repo: string): void {
		if (this.#integrating.has(repo))
			throw new AgentError(
				`A coding worker's commits are being merged into ${repo}; try again in a moment.`,
			);
	}
	/** Whether a report or push is in progress for the repository. */
	shipping(repo: string): boolean {
		return this.#shipping.has(repo);
	}
	/**
	 * Runs a report or push of the repository, one at a time; refuses during an integration, and
	 * an integration that comes due waits for it.
	 */
	async ship<T>(repo: string, operation: () => Promise<T>): Promise<T> {
		this.checkIdle(repo);
		if (this.#shipping.has(repo))
			throw new AgentError(
				"A report or push is already in progress for this repository.",
			);
		const done = operation();
		this.#shipping.set(
			repo,
			done.catch(() => {}),
		);
		try {
			return await done;
		} finally {
			this.#shipping.delete(repo);
		}
	}
	/** Integrations of one clone run one after another, and never during its report or push. */
	async integrate(tree: WorkerTree): Promise<Integration> {
		const { repo } = tree;
		const previous = this.#integrations.get(repo) ?? Promise.resolve();
		const mine = previous
			.catch(() => {})
			.then(async () => {
				for (let ship = this.#shipping.get(repo); ship; ) {
					await ship;
					ship = this.#shipping.get(repo);
				}
				this.#integrating.add(repo);
				try {
					return await this.#shelf.integrate(tree);
				} finally {
					this.#integrating.delete(repo);
				}
			});
		this.#integrations.set(repo, mine);
		try {
			return await mine;
		} finally {
			if (this.#integrations.get(repo) === mine)
				this.#integrations.delete(repo);
		}
	}
}
