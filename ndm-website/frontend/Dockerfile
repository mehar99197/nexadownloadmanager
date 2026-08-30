# Public site: built to static files, then served by the nginx image.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# VITE_* values are baked in at build time, so they are build args, not env vars.
ARG VITE_API_URL=/api
ARG VITE_SITE_URL=https://nexadownloadmanager.com
ARG VITE_PLAUSIBLE_DOMAIN=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_SITE_URL=$VITE_SITE_URL \
    VITE_PLAUSIBLE_DOMAIN=$VITE_PLAUSIBLE_DOMAIN
RUN npm run build

FROM alpine:3.20 AS dist
COPY --from=build /app/dist /dist
