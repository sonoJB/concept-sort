# syntax=docker/dockerfile:1
#
# Production image of the concept-sort service (Railway builds this file; see railway.toml).
# In addition to the Next.js app it contains what the analysis -> ZIP pipeline needs on the server: Python with the pinned
# package-builder dependencies (numpy, matplotlib, XlsxWriter, python-docx, PyMuPDF) and the Noto Sans CJK fonts for the
# Korean figures and PDF reports. The volume (/data, DATABASE_URL=file:/data/prod.db) is mounted by the platform at run time.

FROM node:22-bookworm-slim AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- build the app
FROM base AS build
WORKDIR /app
# the commit embedded by next.config.ts (APP_BUILD_COMMIT) comes from Railway's variable at build time
ARG RAILWAY_GIT_COMMIT_SHA
ARG GIT_COMMIT_SHA
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA GIT_COMMIT_SHA=$GIT_COMMIT_SHA
# prisma generate / next build only need a syntactically valid URL; no database is read at build time
ENV DATABASE_URL="file:/tmp/build.db"
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv fonts-noto-cjk fontconfig && rm -rf /var/lib/apt/lists/*
COPY scripts/package/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/pkgvenv && /opt/pkgvenv/bin/pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PACKAGE_BUILDER_PYTHON=/opt/pkgvenv/bin/python \
    PYTHONUTF8=1
EXPOSE 3000
# same start command as before: pre-migrate backup guard, prisma migrate deploy, next start
CMD ["npm", "start"]
