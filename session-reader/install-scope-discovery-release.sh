#!/bin/sh
set -eu

release_name="20260827-05d92ead-scope-v1"
manifest_name="flowing-memory-release.v2.json"
manifest_sha256="a5d2a737c7dd558ff3e3566646b85d43c2ce5514dee17c4bb09405b79ffcb998"
manifest_size="349"
artifact_name="joelclaw-memory"
artifact_sha256="62922264b9f27df3ad9c18c095dabf3dd55477859522739ee396b7de78b3b6cf"
artifact_size="74988002"
application_support="/Library/Application Support"
anchor="$application_support/JoelClaw"
flowing_memory="$anchor/flowing-memory"
releases_root="$flowing_memory/releases"
destination="$releases_root/$release_name"
staged=""

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

file_size() {
  /usr/bin/stat -f '%z' "$1"
}

file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{ print $1 }'
}

verify_source_file() {
  path=$1
  expected_size=$2
  expected_sha256=$3
  test -f "$path" || fail "missing regular source file: $path"
  test ! -L "$path" || fail "source file must not be a symlink: $path"
  test "$(file_size "$path")" = "$expected_size" ||
    fail "source file size mismatch: $path"
  test "$(file_sha256 "$path")" = "$expected_sha256" ||
    fail "source file digest mismatch: $path"
}

verify_root_directory() {
  path=$1
  expected_mode=$2
  test -d "$path" || fail "missing directory: $path"
  test ! -L "$path" || fail "directory must not be a symlink: $path"
  test "$(/usr/bin/stat -f '%u' "$path")" = "0" ||
    fail "directory must be owned by uid 0: $path"
  test "$(/usr/bin/stat -f '%Lp' "$path")" = "$expected_mode" ||
    fail "directory mode must be $expected_mode: $path"
}

ensure_managed_directory() {
  path=$1
  if test -e "$path" || test -L "$path"; then
    verify_root_directory "$path" "555"
  else
    /usr/bin/install -d -o root -g wheel -m 0555 "$path"
    verify_root_directory "$path" "555"
  fi
}

cleanup() {
  status=$?
  trap - EXIT
  if test -n "$staged" && test -e "$staged"; then
    /bin/chmod -R u+w "$staged" 2>/dev/null || true
    /bin/rm -rf "$staged"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if test "$#" -ne 1; then
  printf 'usage: sudo %s /absolute/path/to/%s\n' "$0" "$release_name" >&2
  exit 2
fi
if test "$(/usr/bin/id -u)" -ne 0; then
  fail "scope discovery release installation must run as root"
fi

source_release=$1
case "$source_release" in
  /*) ;;
  *) fail "source release path must be absolute" ;;
esac
test -d "$source_release" || fail "missing source release: $source_release"
test ! -L "$source_release" || fail "source release must not be a symlink"
verify_source_file \
  "$source_release/$manifest_name" \
  "$manifest_size" \
  "$manifest_sha256"
verify_source_file \
  "$source_release/$artifact_name" \
  "$artifact_size" \
  "$artifact_sha256"

verify_root_directory "$application_support" "755"
ensure_managed_directory "$anchor"
ensure_managed_directory "$flowing_memory"
ensure_managed_directory "$releases_root"
if test -e "$destination" || test -L "$destination"; then
  fail "destination release already exists: $destination"
fi

staged="$application_support/.JoelClaw-scope-discovery-release.$$"
/bin/rm -rf "$staged"
/usr/bin/install -d -o root -g wheel -m 0700 "$staged"
/usr/bin/install \
  -o root -g wheel -m 0444 \
  "$source_release/$manifest_name" \
  "$staged/$manifest_name"
/usr/bin/install \
  -o root -g wheel -m 0555 \
  "$source_release/$artifact_name" \
  "$staged/$artifact_name"

verify_source_file "$staged/$manifest_name" "$manifest_size" "$manifest_sha256"
verify_source_file "$staged/$artifact_name" "$artifact_size" "$artifact_sha256"
test "$(/usr/bin/stat -f '%u' "$staged/$manifest_name")" = "0" ||
  fail "staged manifest owner mismatch"
test "$(/usr/bin/stat -f '%Lp' "$staged/$manifest_name")" = "444" ||
  fail "staged manifest mode mismatch"
test "$(/usr/bin/stat -f '%u' "$staged/$artifact_name")" = "0" ||
  fail "staged artifact owner mismatch"
test "$(/usr/bin/stat -f '%Lp' "$staged/$artifact_name")" = "555" ||
  fail "staged artifact mode mismatch"
/bin/mv "$staged" "$destination"
staged="$destination"
/bin/chmod 0555 "$destination"
verify_root_directory "$destination" "555"
staged=""

printf 'installed immutable scope discovery release at %s\n' "$destination"
