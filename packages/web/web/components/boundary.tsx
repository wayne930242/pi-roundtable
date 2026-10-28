import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkError, reloadForChunk } from "../lib/chunk-error.ts";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

/** What stands where a part of the page failed: the reason in plain words and a way out. */
export function CrashCard(props: { error: unknown; onReload(): void }) {
	const chunk = isChunkError(props.error);
	return (
		<div className="page">
			<div className="crash" role="alert">
				<span className="crash-icon">
					<Icon name="shield" size={22} />
				</span>
				<h2>{t("Something went wrong")}</h2>
				<p>
					{chunk
						? t(
								"The app was updated while this page was open, so part of it could not load.",
							)
						: t("This page stopped working. Reloading usually fixes it.")}
				</p>
				<button type="button" onClick={props.onReload}>
					{t("Reload")}
				</button>
			</div>
		</div>
	);
}

interface State {
	error?: { value: unknown } | undefined;
	/** The `resetKey` the state was made for. */
	key?: string | undefined;
}

/**
 * Catches what a part of the page throws, so a failure shows a card with Reload instead of a
 * blank page. A chunk that failed to load, which is what a release does to a page opened before
 * it, reloads the page once by itself.
 */
export class ErrorBoundary extends Component<
	{
		children: ReactNode;
		/** A change of this clears a shown failure: the route the boundary stands for is another one. */
		resetKey?: string;
	},
	State
> {
	override state: State = {};

	static getDerivedStateFromProps(
		props: { resetKey?: string },
		state: State,
	): State | null {
		return props.resetKey === state.key
			? null
			: { error: undefined, key: props.resetKey };
	}

	static getDerivedStateFromError(error: unknown): State {
		return { error: { value: error } };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		if (isChunkError(error) && reloadForChunk()) return;
		console.error("the page failed", error, info.componentStack);
	}

	override render(): ReactNode {
		const { error } = this.state;
		if (!error) return this.props.children;
		return <CrashCard error={error.value} onReload={() => location.reload()} />;
	}
}
