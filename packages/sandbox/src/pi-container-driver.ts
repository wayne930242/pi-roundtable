import { PI_DUMMY_TOKEN, PI_RUN_DIR, PI_WORKSPACE } from "./pi-protocol.ts";

export interface PiContainerSpec {
	name: string;
	image: string;
	channel: string;
	profile: string;
	timeZone?: string;
	labelChannel?: string;
	labelProfile?: string;
	/** Host directories mounted as the run directory and the workspace. */
	runDir: string;
	workspaceDir: string;
	/** The host user that owns the mounted directories. */
	uid: number;
	gid: number;
}

export type PiContainerState = "missing" | "running" | "stopped";

export interface PiContainerStatus {
	state: PiContainerState;
	image?: string;
	profile?: string;
}

/** Runs one container per sandbox channel; a fake replaces it in tests. */
export interface PiContainerDriver {
	/** Starts the container, recreating it when it is missing, stopped, or on another image or profile. */
	ensureRunning(spec: PiContainerSpec): Promise<void>;
	remove(name: string): Promise<void>;
	status(name: string): Promise<PiContainerStatus>;
}

export const PI_LABEL_CHANNEL = "roundtable.sandbox.channel";
export const PI_LABEL_PROFILE = "roundtable.sandbox.profile";

/**
 * The Docker Engine API body for a sealed sandbox container: no network, no capabilities,
 * a read-only root, and only the channel's two directories mounted.
 */
export function piContainerCreateBody(spec: PiContainerSpec): object {
	if (
		!/^[a-z0-9][a-z0-9_.-]{0,90}$/.test(spec.name) ||
		!/^[a-zA-Z0-9_-]{1,100}$/.test(spec.profile) ||
		!spec.image ||
		/[\s]/.test(spec.image) ||
		spec.image.startsWith("-")
	)
		throw new Error("Invalid container specification");
	if (
		!Number.isSafeInteger(spec.uid) ||
		spec.uid <= 0 ||
		!Number.isSafeInteger(spec.gid) ||
		spec.gid <= 0
	)
		throw new Error("Worker must be non-root");
	for (const dir of [spec.runDir, spec.workspaceDir])
		if (!dir.startsWith("/") || dir === "/" || /[:,\r\n]/.test(dir))
			throw new Error("Invalid mount path");
	new Intl.DateTimeFormat("en-US", { timeZone: spec.timeZone ?? "UTC" });
	return {
		Image: spec.image,
		User: `${spec.uid}:${spec.gid}`,
		Env: [
			`SANDBOX_PROFILE=${spec.profile}`,
			// Claude Code tells the model today's date from local time; guests live in Taipei.
			`TZ=${spec.timeZone ?? "UTC"}`,
			"ANTHROPIC_BASE_URL=http://127.0.0.1:8080/anthropic",
			// Claude Code needs a token to start; the broker replaces it on the way out.
			`CLAUDE_CODE_OAUTH_TOKEN=${PI_DUMMY_TOKEN}`,
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
			"SANDBOX_CONTENT=/app/worker/content.ts",
			"HOME=/tmp/home",
			"PI_CODING_AGENT_DIR=/tmp/pi-agent",
			`CLAUDE_CONFIG_DIR=${PI_WORKSPACE}/claude`,
		],
		Labels: {
			[spec.labelChannel ?? PI_LABEL_CHANNEL]: spec.channel,
			[spec.labelProfile ?? PI_LABEL_PROFILE]: spec.profile,
		},
		HostConfig: {
			NetworkMode: "none",
			ReadonlyRootfs: true,
			Tmpfs: { "/tmp": "rw,nosuid,nodev,size=512m,mode=1777" },
			MemorySwap: 1536 * 1024 * 1024,
			Ulimits: [{ Name: "nofile", Soft: 256, Hard: 256 }],
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			Memory: 1536 * 1024 * 1024,
			NanoCpus: 1_000_000_000,
			PidsLimit: 256,
			Binds: [
				`${spec.runDir}:${PI_RUN_DIR}:ro`,
				`${spec.workspaceDir}:${PI_WORKSPACE}`,
			],
			RestartPolicy: { Name: "unless-stopped" },
			LogConfig: {
				Type: "local",
				Config: { "max-size": "10m", "max-file": "2" },
			},
		},
	};
}

interface InspectBody {
	Config?: { Image?: string; Labels?: Record<string, string> };
	State?: { Running?: boolean };
}

/** PiContainerDriver over the Docker Engine API on its unix socket. */
export class PiDockerContainerDriver implements PiContainerDriver {
	readonly #socket: string;

	constructor(
		socket = "/var/run/docker.sock",
		readonly labelProfile = PI_LABEL_PROFILE,
	) {
		this.#socket = socket;
	}

	async ensureRunning(spec: PiContainerSpec): Promise<void> {
		const current = await this.status(spec.name);
		if (
			current.state === "running" &&
			current.image === spec.image &&
			current.profile === spec.profile
		) {
			return;
		}
		if (current.state !== "missing") await this.remove(spec.name);
		await this.#call(
			"POST",
			`/containers/create?name=${encodeURIComponent(spec.name)}`,
			piContainerCreateBody(spec),
		);
		await this.#call(
			"POST",
			`/containers/${encodeURIComponent(spec.name)}/start`,
		);
	}

	async remove(name: string): Promise<void> {
		await this.#call(
			"DELETE",
			`/containers/${encodeURIComponent(name)}?force=true`,
			undefined,
			[404],
		);
	}

	async status(name: string): Promise<PiContainerStatus> {
		const response = await this.#call(
			"GET",
			`/containers/${encodeURIComponent(name)}/json`,
			undefined,
			[404],
		);
		if (response.status === 404) return { state: "missing" };
		const body = (await response.json()) as InspectBody;
		return {
			state: body.State?.Running ? "running" : "stopped",
			...(body.Config?.Image ? { image: body.Config.Image } : {}),
			...(body.Config?.Labels?.[this.labelProfile]
				? { profile: body.Config.Labels[this.labelProfile] }
				: {}),
		};
	}

	async #call(
		method: string,
		path: string,
		body?: object,
		allowed: readonly number[] = [],
	): Promise<Response> {
		const response = await fetch(`http://docker${path}`, {
			unix: this.#socket,
			signal: AbortSignal.timeout(15_000),
			method,
			...(body
				? {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}
				: {}),
		});
		if (!response.ok && !allowed.includes(response.status)) {
			throw new Error(
				`docker ${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
			);
		}
		return response;
	}
}
