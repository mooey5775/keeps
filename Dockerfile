# Keeps: one Node process serving the web client and the game server, with Midstrike to play against.
# Node 24 runs the TypeScript sources directly (type stripping), so only the web client needs a build step.
#
# Midstrike's network (packages/bot/weights/midstrike.bin) is committed and baked in. Its search and the round
# reviews run on a remote machine (gpu03's worker, which long-polls this server for work: packages/bot/src/remote,
# its password the REMOTE_TOKEN secret, its copy of the network the same file): this machine searches nothing
# (LOCAL_SEARCH=off), so while that machine is away the bot waits and the table is told. The admin pages' password
# is the ADMIN_TOKEN secret; analytics' key POSTHOG_KEY. Never in the image.

FROM node:24-slim AS build
RUN npm install -g pnpm@11.5.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/bot/package.json packages/bot/
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
COPY packages/bot/package.json packages/bot/
COPY packages/engine/package.json packages/engine/
COPY packages/learn/package.json packages/learn/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/table/package.json packages/table/
COPY packages/web/package.json packages/web/
# Only the server and its runtime dependencies (the engine, the protocol, the bot, the table's words, ws, posthog).
RUN pnpm install --frozen-lockfile --prod --filter "@keeps/server..."
COPY packages/bot/src packages/bot/src
COPY packages/bot/weights/midstrike.bin packages/bot/weights/midstrike.bin
COPY packages/engine/src packages/engine/src
COPY packages/protocol/src packages/protocol/src
COPY packages/server/src packages/server/src
COPY packages/table/src packages/table/src
COPY --from=build /app/packages/web/dist packages/web/dist

ENV NODE_ENV=production PORT=8080 KEEPS_DATA_DIR=/app/data LOCAL_SEARCH=off
EXPOSE 8080
CMD ["node", "packages/server/src/main.ts"]
