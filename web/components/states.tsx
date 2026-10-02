import type { ReactNode } from "react";

export function Loading() {
	return (
		<div className="stack" aria-busy="true">
			<div className="skeleton" />
			<div className="skeleton" />
		</div>
	);
}

export function Failure({ message }: { message: string }) {
	return (
		<p className="failure" role="alert">
			{message}
		</p>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return <p className="empty">{children}</p>;
}

export function Badge({
	children,
	tone = "plain",
}: {
	children: ReactNode;
	tone?: "plain" | "busy" | "warn";
}) {
	return <span className={`badge badge-${tone}`}>{children}</span>;
}
