import {
	type CharacterInput,
	type CharacterSpec,
	suggestCharacter,
} from "pi-roundtable/characters";
import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
import type { AgentCreate } from "../../src/api-types.ts";
import { ApiFailure, api, messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import { refreshRooms, teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { PageCharacter } from "./character.tsx";
import { Chips } from "./chips.tsx";
import { Failure, Loading } from "./states.tsx";

// The creator is a page's worth of picking; it loads when the look is first chosen.
const CharacterCreator = lazy(() =>
	import("./character-creator.tsx").then((m) => ({
		default: m.CharacterCreator,
	})),
);

const NAME = /^[a-z0-9-]{1,32}$/;
const DEFAULT = "default";

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
	const [displayName, setDisplayName] = useState("");
	const [name, setName] = useState("");
	const [named, setNamed] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState(DEFAULT);
	const [task, setTask] = useState("");
	const [look, setLook] = useState<{
		input: CharacterInput;
		spec: CharacterSpec;
	}>();
	const [picking, setPicking] = useState(false);
	const [models, setModels] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const ids = [useId(), useId(), useId(), useId()] as const;

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
			<Suspense fallback={<Loading />}>
				<CharacterCreator
					name={name || "new"}
					displayName={displayName}
					prompt={prompt}
					character={shown}
					onPick={(input, spec) => {
						setLook({ input, spec });
						setPicking(false);
					}}
					onCancel={() => setPicking(false)}
				/>
			</Suspense>
		);

	const create = async () => {
		setSaving(true);
		setError(undefined);
		try {
			const made: AgentCreate = {
				name,
				displayName: displayName.trim(),
				prompt,
				...(model !== DEFAULT ? { model } : {}),
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
			<label htmlFor={ids[0]}>
				{t("Name")}
				<input
					id={ids[0]}
					value={displayName}
					autoComplete="off"
					onChange={(event) => {
						setDisplayName(event.target.value);
						if (!named) setName(slugOf(event.target.value));
					}}
				/>
			</label>
			<label htmlFor={ids[1]}>
				{t("Permanent name")}
				<input
					id={ids[1]}
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
			<label htmlFor={ids[2]}>
				{t("Prompt")}
				<textarea
					id={ids[2]}
					rows={6}
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
				/>
				<span className="meta">
					{t("Its job, its sources, its limits and how it reports.")}
				</span>
			</label>
			<Chips
				label={t("Model")}
				value={model}
				onChange={setModel}
				options={[DEFAULT, ...models].map((one) => ({
					value: one,
					label: one === DEFAULT ? t("Follow the assistant") : one,
				}))}
			/>
			<label htmlFor={ids[3]}>
				{t("Opening task")}
				<textarea
					id={ids[3]}
					rows={3}
					value={task}
					onChange={(event) => setTask(event.target.value)}
				/>
				<span className="meta">
					{t("Optional. The agent starts on it as soon as it is made.")}
				</span>
			</label>
			<div className="profile-head">
				<PageCharacter
					spec={shown}
					name={name || "new"}
					size={72}
					label={displayName}
				/>
				<div>
					<strong>{t("Look")}</strong>
					<span className="meta">
						{look ? t("Your look") : t("Suggested from its role")}
					</span>
					<button
						type="button"
						className="secondary compact"
						onClick={() => setPicking(true)}
					>
						{t("Choose a look")}
					</button>
				</div>
			</div>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button type="submit" disabled={!ready || saving}>
					{saving ? t("Making…") : t("Make agent")}
				</button>
			</div>
		</form>
	);
}
