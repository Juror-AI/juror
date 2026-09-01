#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${JUROR_QA_REPO_DIR:-$PWD}"
EVIDENCE_DIR="${JUROR_QA_EVIDENCE_DIR:-$ROOT/.context/qa-evidence}"
IMAGE="${JUROR_QA_IMAGE:-juror-qa:dev}"
CONTAINER_USER="${JUROR_QA_CONTAINER_USER:-$(id -u):$(id -g)}"

if ! [[ "$CONTAINER_USER" =~ ^[0-9]+:[0-9]+$ ]]; then
  echo 'JUROR_QA_CONTAINER_USER must be a numeric UID:GID' >&2
  exit 2
fi
CONTAINER_UID="${CONTAINER_USER%%:*}"
CONTAINER_GID="${CONTAINER_USER##*:}"

if [ -z "${JUROR_QA_IMAGE:-}" ]; then
  docker build --file "$ROOT/qa/Dockerfile" --tag "$IMAGE" "$ROOT"
fi

mkdir -p "$EVIDENCE_DIR"
CALLER_LOGICAL_DIR="$(pwd -L)"
CALLER_PHYSICAL_DIR="$(pwd -P)"
REPO_LOGICAL_DIR="$(cd "$REPO_DIR" && pwd -L)"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
EVIDENCE_DIR="$(cd "$EVIDENCE_DIR" && pwd -P)"

qa_path_is_repo_owned() {
  case "$1" in
    "$REPO_DIR"|"$REPO_DIR"/*|"$REPO_LOGICAL_DIR"|"$REPO_LOGICAL_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

qa_path_crosses_repo() {
  local candidate="$1"
  local component=''
  local prefix=''
  local resolved_prefix=''
  local previous_inside=false
  local component_text="$candidate"
  local remainder=''
  local -a components=()
  [ -n "$candidate" ] || return 1
  case "$candidate" in
    /*)
      component_text="${candidate#/}"
      if qa_path_is_repo_owned '/'; then previous_inside=true; fi
      ;;
    *)
      prefix="$CALLER_LOGICAL_DIR"
      if qa_path_is_repo_owned "$CALLER_LOGICAL_DIR" || \
         qa_path_is_repo_owned "$CALLER_PHYSICAL_DIR"; then
        previous_inside=true
      fi
      ;;
  esac
  # Split on `/` with parameter expansion so even newline-bearing path components are
  # inspected as filesystem names rather than being truncated by line-oriented `read`.
  remainder="$component_text"
  while [[ "$remainder" == */* ]]; do
    components+=("${remainder%%/*}")
    remainder="${remainder#*/}"
  done
  components+=("$remainder")
  for component in "${components[@]}"; do
    [ -n "$component" ] || continue
    if [ "$previous_inside" = true ] && [ "$component" != '.' ] && [ "$component" != '..' ]; then
      return 0
    fi
    prefix="$prefix/$component"
    resolved_prefix="$(realpath "$prefix" 2>/dev/null || true)"
    previous_inside=false
    if [ -n "$resolved_prefix" ] && qa_path_is_repo_owned "$resolved_prefix"; then
      previous_inside=true
    fi
  done
  [ "$previous_inside" = true ]
}

