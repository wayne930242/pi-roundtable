// Running one action over every chosen row: each row goes through the route that exists for a single
// one, one after another, with the progress shown; a refusal does not stop the rest, and the end says
// which rows were not done and why. No server state is half-made, because each row is its own request.

import { useCallback, useRef, useState } from "react";
import { messageOf } from "./api.ts";
import { plural, translate as t } from "./messages.ts";
import { toast } from "./toast.ts";

/** A row the server did not do, with its words. */
export interface Refused {
	name: string;
	reason: string;
}

/** What a run did: the rows done, and those refused. */
export interface Ran<T> {
	done: T[];
	refused: Refused[];
}

/** Runs `run` on each item in turn; `progress` hears how many are finished after each. */
export async function runEach<T>(
	items: readonly T[],
	nameOf: (item: T) => string,
	run: (item: T) => Promise<unknown>,
	progress: (finished: number) => void = () => undefined,
): Promise<Ran<T>> {
	const done: T[] = [];
	const refused: Refused[] = [];
	progress(0);
	for (const item of items) {
		try {
			await run(item);
			done.push(item);
		} catch (failure) {
			refused.push({ name: nameOf(item), reason: messageOf(failure) });
		}
		progress(done.length + refused.length);
	}
	return { done, refused };
}

/** What the bar shows while a run goes on. */
export interface Running {
	label: string;
	finished: number;
	total: number;
}

/** What the bar says when a run is over and some rows were refused. */
export interface Outcome {
	summary: string;
	refused: Refused[];
}

/** How a batch is worded and undone. */
export interface Batch<T> {
	/** The bar's words while it runs: "Deleting". */
	label: string;
	items: readonly T[];
	nameOf(item: T): string;
	run(item: T): Promise<unknown>;
	/** The notice's words for `count` rows done. */
	said(count: number): string;
	/** Puts the rows done back; absent for what cannot be undone. */
	undo?(done: T[]): Promise<unknown>;
	/** Reads the page's lists again; runs after the batch and after an undo. */
	after(): unknown;
}

/** Runs batches for a page and holds what the bar shows of the one running or just over. */
export function useBatch(onOver: () => void) {
	const [running, setRunning] = useState<Running>();
	const [outcome, setOutcome] = useState<Outcome>();
	const busy = useRef(false);
	const start = useCallback(
		async <T>(batch: Batch<T>) => {
			if (busy.current) return;
			busy.current = true;
			setOutcome(undefined);
			const total = batch.items.length;
			setRunning({ label: batch.label, finished: 0, total });
			const ran = await runEach(
				batch.items,
				batch.nameOf,
				batch.run,
				(finished) => setRunning({ label: batch.label, finished, total }),
			);
			try {
				await batch.after();
			} catch {
				// The list is read again with the next change; the notice below still tells what was done.
			}
			busy.current = false;
			setRunning(undefined);
			onOver();
			const { undo } = batch;
			if (ran.done.length > 0)
				toast(
					batch.said(ran.done.length),
					"info",
					undo
						? {
								label: t("Undo"),
								run: () =>
									void undo(ran.done).then(
										() => batch.after(),
										(failure) => toast(messageOf(failure), "danger"),
									),
							}
						: undefined,
				);
			if (ran.refused.length > 0)
				setOutcome({
					summary: plural(
						ran.refused.length,
						"{count} was not done:",
						"{count} were not done:",
					),
					refused: ran.refused,
				});
		},
		[onOver],
	);
	return { running, outcome, start, dismiss: () => setOutcome(undefined) };
}
