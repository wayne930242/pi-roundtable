import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type { WaiverRead } from "../web-app.ts";

/** The required steps people waived, with who and when, in `web_onboarding`. */
export class OnboardingWaivers implements WaiverRead {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-onboarding",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_onboarding (
					principal_id text NOT NULL,
					step text NOT NULL,
					state text NOT NULL CHECK (state IN ('waived')),
					at timestamptz NOT NULL DEFAULT now(),
					PRIMARY KEY (principal_id, step)
				)`;
		},
	};

	async waived(principalId: string, step: string): Promise<boolean> {
		const [found]: { n: number }[] = await this.#sql`
			SELECT count(*)::int AS n FROM web_onboarding
			WHERE principal_id = ${principalId} AND step = ${step} AND state = 'waived'`;
		return (found?.n ?? 0) > 0;
	}

	/** Records that the person waived the step; waiving twice keeps the first time. */
	async waive(principalId: string, step: string): Promise<void> {
		await this.#sql`
			INSERT INTO web_onboarding (principal_id, step, state)
			VALUES (${principalId}, ${step}, 'waived') ON CONFLICT DO NOTHING`;
	}
}
