import { useEffect, useState } from "react";
import type { PresetRecruitsView, PresetView } from "../../src/api-types.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { Confirm } from "./confirm.tsx";
import { KnightPicker, useKnights } from "./knight-picker.tsx";

/** One preset's row in a list: its name and display name over a line about it; a tap opens it. */
export function PresetRow(props: {
	preset: PresetView;
	meta: string;
	data: Record<string, string>;
	onOpen(): void;
}) {
	return (
		<li>
			<button
				type="button"
				className="menu-item"
				{...props.data}
				aria-haspopup="dialog"
				onClick={props.onOpen}
			>
				<span className="menu-text">
					<strong>
						{props.preset.name} · {props.preset.displayName}
					</strong>
					<span className="meta">{props.meta}</span>
				</span>
			</button>
		</li>
	);
}

/** How many temp knights were made from a preset, and by how many knights. */
export const recruitSummary = (recruits: readonly PresetRecruitsView[]) => {
	const count = recruits.reduce((n, r) => n + r.active + r.archived, 0);
	const made = plural(
		count,
		"Recruited {count} time",
		"Recruited {count} times",
	);
	return recruits.length > 0
		? `${made} · ${plural(recruits.length, "{count} knight", "{count} knights")}`
		: made;
};

/**
 * A sheet that asks for one knight of the active ones, `except` left out, then runs `onPick` with
 * it; a refusal stays on the sheet in its words.
 */
export function PickKnight(props: {
	open: boolean;
	title: string;
	confirmLabel: string;
	except?: readonly string[];
	onPick(knight: string): Promise<void>;
	onClose(): void;
}) {
	const [chosen, setChosen] = useState<string>();
	return (
		<Confirm
			open={props.open}
			title={props.title}
			confirmLabel={props.confirmLabel}
			tone="primary"
			onClose={() => {
				setChosen(undefined);
				props.onClose();
			}}
			onConfirm={async () => {
				if (!chosen) throw new Error(t("Choose a knight."));
				await props.onPick(chosen);
				setChosen(undefined);
			}}
		>
			<KnightPicker
				label={props.title}
				chosen={chosen ? [chosen] : []}
				// One knight: the last one ticked replaces the one before.
				onChange={(picked) => setChosen(picked.at(-1))}
				except={props.except ?? []}
			/>
		</Confirm>
	);
}

/**
 * Inside a preset's sheet: the knights that recruited temp knights from it, with how many of each
 * are active and archived. Without `recruits` given it reads them from every knight's presets.
 */
export function PresetRecruits(props: {
	agent: string;
	name: string;
	recruits?: readonly PresetRecruitsView[];
}) {
	const { agent, name } = props;
	const [loaded, setLoaded] = useState<readonly PresetRecruitsView[]>();
	const knights = useKnights();
	const given = props.recruits;
	useEffect(() => {
		if (given) return;
		let current = true;
		teamApi.allPresets().then(
			(view) => {
				const found = view.presets.find(
					(p) => p.agent === agent && p.name === name,
				);
				if (current) setLoaded(found?.recruits ?? []);
			},
			// Without the list the section stays away; the preset itself is all there.
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, [agent, name, given]);
	const recruits = given ?? loaded;
	if (!recruits) return null;
	const nameOf = (knight: string) =>
		knights.find((one) => one.name === knight)?.displayName ?? knight;
	return (
		<section className="stack" data-recruits="">
			<h4>{t("Recruited by")}</h4>
			<p className="meta">{recruitSummary(recruits)}</p>
			{recruits.length > 0 ? (
				<ul className="menu">
					{recruits.map((one) => (
						<li
							key={one.knight}
							className="menu-item"
							data-recruit={one.knight}
						>
							<span className="menu-text">
								<strong>{nameOf(one.knight)}</strong>
								<span className="meta">
									{t("Active {count}", { count: one.active })} ·{" "}
									{t("Archived {count}", { count: one.archived })}
								</span>
							</span>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

/** The "Transfer to…" button of a preset's sheet and the sheet that picks the knight to give it to. */
export function TransferPreset(props: {
	agent: string;
	name: string;
	onTransferred(to: string): void;
}) {
	const [open, setOpen] = useState(false);
	const knights = useKnights();
	return (
		<>
			<button
				type="button"
				className="secondary"
				data-transfer=""
				onClick={() => setOpen(true)}
			>
				{t("Transfer to…")}
			</button>
			<PickKnight
				open={open}
				title={t("Transfer preset")}
				confirmLabel={t("Transfer preset")}
				except={[props.agent]}
				onClose={() => setOpen(false)}
				onPick={async (to) => {
					await teamApi.transferPreset(props.agent, props.name, to);
					const named = knights.find((one) => one.name === to);
					toast(
						t("Transferred to {name}.", { name: named?.displayName ?? to }),
					);
					props.onTransferred(to);
				}}
			/>
		</>
	);
}
