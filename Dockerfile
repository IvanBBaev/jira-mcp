# jira-mcp-ai container image (D520).
#
# The image runs the bytes npm serves: the build stage compiles with the
# publish config, packs the npm tarball and installs the production
# dependencies against the committed lockfile with install scripts off — the
# same recipe as the Claude Desktop bundle (D521, scripts/pack-mcpb.mjs).
#
# Build:  docker build -t jira-mcp-ai .
# Run:    docker run -i --rm --env-file ~/.config/jira-mcp-ai/.env jira-mcp-ai
#
# stdio is the default transport, so the client starts the container with `-i`
# and talks to it over stdin/stdout. For the http transport see the README
# (§Docker): it needs JIRA_HTTP_BIND=0.0.0.0 inside the container and
# `-p 127.0.0.1:<port>:<port>` outside it (D532).
#
# The base image is pinned by digest (the multi-arch index, so every platform
# resolves to the same tag snapshot). Bump the tag and the digest together.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.publish.json ./
COPY bin ./bin
COPY src ./src
COPY CHANGELOG.md LICENSE README.md ./
RUN npm run build:publish \
 && mkdir /pkg \
 && npm pack --pack-destination /pkg \
 && mkdir /app \
 && tar -xzf /pkg/*.tgz -C /app --strip-components=1 \
 && cp package-lock.json /app/ \
 && cd /app \
 && npm ci --omit=dev --ignore-scripts \
 && rm package-lock.json

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="jira-mcp-ai" \
      org.opencontainers.image.description="Jira Cloud MCP server with enforced safety: plan/apply writes, call-time project scope." \
      org.opencontainers.image.source="https://github.com/IvanBBaev/jira-mcp" \
      org.opencontainers.image.licenses="GPL-3.0-only"
ENV NODE_ENV=production
# Owned by root and read-only to the runtime user: the server never writes
# into its own install.
COPY --from=build --chown=root:root /app /app
# The unprivileged user the base image ships (uid 1000). Its home holds the
# config directory (~/.config/jira-mcp-ai) and any media/report directory a
# volume is mounted on.
USER node
WORKDIR /home/node
ENTRYPOINT ["node", "/app/bin/jira-mcp-ai.cjs"]
