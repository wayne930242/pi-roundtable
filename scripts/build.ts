// Builds the console page into dist/, which the published package ships so an operator needs no build step.
import { fileURLToPath } from "node:url";
import { buildPage } from "./build-page.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const path of await buildPage(`${root}dist`))
	console.log(path.slice(root.length));
