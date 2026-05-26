#!/bin/bash
# DuckBrain MCP wrapper — ensures CWD is the duckbrain directory
cd /home/kara/duckbrain
exec node bin/duckbrain.js "$@"
