import { createMcpAdapter } from "../../vendor/pi-mcp-adapter-loader.mjs";
import { readCapabilityConfigSync, toMcpAdapterConfig } from "./capabilities.js";
import { defaultStateDir } from "./paths.js";
import path from "node:path";

export default function ishMcpCapability(pi: unknown): void {
	process.env.MCP_OUTPUT_GUARD = "1";
	process.env.PI_CODING_AGENT_DIR ??= path.join(defaultStateDir(), "pi-agent");
	const config = toMcpAdapterConfig(readCapabilityConfigSync());
	const api = pi as {
		on(event: "session_start", handler: () => void): void;
		getActiveTools(): string[];
		setActiveTools(names: string[]): void;
	};
	createMcpAdapter({ config })(pi as never);
	api.on("session_start", () => {
		const active = new Set(api.getActiveTools());
		if (Object.keys(config.mcpServers).length > 0) active.add("mcp");
		else active.delete("mcp");
		api.setActiveTools([...active]);
	});
}
