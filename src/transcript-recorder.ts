#!/usr/bin/env node
import { runTranscriptRecorder } from "./transcript.js";

const [fifo, eventsFile, metaDir, ptySlaveFile] = process.argv.slice(2);
if (!fifo || !eventsFile || !metaDir) {
	console.error("usage: transcript-recorder FIFO EVENTS_FILE META_DIR [PTY_SLAVE_FILE]");
	process.exitCode = 2;
} else {
	await runTranscriptRecorder(fifo, eventsFile, metaDir, ptySlaveFile);
}
