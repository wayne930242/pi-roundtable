import type { ChangeReport } from "./repo-types.ts";

/** The report as posted for the owner. */
export function reportPost(report: ChangeReport, direct = false): string {
	return [
		`**Change report**: \`${report.repo}\`, commit \`${report.sha}\`, default branch \`${report.branch}\`.`,
		`**Push destination**: \`${report.target}\``,
		`**Commits (${report.commits.length})**`,
		...report.commits.map((c) => `- \`${c.slice(0, 12)}\`${c.slice(12)}`),
		"**Changed files**",
		`\`\`\`\n${report.diffstat}\n\`\`\``,
		direct
			? "This repository is explicitly owner-owned; repo_push does not need an approval card."
			: `After approval: repo_push ${report.repo} ${report.sha}`,
	].join("\n");
}
