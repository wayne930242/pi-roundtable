import type { ConnectorsView } from "./api-types.ts";
import type { ConsoleFeatures } from "./features.ts";
import { ConsoleHttpError as HttpError } from "./http.ts";

export async function connectorsView(
	connectors: NonNullable<ConsoleFeatures["connectors"]>,
): Promise<ConnectorsView> {
	try {
		const [gateways, servers] = await Promise.all([
			connectors.gateways(),
			connectors.servers(),
		]);
		return {
			gateways,
			servers: servers.map((server) => ({
				...server,
				usedBy: connectors.usedBy(server.name),
			})),
		};
	} catch {
		throw new HttpError(
			502,
			"The connector service did not respond. Try again later.",
		);
	}
}
