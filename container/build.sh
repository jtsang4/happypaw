#!/bin/bash
# Build the HappyPaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="happypaw-agent"
TAG="${1:-latest}"
CODEX_CONFIG_PATH="$SCRIPT_DIR/../config/codex-binary.json"

read_codex_config() {
  node -e "
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const field = process.argv[2];
const value = config[field];
if (typeof value !== 'string' || value.length === 0) {
  throw new Error('Missing pinned Codex config field: ' + field);
}
process.stdout.write(value);
" "$CODEX_CONFIG_PATH" "$1"
}

CODEX_VERSION="$(read_codex_config version)"
CODEX_RELEASE_TAG="$(read_codex_config releaseTag)"
CODEX_EXECUTABLE_PATH="$(read_codex_config containerExecutablePath)"

echo "Building HappyPaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Pinned Codex: version=${CODEX_VERSION} release=${CODEX_RELEASE_TAG} path=${CODEX_EXECUTABLE_PATH}"

# Build with Docker (CACHEBUST ensures claude-code is always latest)
# --progress=plain ensures clean line-based output for piped log capture (WebSocket streaming)
docker build --progress=plain \
  --build-arg CACHEBUST="$(date +%s)" \
  --build-arg CODEX_VERSION="${CODEX_VERSION}" \
  --build-arg CODEX_RELEASE_TAG="${CODEX_RELEASE_TAG}" \
  --build-arg CODEX_EXECUTABLE_PATH="${CODEX_EXECUTABLE_PATH}" \
  -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

# Touch sentinel so Makefile can detect stale image
touch "$SCRIPT_DIR/../.docker-build-sentinel"

echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
