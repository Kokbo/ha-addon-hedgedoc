ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21

FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend-build
WORKDIR /build
COPY package.json package-lock.json ./
COPY rootfs/app/frontend ./rootfs/app/frontend
RUN npm ci && npm run build:frontend

FROM ${BUILD_FROM}

SHELL ["/bin/ash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
    nodejs \
    npm \
    sqlite-libs \
    tini \
  && apk add --no-cache --virtual .build-deps \
    g++ \
    make \
    python3

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && apk del .build-deps

COPY rootfs/app/backend ./backend
COPY --from=frontend-build /build/rootfs/app/frontend/dist ./frontend/dist
COPY rootfs/app/run.sh /run.sh

RUN chmod a+x /run.sh

EXPOSE 8099
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/run.sh"]
