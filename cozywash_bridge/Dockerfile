FROM node:24-bookworm-slim
ARG BUILD_VERSION=1.1.1
ARG BUILD_ARCH
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.title="CozyWash Shelly Connector" \
      org.opencontainers.image.source="https://github.com/SeerKan/cw-relay"
WORKDIR /app
COPY bridge ./bridge
COPY options.mjs entrypoint.mjs ./
ENV NODE_ENV=production
# The entrypoint reads root-owned HA options and then drops UID/GID before networking.
CMD ["node", "entrypoint.mjs"]
