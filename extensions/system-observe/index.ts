import type { PiExtensionAPI } from "../../src/pi-types.js";
import { registerGitInspect } from "./git.js";
import { registerLogAndServiceObserve } from "./log-service.js";
import { registerNetworkObserve } from "./network.js";
import { registerProcessObserve } from "./process.js";
import { registerShellObserve } from "./shell.js";

export function registerSystemObserve(pi: PiExtensionAPI): void {
	registerShellObserve(pi);
	registerProcessObserve(pi);
	registerLogAndServiceObserve(pi);
	registerNetworkObserve(pi);
	registerGitInspect(pi);
}
