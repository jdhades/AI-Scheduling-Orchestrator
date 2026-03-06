# ---------- BUILD STAGE ----------
FROM node:24.14.0-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn build

# ---------- PRODUCTION STAGE ----------
FROM node:24.14.0-alpine

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn install --production --frozen-lockfile

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/main.js"]