/** A stylesheet imported with `with { type: "file" }` is the URL of the file the build emits, and with `with { type: "text" }` its text. */
declare module "*.css" {
	const urlOrText: string;
	export default urlOrText;
}