# A linked worktree stores only a gitfile in the checkout; that file normally points to an
# absolute host path below the primary clone's common Git directory. `/workspace` is the only
# source bind in the container, so the host pointer is otherwise broken. Re-home the exact
# worktree metadata and common directory at fixed, read-only container paths and cover the three
# path-bearing metadata files with controller-generated values. This neither exposes an arbitrary
# host path as a container destination nor gives the QA container write access to source Git state.
SOURCE_GIT_MOUNTS=()
GIT_POINTER_FILE=''
GIT_COMMONDIR_FILE=''
GIT_BACKLINK_FILE=''
prepare_source_git_mounts() {
  local pointer="$REPO_DIR/.git"
  local gitdir_record=''
  local gitdir_entry=''
  local gitdir_candidate=''
  local gitdir_source=''
  local common_record=''
  local common_candidate=''
  local common_source=''
  local worktree_name=''

  # Ordinary clones carry their complete metadata below /workspace and need no extra mount.
  if [ -d "$pointer" ]; then return 0; fi
  # Leave the normal CLI error path intact for a non-repository checkout, but do not follow a
  # symlink masquerading as the linked-worktree gitfile.
  if [ ! -e "$pointer" ]; then return 0; fi
  if [ -L "$pointer" ] || [ ! -f "$pointer" ]; then
    echo "Linked-worktree metadata must be a regular .git file: $pointer" >&2
    exit 2
  fi
  if [ "$(awk 'END { print NR }' "$pointer")" -ne 1 ]; then
    echo "Linked-worktree .git file must contain exactly one line: $pointer" >&2
    exit 2
  fi

  IFS= read -r gitdir_record < "$pointer" || true
  case "$gitdir_record" in
    'gitdir: '*) gitdir_entry="${gitdir_record#gitdir: }" ;;
    *)
      echo "Invalid linked-worktree .git file: $pointer" >&2
      exit 2
      ;;
  esac
  case "$gitdir_entry" in
    ''|*$'\r'*|*$'\n'*)
      echo "Invalid linked-worktree gitdir path in $pointer" >&2
      exit 2
      ;;
    /*) gitdir_candidate="$gitdir_entry" ;;
    *) gitdir_candidate="$REPO_DIR/$gitdir_entry" ;;
  esac
  gitdir_source="$(realpath "$gitdir_candidate" 2>/dev/null || true)"
  if [ -z "$gitdir_source" ] || [ ! -d "$gitdir_source" ] || [ ! -f "$gitdir_source/HEAD" ]; then
    echo "Linked-worktree gitdir does not exist or is incomplete: $gitdir_entry" >&2
    exit 2
  fi

  if [ ! -f "$gitdir_source/commondir" ] || [ -L "$gitdir_source/commondir" ]; then
    echo "Linked-worktree gitdir has no regular commondir file: $gitdir_source" >&2
    exit 2
  fi
  if [ "$(awk 'END { print NR }' "$gitdir_source/commondir")" -ne 1 ]; then
    echo "Linked-worktree commondir must contain exactly one line: $gitdir_source/commondir" >&2
    exit 2
  fi
  IFS= read -r common_record < "$gitdir_source/commondir" || true
  case "$common_record" in
    ''|*$'\r'*|*$'\n'*)
      echo "Invalid linked-worktree commondir in $gitdir_source" >&2
      exit 2
      ;;
    /*) common_candidate="$common_record" ;;
    *) common_candidate="$gitdir_source/$common_record" ;;
  esac
  common_source="$(realpath "$common_candidate" 2>/dev/null || true)"
  if [ -z "$common_source" ] || [ ! -d "$common_source/objects" ] || [ ! -f "$common_source/HEAD" ]; then
    echo "Linked-worktree common Git directory is incomplete: $common_record" >&2
    exit 2
  fi

  # Git's linked-worktree layout is <common>/worktrees/<name>. Requiring that exact resolved
  # relationship prevents a crafted commondir file from turning this narrow exception into a
  # read-only mount of an unrelated broad host directory.
  case "$gitdir_source" in
    "$common_source"/worktrees/*) ;;
    *)
      echo "Unsupported linked-worktree metadata layout: $gitdir_source" >&2
      exit 2
      ;;
  esac
  worktree_name="${gitdir_source#"$common_source"/worktrees/}"
  case "$worktree_name" in
    ''|*/*)
      echo "Unsupported linked-worktree metadata layout: $gitdir_source" >&2
      exit 2
      ;;
  esac
  case "$gitdir_source" in
    *,*)
      echo 'Linked-worktree Git metadata paths cannot contain a comma (unsupported by Docker --mount)' >&2
      exit 2
      ;;
  esac
  case "$common_source" in
    *,*)
      echo 'Linked-worktree Git metadata paths cannot contain a comma (unsupported by Docker --mount)' >&2
      exit 2
      ;;
  esac

  GIT_POINTER_FILE="$(mktemp "${TMPDIR:-/tmp}/juror-qa-gitfile.XXXXXX")"
  GIT_COMMONDIR_FILE="$(mktemp "${TMPDIR:-/tmp}/juror-qa-commondir.XXXXXX")"
  GIT_BACKLINK_FILE="$(mktemp "${TMPDIR:-/tmp}/juror-qa-gitdir.XXXXXX")"
  case "$GIT_POINTER_FILE" in
    *,*)
      echo 'Temporary linked-worktree metadata paths cannot contain a comma (unsupported by Docker --mount)' >&2
      exit 2
      ;;
  esac
  case "$GIT_COMMONDIR_FILE" in
    *,*)
      echo 'Temporary linked-worktree metadata paths cannot contain a comma (unsupported by Docker --mount)' >&2
      exit 2
      ;;
  esac
  case "$GIT_BACKLINK_FILE" in
    *,*)
      echo 'Temporary linked-worktree metadata paths cannot contain a comma (unsupported by Docker --mount)' >&2
      exit 2
      ;;
  esac
  printf '%s\n' 'gitdir: /run/juror-worktree.git' > "$GIT_POINTER_FILE"
  printf '%s\n' '/run/juror-common.git' > "$GIT_COMMONDIR_FILE"
  printf '%s\n' '/workspace/.git' > "$GIT_BACKLINK_FILE"
  chmod 0444 "$GIT_POINTER_FILE" "$GIT_COMMONDIR_FILE" "$GIT_BACKLINK_FILE"

  SOURCE_GIT_MOUNTS+=(
    --mount "type=bind,src=$gitdir_source,dst=/run/juror-worktree.git,readonly"
    --mount "type=bind,src=$common_source,dst=/run/juror-common.git,readonly"
    --mount "type=bind,src=$GIT_POINTER_FILE,dst=/workspace/.git,readonly"
    --mount "type=bind,src=$GIT_COMMONDIR_FILE,dst=/run/juror-worktree.git/commondir,readonly"
    --mount "type=bind,src=$GIT_BACKLINK_FILE,dst=/run/juror-worktree.git/gitdir,readonly"
  )
}

