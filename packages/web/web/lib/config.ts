import { createContext, useContext } from "react";
import type { ConfigView } from "../../src/api-types.ts";

export const ConfigContext = createContext<ConfigView | undefined>(undefined);

export function useConfig(): ConfigView {
	const config = useContext(ConfigContext);
	if (!config) throw new Error("no console config");
	return config;
}
