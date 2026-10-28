import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { characterCss } from "../src/characters/css.ts";

// Regenerates src/characters/characters.css, which a test holds equal to characterCss().
const target = resolve(import.meta.dir, "../src/characters/characters.css");
writeFileSync(target, characterCss());
console.log(`wrote ${target}`);