RUN_ARGS=()
RUNTIME_ARGS=()
POLICY_MOUNTS=()
RUNTIME_MOUNTS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || { echo 'Missing value for --config' >&2; exit 2; }
      CONFIG_PARENT="$(cd "$(dirname "$2")" && pwd -P)"
      CONFIG_PATH="$CONFIG_PARENT/$(basename "$2")"
      CONFIG_SOURCE="$(realpath "$2" 2>/dev/null || true)"
      CONFIG_RELATIVE=''
      case "$CONFIG_PATH" in
        "$REPO_DIR"/*)
          CONFIG_RELATIVE="${CONFIG_PATH#"$REPO_DIR"/}"
          ;;
      esac
      if [ -z "$CONFIG_RELATIVE" ] && [ -n "$CONFIG_SOURCE" ]; then
        case "$CONFIG_SOURCE" in
          "$REPO_DIR"/*) CONFIG_RELATIVE="${CONFIG_SOURCE#"$REPO_DIR"/}" ;;
        esac
      fi
      if [ -n "$CONFIG_RELATIVE" ]; then
        # Preserve the resolved trust identity. The CLI reads repository-owned
        # config from the PR base even when an outside symlink points back inside.
        RUN_ARGS+=(--config "/workspace/$CONFIG_RELATIVE")
      else
        if [ -z "$CONFIG_SOURCE" ]; then
          echo "External --config path does not exist: $2" >&2
          exit 2
        fi
        # A path outside the tested repository is an explicit operator-owned override.
        POLICY_MOUNTS+=(--mount "type=bind,src=$CONFIG_SOURCE,dst=/run/juror-config.yml,readonly")
        RUNTIME_MOUNTS+=(--mount "type=bind,src=$CONFIG_SOURCE,dst=/run/juror-config.yml,readonly")
        RUN_ARGS+=(--config /run/juror-config.yml)
      fi
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || { echo 'Missing value for --env-file' >&2; exit 2; }
      ENV_FILE_LOGICAL_PARENT="$(cd "$(dirname "$2")" 2>/dev/null && pwd -L || true)"
      ENV_FILE_PHYSICAL_PARENT="$(cd "$(dirname "$2")" 2>/dev/null && pwd -P || true)"
      ENV_FILE_LEXICAL=''
      ENV_FILE_ENTRY=''
      if [ -n "$ENV_FILE_LOGICAL_PARENT" ]; then
        ENV_FILE_LEXICAL="$ENV_FILE_LOGICAL_PARENT/$(basename "$2")"
      fi
      if [ -n "$ENV_FILE_PHYSICAL_PARENT" ]; then
        ENV_FILE_ENTRY="$ENV_FILE_PHYSICAL_PARENT/$(basename "$2")"
      fi
      ENV_FILE_SOURCE="$(realpath "$2" 2>/dev/null || true)"
      if [ -z "$ENV_FILE_SOURCE" ] || [ ! -f "$ENV_FILE_SOURCE" ]; then
        echo "QA environment file does not exist or is not a regular file: $2" >&2
        exit 2
      fi
      if qa_path_crosses_repo "$2" || \
         qa_path_crosses_repo "$ENV_FILE_LEXICAL" || \
         qa_path_crosses_repo "$ENV_FILE_ENTRY" || \
         qa_path_crosses_repo "$ENV_FILE_SOURCE"; then
        echo "QA environment file must be outside the tested repository: $2" >&2
        exit 2
      fi
      # Credential files stay outside the policy container and are handed to
      # the runtime only after trusted policy has opted in.
      RUNTIME_MOUNTS+=(--mount "type=bind,src=$ENV_FILE_SOURCE,dst=/run/juror-qa.env,readonly")
      RUNTIME_ARGS+=(--env-file /run/juror-qa.env)
      shift 2
      ;;
    --storage-state)
      [ "$#" -ge 2 ] || { echo 'Missing value for --storage-state' >&2; exit 2; }
      STORAGE_SOURCE="$(realpath "$2")"
      # Authenticated browser state is withheld until trusted policy has opted in.
      RUNTIME_MOUNTS+=(--mount "type=bind,src=$STORAGE_SOURCE,dst=/run/juror-storage-state.json,readonly")
      RUN_ARGS+=(--storage-state /run/juror-storage-state.json)
      shift 2
      ;;
    --repo-dir|--evidence-dir)
      echo "$1 is managed by JUROR_QA_REPO_DIR/JUROR_QA_EVIDENCE_DIR" >&2
      exit 2
      ;;
    *)
      RUN_ARGS+=("$1")
      shift
      ;;
  esac
done

TOKEN_ARGS=()
for NAME in GITHUB_TOKEN GH_TOKEN; do
  if [ -n "${!NAME:-}" ]; then TOKEN_ARGS+=(--env "$NAME"); fi
done
for NAME in GITHUB_API_URL GITHUB_SERVER_URL; do
  if [ -n "${!NAME:-}" ]; then TOKEN_ARGS+=(--env "$NAME"); fi
done
QA_GITHUB_TOKEN=''
if [ "${#TOKEN_ARGS[@]}" -eq 0 ] && command -v gh >/dev/null 2>&1; then
  QA_GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
  if [ -n "$QA_GITHUB_TOKEN" ]; then
    # Docker inherits named variables without placing their values in argv.
    # Never construct `--env NAME=value` for a credential.
    export GITHUB_TOKEN="$QA_GITHUB_TOKEN"
    TOKEN_ARGS+=(--env GITHUB_TOKEN)
  fi
fi

POLICY_FILE="$(mktemp "${TMPDIR:-/tmp}/juror-qa-policy.XXXXXX")"
SUFFIX="local-$$"
POLICY_NAME="juror-qa-policy-$SUFFIX"
RUNTIME_NAME="juror-qa-runtime-$SUFFIX"
EGRESS_NETWORK="juror-qa-egress-$SUFFIX"
INTERNAL_NETWORK="juror-qa-internal-$SUFFIX"
PROXY_NAME="juror-qa-proxy-$SUFFIX"
POLICY_ATTACH_PID=''
RUNTIME_ATTACH_PID=''
cleanup_all() {
  local status=$?
  trap - EXIT
  trap '' INT TERM
  docker stop --time 5 "$RUNTIME_NAME" >/dev/null 2>&1 || true
  docker rm -f "$RUNTIME_NAME" >/dev/null 2>&1 || true
  docker rm -f "$POLICY_NAME" >/dev/null 2>&1 || true
  if [ -n "$RUNTIME_ATTACH_PID" ]; then wait "$RUNTIME_ATTACH_PID" >/dev/null 2>&1 || true; fi
  if [ -n "$POLICY_ATTACH_PID" ]; then wait "$POLICY_ATTACH_PID" >/dev/null 2>&1 || true; fi
  docker rm -f "$PROXY_NAME" >/dev/null 2>&1 || true
  docker network rm "$INTERNAL_NETWORK" >/dev/null 2>&1 || true
  docker network rm "$EGRESS_NETWORK" >/dev/null 2>&1 || true
  rm -f "$POLICY_FILE" "$GIT_POINTER_FILE" "$GIT_COMMONDIR_FILE" "$GIT_BACKLINK_FILE"
  exit "$status"
}
cancel_all() {
  case "$1" in
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
}
trap cleanup_all EXIT
trap 'cancel_all INT' INT
trap 'cancel_all TERM' TERM

prepare_source_git_mounts

docker create \
  --name "$POLICY_NAME" \
  --init \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --tmpfs "/home/pwuser:rw,nosuid,nodev,size=32m,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0700" \
  --user "$CONTAINER_USER" \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --pids-limit=128 \
  --memory=512m \
  --cpus=1 \
  --mount "type=bind,src=$REPO_DIR,dst=/workspace,readonly" \
  ${SOURCE_GIT_MOUNTS[@]+"${SOURCE_GIT_MOUNTS[@]}"} \
  ${POLICY_MOUNTS[@]+"${POLICY_MOUNTS[@]}"} \
  ${TOKEN_ARGS[@]+"${TOKEN_ARGS[@]}"} \
  --env JUROR_OPENAI_API_KEY= \
  --env OPENAI_API_KEY= \
  --env JUROR_QA_SECRETS_B64= \
  --entrypoint node \
  "$IMAGE" \
  /opt/juror/dist/cli.js qa-policy \
  --repo-dir /workspace \
  ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} >/dev/null
docker start --attach "$POLICY_NAME" > "$POLICY_FILE" &
POLICY_ATTACH_PID=$!
set +e
wait "$POLICY_ATTACH_PID"
POLICY_STATUS=$?
set -e
docker rm -f "$POLICY_NAME" >/dev/null 2>&1 || true
POLICY_ATTACH_PID=''
if [ "$POLICY_STATUS" -ne 0 ]; then exit "$POLICY_STATUS"; fi

if [ "$(jq -r '.enabled' "$POLICY_FILE")" != 'true' ]; then
  echo 'Juror QA is disabled by trusted policy; pass --force for an intentional local run.'
  exit 0
fi
EGRESS_ALLOW_B64="$(jq -c '.allowed_origins' "$POLICY_FILE" | base64 | tr -d '\n')"

ENV_ARGS=()
for NAME in GITHUB_TOKEN GH_TOKEN GITHUB_API_URL GITHUB_SERVER_URL JUROR_OPENAI_API_KEY OPENAI_API_KEY JUROR_QA_SECRETS_B64; do
  if [ -n "${!NAME:-}" ]; then ENV_ARGS+=(--env "$NAME"); fi
done
if [ -n "$QA_GITHUB_TOKEN" ]; then ENV_ARGS+=(--env GITHUB_TOKEN); fi

# Preserve the fast local `codex login` path without mounting the whole Codex
# home. The trusted controller copies this one file into a private model home
# before starting the agent; the model cannot read the source mount.
AUTH_MOUNTS=()
if [ -z "${JUROR_OPENAI_API_KEY:-}${OPENAI_API_KEY:-}" ]; then
  CODEX_AUTH_SOURCE="${CODEX_HOME:-$HOME/.codex}/auth.json"
  if [ -f "$CODEX_AUTH_SOURCE" ]; then
    CODEX_AUTH_SOURCE="$(realpath "$CODEX_AUTH_SOURCE")"
    AUTH_MOUNTS+=(--mount "type=bind,src=$CODEX_AUTH_SOURCE,dst=/run/auth.json,readonly")
    ENV_ARGS+=(--env CODEX_HOME=/run)
  fi
fi

docker network create "$EGRESS_NETWORK" >/dev/null
docker network create --internal "$INTERNAL_NETWORK" >/dev/null
docker run --detach --rm --init \
  --name "$PROXY_NAME" \
  --network "$EGRESS_NETWORK" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=32m \
  --user "$CONTAINER_USER" \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --pids-limit=128 \
  --memory=256m \
  --cpus=1 \
  --env JUROR_QA_EGRESS_ALLOW_B64="$EGRESS_ALLOW_B64" \
  --entrypoint node \
  "$IMAGE" \
  /opt/juror/qa/egress-proxy.mjs >/dev/null
docker network connect --gw-priority -1 "$INTERNAL_NETWORK" "$PROXY_NAME"
# Docker-in-Docker runners can route this private bridge while their embedded DNS
# fails to resolve container names and aliases. Read the already-created endpoint
# address from Docker itself, validate that it is private, and avoid that DNS path.
PROXY_URL="$(
  docker inspect \
    --format "{{(index .NetworkSettings.Networks \"$INTERNAL_NETWORK\").IPAddress}}" \
    "$PROXY_NAME" |
    node "$ROOT/qa/proxy-url.mjs"
)"
for _ in $(seq 1 40); do
  if docker logs "$PROXY_NAME" 2>&1 | grep -q 'juror-qa-egress-proxy ready'; then break; fi
  sleep 0.25
done
if ! docker logs "$PROXY_NAME" 2>&1 | grep -q 'juror-qa-egress-proxy ready'; then
  docker logs "$PROXY_NAME" >&2 || true
  echo 'Juror QA egress proxy did not become ready' >&2
  exit 1
fi

docker create \
  --name "$RUNTIME_NAME" \
  --init \
  --network "$INTERNAL_NETWORK" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --tmpfs "/home/pwuser:rw,nosuid,nodev,size=256m,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0700" \
  --shm-size=1g \
  --user "$CONTAINER_USER" \
  --cap-drop=ALL \
  --cap-add=SYS_CHROOT \
  --security-opt apparmor=unconfined \
  --security-opt "seccomp=$ROOT/qa/seccomp_profile.json" \
  --pids-limit=512 \
  --memory=4g \
  --cpus=2 \
  --mount "type=bind,src=$REPO_DIR,dst=/workspace,readonly" \
  ${SOURCE_GIT_MOUNTS[@]+"${SOURCE_GIT_MOUNTS[@]}"} \
  --mount "type=bind,src=$EVIDENCE_DIR,dst=/evidence" \
  ${RUNTIME_MOUNTS[@]+"${RUNTIME_MOUNTS[@]}"} \
  ${AUTH_MOUNTS[@]+"${AUTH_MOUNTS[@]}"} \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  --env "HTTP_PROXY=$PROXY_URL" \
  --env "HTTPS_PROXY=$PROXY_URL" \
  --env NODE_OPTIONS=--use-env-proxy \
  --env NODE_USE_ENV_PROXY=1 \
  --env "JUROR_QA_BROWSER_PROXY=$PROXY_URL" \
  "$IMAGE" \
  --repo-dir /workspace \
  --evidence-dir /evidence \
  ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} \
  ${RUNTIME_ARGS[@]+"${RUNTIME_ARGS[@]}"} >/dev/null
docker start --attach "$RUNTIME_NAME" &
RUNTIME_ATTACH_PID=$!
set +e
wait "$RUNTIME_ATTACH_PID"
RUNTIME_STATUS=$?
set -e
docker rm -f "$RUNTIME_NAME" >/dev/null 2>&1 || true
RUNTIME_ATTACH_PID=''
exit "$RUNTIME_STATUS"
