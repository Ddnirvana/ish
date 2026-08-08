import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const extension = await jiti.import(new URL("../node_modules/pi-web-access/index.ts", import.meta.url).pathname);

export default extension.default ?? extension;
