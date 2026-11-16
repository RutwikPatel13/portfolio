# syntax=docker/dockerfile:1

# The image that runs the portfolio on the home Pi (linux/arm64). It is built
# by GitHub Actions and only ever pulled on the Pi, so nothing here should
# assume build tools exist at run time.
#
# Debian slim rather than Alpine: sharp, which resizes every next/image
# request, ships a prebuilt glibc binary for arm64 and installs without a
# compiler.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Only the manifests, so this layer is reused until a dependency changes.
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# BUILD_STANDALONE is read by next.config.js. No secret is needed to build:
# Redis, the chat models and the GitHub card are all read per request, so no
# key is baked into the image.
ENV NEXT_TELEMETRY_DISABLED=1 \
    BUILD_STANDALONE=1
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
# HOSTNAME must be 0.0.0.0: Docker sets it to the container id, and the
# standalone server would then listen on that one address only instead of on
# every interface the tunnel container might reach it through.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Ties the package on ghcr.io to this repository.
LABEL org.opencontainers.image.source="https://github.com/RutwikPatel13/portfolio"
# The standalone output leaves these two folders out; the server expects them
# beside it.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# lib/blog.ts reads the posts from disk on each request, for the blog pages
# and for the chat assistant's blog tool, so the MDX has to travel with the
# server.
COPY --from=build --chown=node:node /app/content ./content
# The commit this image was built from, so /api/health can say what is
# running. It comes last because it changes on every build: anything after it
# could never be reused from the layer cache.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 3000
CMD ["node", "server.js"]
