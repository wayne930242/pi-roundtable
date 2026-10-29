import type { ReactNode } from "react";
import { Sheet } from "./sheet.tsx";

/**
 * A modal for a form, a confirmation or a document: a sheet, so it has the same header, close
 * button, scrolling body and phone behaviour as every other panel. `wide` suits a document.
 */
export function Dialog(props: {
	open: boolean;
	title: string;
	onClose(): void;
	children: ReactNode;
	size?: "default" | "wide";
}) {
	return (
		<Sheet
			open={props.open}
			title={props.title}
			onClose={props.onClose}
			{...(props.size === "wide" ? { size: "wide" as const } : {})}
		>
			{props.children}
		</Sheet>
	);
}
