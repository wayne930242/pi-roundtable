// Plugin helpers, versioned like the main entry; see the plugin guide.
// The chain a host links from every plugin's hold rules, to test a rule set as the host runs it,
// and how long a hold that looks things up may take.

export { HOLD_DESCRIBE_TIMEOUT_MS, holdChain } from "../core/holds.ts";
