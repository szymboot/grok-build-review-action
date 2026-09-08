#!/usr/bin/env bash
# Linux Docker regression using synthetic auth only; never mounts host credentials.
set -euo pipefail
image="${1:?Pass the locally built Grok image tag}"
work="$(mktemp -d)"
repro_tag="grok-permission-test:before-$$"
fixed_tag="grok-permission-test:after-$$"
cleanup() {
    rm -rf "$work"
    docker image rm "$repro_tag" "$fixed_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cat > "$work/Dockerfile" <<'DOCKERFILE'
ARG BASE=grok-review-local:dsc-701
FROM ${BASE} AS before
RUN mkdir -p /root/.grok && printf '{}' > /root/.grok/auth.json \
    && chmod 700 /root/.grok && chmod 600 /root/.grok/auth.json \
    && chown -R 1001:1001 /root/.grok
FROM before AS after
RUN chown 0:0 /root/.grok /root/.grok/auth.json
DOCKERFILE
docker build --platform linux/amd64 --build-arg "BASE=$image" --target before -t "$repro_tag" "$work" >/dev/null
docker build --platform linux/amd64 --build-arg "BASE=$image" --target after -t "$fixed_tag" "$work" >/dev/null
for variant in before after; do
    tag="$repro_tag"
    [[ "$variant" == after ]] && tag="$fixed_tag"
    set +e
    docker run --rm --platform linux/amd64 --network none --cap-drop ALL --security-opt no-new-privileges \
        "$tag" --single 'Return a review.' --output-format json --yolo \
        --no-subagents --disable-web-search --tools 'read_file,grep,list_dir' \
        --max-turns 1 --no-auto-update --cwd /review -m grok-4.6 --effort medium \
        > "$work/$variant.log" 2>&1
    code="$?"
    set -e
    [[ "$code" == 1 ]] || { echo "Unexpected $variant exit code: $code"; exit 1; }
done
grep -q 'Permission denied' "$work/before.log"
if grep -q 'Permission denied' "$work/after.log"; then
    echo 'Auth ownership fix did not remove permission failure'
    exit 1
fi
grep -q 'Not signed in' "$work/after.log"
echo 'PASS: runner-owned auth reproduces EACCES; root-owned auth reaches authentication without added capabilities.'
