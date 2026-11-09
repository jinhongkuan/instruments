# The pipeline CLI as a container: one image, one Cloud Run job per command.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@instruments/pipeline..."
WORKDIR /app/packages/pipeline
ENV NODE_ENV=production
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
