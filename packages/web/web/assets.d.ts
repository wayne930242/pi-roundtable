/** A stylesheet imported with `with { type: "file" }` is the URL of the file the build emits. */
declare module "*.css" {
	const url: string;
	export default url;
}
