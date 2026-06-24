# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=25-bookworm-slim
ARG PNPM_VERSION=11.1.3

FROM node:${NODE_VERSION} AS deps
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

ARG PNPM_VERSION
RUN npm install --global pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/credentials/package.json packages/credentials/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/mcp-gateway/package.json packages/mcp-gateway/package.json
COPY packages/model-router/package.json packages/model-router/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
COPY packages/slack/package.json packages/slack/package.json
COPY packages/worker/package.json packages/worker/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_BEK_API_URL=http://localhost:4317
ARG VITE_BEK_ADMIN_API_TOKEN=
ENV VITE_BEK_API_URL=$VITE_BEK_API_URL
ENV VITE_BEK_ADMIN_API_TOKEN=$VITE_BEK_ADMIN_API_TOKEN

COPY . .
RUN pnpm --filter @bek/api... --filter @bek/web... --filter @bek/worker... build

FROM build AS app
ENV NODE_ENV=production
ENV BEK_API_PORT=4317
ENV BEK_WEB_PORT=5173
EXPOSE 4317 5173

FROM app AS api
CMD ["pnpm", "--filter", "@bek/api", "start"]

FROM app AS web
CMD ["sh", "-lc", "pnpm --filter @bek/web exec vite preview --host 0.0.0.0 --port ${BEK_WEB_PORT:-5173}"]

FROM app AS worker
CMD ["pnpm", "--filter", "@bek/worker", "local"]
