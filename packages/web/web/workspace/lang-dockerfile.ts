import { StreamLanguage } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";

export const language = () => StreamLanguage.define(dockerFile);
