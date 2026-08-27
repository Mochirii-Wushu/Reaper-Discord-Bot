# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf

ARG BUN_IMAGE="oven/bun:1.3.14-distroless@sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307"
ARG NODE_IMAGE="gcr.io/distroless/nodejs22-debian13:nonroot@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167"

FROM ${BUN_IMAGE} AS development-dependencies
WORKDIR /opt/reaper
COPY package.json bun.lock ./
RUN ["/usr/local/bin/bun", "install", "--frozen-lockfile", "--ignore-scripts"]

FROM ${BUN_IMAGE} AS production-dependencies
WORKDIR /opt/reaper
COPY package.json bun.lock ./
RUN ["/usr/local/bin/bun", "install", "--frozen-lockfile", "--production", "--ignore-scripts"]

FROM development-dependencies AS build
ARG BUILD_DATE
ARG VERSION
ARG VCS_REF
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN ["/usr/local/bin/bun", "-e", "for (const name of ['BUILD_DATE', 'VERSION']) { if (!process.env[name]) throw new Error(`${name} is required`); } if (!/^[0-9a-f]{40}$/.test(process.env.VCS_REF ?? '')) throw new Error('VCS_REF must be a full lowercase commit SHA');"]
RUN ["/usr/local/bin/bun", "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]
RUN ["/usr/local/bin/bun", "-e", "const { existsSync } = require('node:fs'); for (const path of ['dist/index.js', 'dist/healthcheck.js']) { if (!existsSync(path)) throw new Error(`${path} is missing`); }"]

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

ENV NODE_ENV=production \
    REAPER_HEALTH_STATE_PATH=/tmp/mochirii-reaper-readiness.json \
    REAPER_HEALTH_HEARTBEAT_MS=30000 \
    REAPER_HEALTH_MAX_AGE_MS=90000
WORKDIR /opt/reaper
COPY --from=build --chown=65532:65532 /opt/reaper/dist ./dist
COPY --from=production-dependencies --chown=65532:65532 /opt/reaper/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./package.json

USER 65532:65532
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/nodejs/bin/node", "dist/healthcheck.js"]
ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]
