import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const adapter = await jiti.import(new URL("../node_modules/pi-mcp-adapter/index.ts", import.meta.url).pathname);

export const createMcpAdapter = adapter.createMcpAdapter;
