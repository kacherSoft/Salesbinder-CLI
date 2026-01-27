#!/usr/bin/env node
/**
 * CLI entry point
 */

import { createProgram } from './index.js';

const program = createProgram();
await program.parseAsync(process.argv);
