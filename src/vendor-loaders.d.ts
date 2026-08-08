declare module "*.mjs" {
	const defaultExport: (...args: never[]) => unknown;
	export default defaultExport;
	export function createMcpAdapter(options?: unknown): (pi: never) => void;
}
