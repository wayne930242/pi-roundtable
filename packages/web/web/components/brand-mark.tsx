import { assetHref } from "../lib/router.ts";

/** The header's mark: the install icon the server ships, so a host's `icons.dir` shows here too. */
export function BrandMark() {
	return (
		<span className="brand-mark">
			<img src={assetHref("icons/192.png")} alt="" width={28} height={28} />
		</span>
	);
}
