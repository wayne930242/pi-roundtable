import { useEffect, useState } from "react";
import { useSelector } from "./app-store.ts";
import { teamApi } from "./team-api.ts";

/**
 * How many archived knights and groups there are, read again whenever the room list changes (an
 * archive or a restore does that); undefined until the first answer, and after a failed one.
 */
export function useArchivedCount(): number | undefined {
	const revision = useSelector((state) => state.revision);
	const [count, setCount] = useState<number>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change of the room list is the trigger
	useEffect(() => {
		let current = true;
		teamApi.archive().then(
			(view) => {
				if (current) setCount(view.entries.length);
			},
			() => {
				if (current) setCount(undefined);
			},
		);
		return () => {
			current = false;
		};
	}, [revision]);
	return count;
}
