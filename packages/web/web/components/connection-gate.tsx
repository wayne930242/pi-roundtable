import type { ReactNode } from "react";
import { type AppConnection, startConnection } from "../lib/socket.ts";

/**
 * Opens the page's connection before anything under it renders, so a room opened by a reload or
 * a link finds the connection its first render asks for. Opening it is idempotent.
 */
export function ConnectionGate(props: {
	protocol: string;
	/** Makes the connection; the page's own by default. */
	make?: (protocol: string) => AppConnection;
	children: ReactNode;
}) {
	startConnection(props.protocol, props.make);
	return props.children;
}
