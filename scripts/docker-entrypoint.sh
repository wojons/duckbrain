#!/bin/sh
set -e

# DuckBrain Docker Entrypoint
# Initializes data directory and git repo for version-controlled storage

# Ensure data directory exists
mkdir -p /data

# Initialize git repo if not exists (for version-controlled memory)
if [ ! -d /data/.git ]; then
    echo "[duckbrain] Initializing git repository in /data"
    git init /data
    # Configure git user for container commits
    git -C /data config user.email "duckbrain@container"
    git -C /data config user.name "DuckBrain Container"
fi

# Run the main command
exec "$@"
