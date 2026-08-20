# syntax=docker/dockerfile:1.7
# Multi-architecture Playwright base. Release automation replaces/validates this digest.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS build

USER root
WORKDIR /opt/juror

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS runtime

USER root
WORKDIR /opt/juror

# Dependency installation is independent of application source, so rebuilding
# after a controller edit only recompiles TypeScript and copies the dist layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm install -g @openai/codex@0.147.0 --ignore-scripts --no-audit --no-fund

COPY --from=build --chown=pwuser:pwuser /opt/juror/dist ./dist
COPY --chown=pwuser:pwuser qa/egress-proxy.mjs qa/tls-client-hello.mjs qa/smoke-chromium.mjs ./qa/
RUN chown pwuser:pwuser /opt/juror

ENV NODE_ENV=production \
    JUROR_CODEX_BIN=/usr/bin/codex \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/home/pwuser

USER pwuser
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/juror/dist/cli.js", "qa"]
