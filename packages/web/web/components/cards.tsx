import { memo } from "react";
import type { CardState } from "../lib/rooms.ts";
import { ApprovalCard } from "./cards-approval.tsx";
import { AskCard, QuestionnaireCard } from "./cards-questions.tsx";

// The cards' parts live in their own files; the questions' picks are named here for the callers that read them.
export { answerOf, type Chosen, NO_PICK } from "./cards-questions.tsx";
export { describeAnswer } from "./cards-shell.tsx";

/** One card of a room: open, waiting for the person, or ended and kept as a record. */
export const PromptCard = memo(function PromptCard({
	card,
	timeZone,
}: {
	card: CardState;
	/** The zone the time it ended is shown in. */
	timeZone: string;
}) {
	const { frame } = card;
	switch (frame.kind) {
		case "approval":
			return <ApprovalCard card={card} timeZone={timeZone} frame={frame} />;
		case "ask":
			return <AskCard card={card} timeZone={timeZone} frame={frame} />;
		case "questionnaire":
			return (
				<QuestionnaireCard card={card} timeZone={timeZone} frame={frame} />
			);
	}
});
