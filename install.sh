#!/usr/bin/env bash
# One-liner install for omp-dingtalk from GitHub Release.
# Usage:
#   curl -fsSL https://github.com/sgr997/omp-dingtalk/releases/download/v0.1.0/install.sh | bash
# Or, if you prefer wget:
#   wget -qO- https://github.com/sgr997/omp-dingtalk/releases/download/v0.1.0/install.sh | bash

set -euo pipefail

REPO="sgr997/omp-dingtalk"
VERSION="${OMP_DINGTALK_VERSION:-v0.1.0}"
INSTALL_DIR="${OMP_DINGTALK_DIR:-$HOME/.local/share/omp-dingtalk}"
ARCHIVE_URL="https://github.com/${REPO}/releases/download/${VERSION}/omp-dingtalk-${VERSION#v}.tar.gz"

echo "==> Installing omp-dingtalk ${VERSION} to ${INSTALL_DIR}"

# Refuse to wipe a source checkout — install.sh is for fresh Release installs.
if [ -d "${INSTALL_DIR}/.git" ]; then
	echo "Error: ${INSTALL_DIR} is a git working copy." >&2
	echo "       install.sh replaces that directory wholesale. On a source copy use:" >&2
	echo "         omp plugin link ${INSTALL_DIR}   # or: git pull" >&2
	exit 1
fi

# Ensure install directory exists and is empty
rm -rf "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"

# Download and extract
echo "==> Downloading from ${ARCHIVE_URL}"
if command -v curl >/dev/null 2>&1; then
	curl -fsSL "${ARCHIVE_URL}" | tar -xzf - -C "${INSTALL_DIR}" --strip-components=1
elif command -v wget >/dev/null 2>&1; then
	wget -qO- "${ARCHIVE_URL}" | tar -xzf - -C "${INSTALL_DIR}" --strip-components=1
else
	echo "Error: curl or wget is required." >&2
	exit 1
fi

# Link into omp
echo "==> Linking into omp"
if command -v omp >/dev/null 2>&1; then
	omp plugin link "${INSTALL_DIR}"
else
	echo "Warning: 'omp' not found in PATH. Please link manually:"
	echo "  omp plugin link ${INSTALL_DIR}"
fi

# Seed config if missing
CONFIG_DIR="${OMP_CONFIG_DIR:-$HOME/.omp}"
if [ ! -f "${CONFIG_DIR}/dingtalk.json" ]; then
	mkdir -p "${CONFIG_DIR}"
	cp "${INSTALL_DIR}/config.example.json" "${CONFIG_DIR}/dingtalk.json"
	chmod 600 "${CONFIG_DIR}/dingtalk.json"
	echo "==> Created ${CONFIG_DIR}/dingtalk.json from example (mode 600)"
	echo "    webhook.url and the stream credentials are empty — fill in yours,"
	echo "    then run doctor to see what is still missing."
else
	echo "==> ${CONFIG_DIR}/dingtalk.json already exists — not overwriting"
fi

echo "==> Done. Run 'bun run doctor' inside ${INSTALL_DIR} to verify."
