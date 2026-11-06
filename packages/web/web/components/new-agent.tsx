import {
	type CharacterInput,
	type CharacterSpec,
	suggestCharacter,
} from "pi-roundtable/characters";
import { useEffect, useId, useMemo, useState } from "react";
import type { AgentCreate } from "../../src/api-types.ts";
import { ApiFailure, api, messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import { refreshRooms, teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import {
	AgentFields,
	DEFAULT,
	type FieldsDraft,
	NAME,
} from "./agent-fields.tsx";
import { LookCreator, LookSummary } from "./look-pick.tsx";
import { Failure } from "./states.tsx";

/** A permanent name from a display name: its Latin letters and digits, joined by dashes. */
const slugOf = (displayName: string): string =>
	displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);

/**
 * The form that makes an agent: the fields of the `agent_create` tool. Its look is the one its role
 * suggests until a person picks another in the creator, which opens in place of the form.
 */
export function NewAgent({ onDone }: { onDone(): void }) {
	const [draft, setDraft] = useState<FieldsDraft>({
		displayName: "",
		prompt: "",
		model: DEFAULT,
		thinking: DEFAULT,
	});
	const { displayName, prompt } = draft;
	const [name, setName] = useState("");
	const [named, setNamed] = useState(false);
	const [task, setTask] = useState("");
	const [look, setLook] = useState<{
		input: CharacterInput;
		spec: CharacterSpec;
	}>();
	const [picking, setPicking] = useState(false);
	const [models, setModels] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const ids = [useId(), useId()] as const;

	useEffect(() => {
		let current = true;
		api.models().then(
			(view) => current && setModels(view.models),
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, []);

	const suggested = useMemo(
		() => suggestCharacter({ name, displayName, prompt }),
		[name, displayName, prompt],
	);
	const shown = look?.spec ?? suggested;
	const ready =
		NAME.test(name) && displayName.trim() !== "" && prompt.trim() !== "";

	if (picking)
		return (
			<LookCreator
				name={name || "new"}
				displayName={displayName}
				prompt={prompt}
				spec={shown}
				onPick={(input, spec) => {
					setLook({ input, spec });
					setPicking(false);
				}}
				onCancel={() => setPicking(false)}
			/>
		);

	const create = async () => {
		setSaving(true);
		setError(undefined);
		try {
			const made: AgentCreate = {
				name,
				displayName: displayName.trim(),
				prompt,
				...(draft.model !== DEFAULT ? { model: draft.model } : {}),
				...(draft.thinking !== DEFAULT ? { thinking: draft.thinking } : {}),
				...(task.trim() ? { task: task.trim() } : {}),
				...(look ? { character: look.input } : {}),
			};
			const profile = await teamApi.createAgent(made);
			await refreshRooms();
			toast(t("Made {name}.", { name: profile.displayName }));
			onDone();
			navigate("room", profile.room);
		} catch (failure) {
			setError(
				failure instanceof ApiFailure && failure.field
					? `${failure.field}: ${messageOf(failure)}`
					: messageOf(failure),
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="stack form"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready && !saving) create();
			}}
		>
			<AgentFields
				draft={draft}
				onChange={(next) => {
					setDraft(next);
					if (!named && next.displayName !== displayName)
						setName(slugOf(next.displayName));
				}}
				models={models}
				defaultModel={t("Default model")}
				promptHint={t("Its job, its sources, its limits and how it reports.")}
			>
				<label htmlFor={ids[0]}>
					{t("Permanent name")}
					<input
						id={ids[0]}
						value={name}
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						aria-invalid={name !== "" && !NAME.test(name)}
						onChange={(event) => {
							setNamed(true);
							setName(event.target.value);
						}}
					/>
					<span className="meta">
						{t(
							"Lowercase letters, digits and dashes, up to 32. It names the room and cannot be changed.",
						)}
					</span>
				</label>
			</AgentFields>
			<label htmlFor={ids[1]}>
				{t("Opening task")}
				<textarea
					id={ids[1]}
					rows={3}
					value={task}
					onChange={(event) => setTask(event.target.value)}
				/>
				<span className="meta">
					{t("Optional. The knight starts on it as soon as it is made.")}
				</span>
			</label>
			<LookSummary
				spec={shown}
				name={name || "new"}
				displayName={displayName}
				chosen={look !== undefined}
				onChoose={() => setPicking(true)}
			/>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button type="submit" disabled={!ready || saving}>
					{saving ? t("Making…") : t("Make knight")}
				</button>
			</div>
		</form>
	);
}
