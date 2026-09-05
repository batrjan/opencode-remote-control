# syntax=docker/dockerfile:1
#
# Build context: relay/  (e.g. `docker build -t relay-test relay/`)
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

########## UI stage 1a: build opencode web UI from source ##########
FROM node:22-slim AS ui-source
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
FROM node:22-slim AS relay-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

########## Final image ##########
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=relay-build /app/package.json ./
COPY --from=relay-build /app/node_modules ./node_modules
COPY --from=relay-build /app/dist ./dist
COPY --from=ui /public ./public
USER node
EXPOSE 8080
# node:22-slim has no curl; use Node's global fetch instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
