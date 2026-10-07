import type { PrincipalStore } from "./principal-store.ts";

/** Who the host serves: its principals, their identities, and their roles. Provided as `IDENTITY` by the `identity` plugin. */
export interface IdentityService {
	/** The stored principals, identity links, and lasting roles. */
	readonly principals: PrincipalStore;
}
