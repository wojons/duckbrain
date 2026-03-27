#!/usr/bin/env node
/**
 * DuckBrain CLI Executable
 *
 * Wrapper script that loads tsx and runs the TypeScript CLI.
 */

// Register tsx to handle TypeScript files
require('tsx/cjs');

const path = require('path');

// Run the TypeScript CLI
require(path.join(__dirname, 'duckbrain.ts'));
