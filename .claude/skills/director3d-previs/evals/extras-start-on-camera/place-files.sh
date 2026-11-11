#!/usr/bin/env bash
# Copies the input project into the app's projects/ folder (run from the Director Console 3D repo root).
set -eu
mkdir -p projects
cp "$(dirname "$0")/files/"*.json projects/
