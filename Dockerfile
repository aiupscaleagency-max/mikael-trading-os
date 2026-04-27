# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY dashboard.html ./

ENV NODE_ENV=production
ENV DASHBOARD_PORT=3939
EXPOSE 3939

CMD ["npx", "tsx", "src/run.ts"]
