#!/usr/bin/env bash
#
# The IN-CONTAINER half of the UI-image smoketest: run inside a booted
# cat-factory-executor-ui container, as the `harness` user, by scripts/smoketest-ui-image.sh.
#
# It exercises what the `tester-ui` flow actually does with this image, in miniature: build-tool
# availability, then `serve` a page and DRIVE it with a real Chromium, then stand WireMock up and
# talk to it. Version assertions are deliberately exact: the whole reason these tools are baked
# into the image is that a frontend repo must not have to install them, so a silently-absent or
# drifted one is the failure this catches.
#
# Every check prints what it found. A failure that only says "exit 1" makes the next person boot
# the image by hand to learn which tool was missing.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

check() {
  echo "  ok: $*"
}

echo "== identity =="
[ "$(whoami)" = "harness" ] || fail "expected to run as harness, got $(whoami)"
check "running as harness"
[ "${HOME}" = "/home/harness" ] || fail "expected HOME=/home/harness, got ${HOME}"
check "HOME=${HOME}"

# The regression the Dockerfile's HOME juggling exists for. The base image sets
# HOME=/home/harness at its end, so a root `npm install -g` in a layer on top seeds a ROOT-OWNED
# ~/.npm, and the harness user then hits EACCES on the first frontend install of the first job.
# Nothing about the image build fails, so only this check finds it.
echo "== no root-owned state in the harness home =="
root_owned="$(find /home/harness -user root -print -quit 2>/dev/null || true)"
[ -z "${root_owned}" ] || fail "root-owned path in the harness home: ${root_owned} (see Dockerfile.ui's HOME handling)"
check "nothing under /home/harness is owned by root"
# Positive control: the user can actually write the npm cache it will use.
npm config set cache /home/harness/.npm >/dev/null
touch /home/harness/.npm/.smoketest-write 2>/dev/null || fail "cannot write /home/harness/.npm as harness"
rm -f /home/harness/.npm/.smoketest-write
check "the npm cache is writable by harness"

echo "== package managers =="
pnpm_version="$(pnpm --version)"
[ "${pnpm_version}" = "${EXPECT_PNPM}" ] || fail "pnpm ${pnpm_version}, expected ${EXPECT_PNPM}"
check "pnpm ${pnpm_version}"
yarn_version="$(yarn --version)"
[ "${yarn_version}" = "${EXPECT_YARN}" ] || fail "yarn ${yarn_version}, expected ${EXPECT_YARN}"
check "yarn ${yarn_version}"
npm --version >/dev/null || fail "npm missing (it comes from the base image)"
check "npm $(npm --version)"

echo "== the static server + a real browser =="
site="$(mktemp -d)"
cat > "${site}/index.html" <<'HTML'
<!doctype html>
<title>ui-image-smoketest</title>
<h1 id="marker">served-and-rendered</h1>
HTML
# `serve` is what the harness uses for `serveMode: 'static'`. Bound to loopback like the real
# flow, on the port frontend-infra.ts defaults to.
serve --no-clipboard --listen 4173 "${site}" >/tmp/serve.log 2>&1 &
serve_pid=$!
trap 'kill "${serve_pid}" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:4173/" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:4173/" >/dev/null || { cat /tmp/serve.log >&2; fail "serve never answered on 4173"; }
check "serve answered on 127.0.0.1:4173"

# The load-bearing one: Chromium must LAUNCH from the baked browser path and render the served
# page. A `playwright --version` alone passes on an image whose browser download never happened,
# which is exactly the state a broken install layer leaves behind.
cat > /tmp/drive.mjs <<'MJS'
import { chromium } from 'playwright'

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load' })
  const text = await page.textContent('#marker')
  if (text !== 'served-and-rendered') {
    throw new Error(`rendered marker was ${JSON.stringify(text)}`)
  }
  // The tester's actual product: a full-page PNG. A launch that renders but cannot screenshot
  // would still fail every real job.
  const shot = await page.screenshot({ fullPage: true, type: 'png' })
  if (shot.length < 1000 || shot[0] !== 0x89 || shot[1] !== 0x50) {
    throw new Error(`screenshot was not a plausible PNG (${shot.length} bytes)`)
  }
  console.log(`  ok: chromium rendered the page and captured ${shot.length} bytes of PNG`)
} finally {
  await browser.close()
}
MJS
# `playwright` is installed globally in the image, so resolve it from the global root rather than
# a node_modules the checkout would have supplied.
NODE_PATH="$(npm root -g)" node /tmp/drive.mjs || fail "Playwright could not drive Chromium against the served page"

echo "== WireMock (the mocked upstreams) =="
[ -n "${WIREMOCK_JAR:-}" ] || fail "WIREMOCK_JAR is not set in the image env"
[ -s "${WIREMOCK_JAR}" ] || fail "WIREMOCK_JAR points at ${WIREMOCK_JAR}, which is missing or empty"
check "WIREMOCK_JAR=${WIREMOCK_JAR}"
java -version 2>&1 | head -1 | sed 's/^/  ok: /'
java -jar "${WIREMOCK_JAR}" --port 8089 --root-dir /tmp/wiremock >/tmp/wiremock.log 2>&1 &
wiremock_pid=$!
trap 'kill "${serve_pid}" "${wiremock_pid}" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:8089/__admin/mappings" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:8089/__admin/mappings" >/dev/null || {
  cat /tmp/wiremock.log >&2
  fail "WireMock never answered on 8089"
}
check "WireMock answered on 127.0.0.1:8089"

echo "ALL UI-IMAGE CHECKS PASSED"
