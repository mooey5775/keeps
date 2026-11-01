# Keeps: one Node process serving the web client and the game server.
# Node 24 runs the TypeScript sources directly (type stripping), so only the
# web client needs a build step.

FROM node:24-slim AS build
RUN npm install -g pnpm@11.5.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/learn/package.json packages/learn/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/table/package.json packages/table/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter @keeps/web build

FROM node:24-slim
RUN npm install -g pnpm@11.5.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY packages/learn/package.json packages/learn/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/table/package.json packages/table/
COPY packages/web/package.json packages/web/
# Only the server and its runtime dependencies (the engine, the bot, the protocol, ws).
RUN pnpm install --frozen-lockfile --prod --filter "@keeps/server..."
COPY packages/engine/src packages/engine/src
COPY packages/learn/src packages/learn/src
COPY packages/learn/weights packages/learn/weights
COPY packages/protocol/src packages/protocol/src
COPY packages/server/src packages/server/src
COPY packages/table/src packages/table/src
COPY --from=build /app/packages/web/dist packages/web/dist

ENV NODE_ENV=production PORT=8080 KEEPS_DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "packages/server/src/main.ts"]
