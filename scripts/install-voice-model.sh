#!/usr/bin/env bash

set -Eeuo pipefail

# NVIDIA Parakeet TDT 0.6B v3 (int8) for sherpa-onnx: 25 European languages with punctuation.
# The ONNX model is architecture-independent; sherpa-onnx-node provides the native runtime.
readonly MODEL_NAME="sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
readonly MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2"
# SHA-256 published as the release asset digest.
readonly MODEL_CHECKSUM="5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf"
readonly MODEL_DIRECTORY="/opt/web-terminal/voice-model"
readonly MODEL_FILES=(encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt)

main() (
  local work_dir file
  work_dir="$(mktemp -d)"
  trap 'rm -rf -- "$work_dir"' EXIT

  cd "$work_dir"
  curl --fail --location --silent --show-error --retry 3 \
    --proto '=https' --proto-redir '=https' \
    --output model.tar.bz2 "$MODEL_URL"
  printf '%s  %s\n' "$MODEL_CHECKSUM" model.tar.bz2 |
    sha256sum --check --strict
  tar --extract --bzip2 --file model.tar.bz2 --no-same-owner \
    "${MODEL_FILES[@]/#/${MODEL_NAME}/}"
  install -d -m 0755 "$MODEL_DIRECTORY"
  for file in "${MODEL_FILES[@]}"; do
    install -m 0644 "${MODEL_NAME}/${file}" "${MODEL_DIRECTORY}/${file}"
  done
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
