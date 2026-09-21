"use strict";

// Preload before Next installs its uncaughtException loggers. A launcher may
// close its output pipes while the server is still alive; logging EPIPE to that
// same broken stderr would otherwise create an endless exception feedback loop.
// Handle only output-pipe closure, never unrelated application/stream errors.
function handleOutputError(error) {
  if (error.code !== "EPIPE") throw error;
}

process.stdout.on("error", handleOutputError);
process.stderr.on("error", handleOutputError);
