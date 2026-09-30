import { AgentError } from "../../domain/errors.ts";

export function checkRepoName(repo: string): void {
	if (
		!/^[\w.-]+\/[\w.-]+$/.test(repo) ||
		repo.split("/").some((p) => /^\.+$/.test(p))
	)
		throw new AgentError(
			`"${repo}" is not a repository: write it as <owner>/<repo>, as repo_list shows.`,
		);
}
