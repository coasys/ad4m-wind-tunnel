#!/usr/bin/env bash
# test-git.sh — Git Link Language integration test
# Infrastructure: None — pure local Git repository under the language's storage.
#
# v1 of the Git link language has no automated remote sync: the executor's
# httpFetch returns response bodies as UTF-8 strings, mangling Git smart-protocol
# pack files (see git-link-language spec §11.2). Until a binary HTTP host
# enhancement lands, the multi-device sync tests below cannot run — they are
# skipped via the LANG_GIT-empty path in run_standard_tests.
#
# For end-to-end single-device verification of commit / history / blame / revert,
# use interop/verify-git.sh instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"
load_config

run_standard_tests "git" "${LANG_GIT:-}"
