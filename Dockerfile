FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.9
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm --filter @queuebridge/web bundle:check
RUN CI=true pnpm install --offline --prod --frozen-lockfile

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["sh", "infra/rumptycloud/node-with-db-ca.sh", "infra/rumptycloud/web.mjs"]
