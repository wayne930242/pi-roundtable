// Plugin helpers, versioned like the main entry; see the plugin guide.
// The host-shell tools and the hold rule that keeps risky commands behind the owner's approval.

export {
	DEFAULT_SECRET_PATHS,
	type PushPolicy,
	SHELL_TOOLS,
	type ShellPolicy,
	shellHoldRule,
	shellHoldRuleFor,
	YOLO_CARDED_SHELL_CLASSES,
} from "../core/modules/host-shell/shell-policy.ts";
// What child processes get of the host's environment, and the mask of secret values in tool output.
export { childEnv, SHELL_ENV_NAMES } from "../core/shared/child-env.ts";
export {
	maskSecrets,
	SECRET_NAME,
	secretMaskExtension,
} from "../core/shared/secret-mask.ts";
