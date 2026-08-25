# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Runtime — Playwright base image has all Chromium system deps
FROM mcr.microsoft.com/playwright:v1.52.0-noble
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
RUN npx patchright install chromium
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
