# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf

ARG BUN_IMAGE="oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04"
ARG NODE_IMAGE="node:22.23.2-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46"

FROM ${BUN_IMAGE} AS development-dependencies
WORKDIR /opt/reaper
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM ${BUN_IMAGE} AS production-dependencies
WORKDIR /opt/reaper
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM development-dependencies AS build
ARG BUILD_DATE
ARG VERSION
ARG VCS_REF
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN test -n "${BUILD_DATE}" \
    && test -n "${VERSION}" \
    && test -n "${VCS_REF}" \
    && printf '%s' "${VCS_REF}" | grep -Eq '^[0-9a-f]{40}$' \
    && bun run build \
    && test -f dist/index.js \
    && test -f dist/healthcheck.js

FROM ${NODE_IMAGE} AS runtime
ARG BUILD_DATE
ARG VERSION
ARG VCS_REF
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.description="Persistent Mōchirīī Discord Gateway worker" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/Mochirii-Wushu/Reaper-Discord-Bot" \
      org.opencontainers.image.title="Mōchirīī Reaper Gateway worker" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production
WORKDIR /opt/reaper
COPY --from=production-dependencies --chown=node:node /opt/reaper/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/reaper/dist ./dist
COPY --chown=node:node package.json ./package.json

USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["node", "dist/index.js"]
