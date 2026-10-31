import type { UploadView } from "../../src/api-types.ts";
import { firstLine } from "../lib/attach.ts";
import { size as bytes } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

export interface Attached {
	key: number;
	name: string;
	size: number;
	upload?: UploadView;
	failed?: string;
	/** A long text that waits here as a file and is uploaded when the message is sent; it can be taken back into the box. */
	text?: string;
}

/** The chips of the files a message waits with: each shows its state, and can be taken away; a long text can go back into the box. */
export function AttachedChips(props: {
	files: Attached[];
	sending: boolean;
	onTakeBack(one: Attached): void;
	onRemove(one: Attached): void;
}) {
	return props.files.length ? (
		<ul className="attached">
			{props.files.map((one) => (
				<li
					key={one.key}
					className="attached-chip"
					data-kind={one.text === undefined ? "file" : "text"}
					data-state={
						one.failed
							? "failed"
							: one.upload || one.text !== undefined
								? "ready"
								: "uploading"
					}
					title={one.failed}
				>
					{one.text === undefined ? (
						<>
							<Icon name="file" size={14} />
							<span className="chip-body">
								<span className="chip-name">{one.name}</span>
								<span className="meta">{bytes(one.size)}</span>
							</span>
						</>
					) : (
						<button
							type="button"
							className="chip-take"
							disabled={props.sending}
							aria-label={t("Put {name} back into the message", {
								name: one.name,
							})}
							onClick={() => props.onTakeBack(one)}
						>
							<Icon name="file" size={14} />
							<span className="chip-body">
								<span className="chip-name">
									{one.name} · {bytes(one.size)}
								</span>
								<span className="meta">{firstLine(one.text)}</span>
							</span>
						</button>
					)}
					<button
						type="button"
						className="icon-button"
						aria-label={t("Remove {name}", { name: one.name })}
						disabled={props.sending}
						onClick={() => props.onRemove(one)}
					>
						<Icon name="close" size={14} />
					</button>
				</li>
			))}
		</ul>
	) : null;
}
