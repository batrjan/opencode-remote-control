# Build context: relay/  (e.g. `docker build -t relay-test relay/`)
#
# No `# syntax=` directive on purpose. It named `docker/dockerfile:1`, a tag its
# owner can move, and the frontend it names is fetched BEFORE the build starts
# and outside `--pull` — so the one link in this chain that was not pinned was
# also the one that ran first, on the production host, as the thing that parses
# everything below. Nothing here needs a frontend newer than the one BuildKit
# ships with (dockerfile.v0): no `RUN --mount`, no heredocs, no `COPY --link`,
# no `ADD --checksum`. `ARG` before `FROM` and `FROM ui-${UI_SOURCE}` are both
# builtin. Adding any of those back means pinning the directive BY DIGEST and
# bumping it by hand with NODE_IMAGE below, not restoring the tag.
#
# The image ships the compiled relay (dist/), production node_modules and the
# static viewer UI (public/). The UI is the official opencode web app build
# plus this repo's join page. Two ways to source it:
#
#   UI_SOURCE=prebuilt (default)
#     Copy relay/public from the build context. Locally this is the spike
#     build (assets are gitignored but present on disk after a UI build);
#     in CI the workflow can build the UI on the runner and stage it into
#     relay/public before `docker build`.
#
#   UI_SOURCE=source
#     Build the opencode web UI from the pinned upstream ref with bun in the
#     ui-source stage below (fully self-contained image build).
ARG UI_SOURCE=prebuilt

# The base image, by digest rather than by the `22-slim` tag. The deploy builds
# on the relay host, whose daemon answers a tag from whatever it cached the
# first time: 31 deploy logs over 11 days resolved the same base layer and not
# one of them pulled — so a Node or Debian patch had no path into production.
# One ARG for all three stages, so they cannot drift onto different bases.
#
# Refresh: read the digest the tag points at today, put it here, and the whole
# image rebuilds (which is also what re-runs the apt-get upgrade below). This is
# the ONLY way OS and Node patches reach production, so it is a scheduled job,
# not a reaction — monthly, and on any advisory naming the base (DEPLOY.md,
# "Base image"). Dependabot cannot do it: its docker updater reads literal FROM
# lines and does not resolve build args, and every stage here is FROM
# ${NODE_IMAGE}.
#   docker buildx imagetools inspect node:22-slim | head -2
# The relay host has no buildx plugin, and the registry answers the same thing:
#   T=$(curl -s 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull' | sed 's/.*"token":"\([^"]*\)".*/\1/')
#   curl -sI -H "Authorization: Bearer $T" \
#     -H 'Accept: application/vnd.oci.image.index.v1+json' \
#     https://registry-1.docker.io/v2/library/node/manifests/22-slim | grep -i docker-content-digest
# Current pin: node 22.23.2, pushed 2026-08-25, read 2026-09-18.
ARG NODE_IMAGE=node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

########## UI stage 1a: build opencode web UI from source ##########
FROM ${NODE_IMAGE} AS ui-source
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g bun@1.3.14
# Pinned to the exact upstream ref the viewer UI was spiked against
# (anomalyco/opencode, packages/app 1.18.29).
ARG OPENCODE_REPO=https://github.com/anomalyco/opencode
ARG OPENCODE_REF=bbd72fb8b0bb6de580d2041a0150016227c63ac0
WORKDIR /opencode
RUN curl -fsSL "$OPENCODE_REPO/archive/$OPENCODE_REF.tar.gz" \
  | tar -xz --strip-components=1
# @playwright/test is a devDependency of packages/app; the browsers are only
# needed for its e2e tests, not for `vite build` — skip the ~400MB download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --filter @opencode-ai/app
RUN cd packages/app && bun run build \
 && mkdir -p /public \
 && cp -r dist/. /public/
# The join page is ours, not part of the upstream dist.
COPY public/join.html /public/join.html

########## UI stage 1b: prebuilt UI from the build context ##########
FROM scratch AS ui-prebuilt
COPY public /public

########## UI selector (BuildKit skips the unreferenced stage) ##########
FROM ui-${UI_SOURCE} AS ui

########## Relay build ##########
FROM ${NODE_IMAGE} AS relay-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

########## Final image ##########
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080
# Two things the base image hands the runtime that it should not.
#
# Debian patches: the digest above freezes the OS as well as Node, and this
# upgrade is what makes the image current AS OF a bump — trivy found 225 OS
# CVEs (4 CRITICAL) in the image production was running. Until the next bump it
# then delivers nothing: no line above it changes, so the layer is a cache hit
# and the upgrade does not re-run, and the deploy keeps that cache on purpose
# (see .github/workflows/deploy.yml, which does not prune). A redeploy is
# therefore not a patch — bumping the digest above is (see DEPLOY.md, "Base
# image"). An install that wants every build patched adds an `ARG APT_REFRESH`
# immediately before this RUN and passes `--build-arg APT_REFRESH=$(date +%F)`,
# at the cost of a rebuild and a non-reproducible image.
#
# npm: 19 more findings, all inside the npm CLI that ships in the base
# (/usr/local/lib/node_modules/npm — tar 7.5.11, a CRITICAL gzip-bomb DoS,
# among them), while the app's own node_modules scanned clean. Nothing at
# runtime uses npm: the CMD and the HEALTHCHECK below are plain `node`, and
# the dependencies arrive as a copied node_modules from the build stage. So it
# is weight and attack surface only; corepack (a package manager shim, equally
# unused) goes with it.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=relay-build /app/package.json ./
COPY --from=relay-build /app/node_modules ./node_modules
COPY --from=relay-build /app/dist ./dist
COPY --from=ui /public ./public
# Session state lives here so a restart does not drop live shares. Created in
# the image (not by the volume driver) so it belongs to the unprivileged user
# the process runs as; compose mounts a named volume over it.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
# node:22-slim has no curl; use Node's global fetch instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
