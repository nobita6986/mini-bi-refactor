FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV SUPABASE_SECRET_KEY=build-placeholder
ENV DIRECT_ENTRY_API_ENABLED=false
ENV PIPELINE_CHECK_ENABLED=false
ENV AI_REPORTS_ENABLED=false
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "--max-http-header-size=32768", "server.js"]

FROM deps AS migrations
ENV NODE_ENV=production
COPY scripts/apply-migrations.mjs ./scripts/apply-migrations.mjs
COPY scripts/lib/load-supabase-config.mjs ./scripts/lib/load-supabase-config.mjs
COPY scripts/lib/migration-validation.mjs ./scripts/lib/migration-validation.mjs
COPY scripts/lib/supabase-tls.mjs ./scripts/lib/supabase-tls.mjs
COPY supabase/migrations ./supabase/migrations
COPY supabase/certs ./supabase/certs
ENTRYPOINT ["node", "scripts/apply-migrations.mjs"]
