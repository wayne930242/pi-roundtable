import type { KindLinkView } from "../../src/api-types.ts";
import HostKindSection from "./host-kind-section.tsx";

/** One section for each kind of host room the person may list. */
export default function HostKinds(props: {
	kinds: readonly KindLinkView[];
	active: string | undefined;
}) {
	return props.kinds.map((kind) => (
		<HostKindSection
			key={kind.kind}
			kind={kind.kind}
			label={kind.label}
			{...(kind.icon ? { icon: kind.icon } : {})}
			active={props.active}
		/>
	));
}
