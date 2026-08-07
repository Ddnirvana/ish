import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "package_tool",
		label: "Package Tool",
		description: "A package-provided tool used to verify staged capability activation.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "package tool executed" }], details: {} };
		},
	});
}
