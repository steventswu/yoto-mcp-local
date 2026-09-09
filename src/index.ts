#!/usr/bin/env node
import { main } from './server.js';

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Startup failed'}\n`);
  process.exitCode = 1;
});
