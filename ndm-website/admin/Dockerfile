# Admin panel: same static-build approach, served under /admin/.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM alpine:3.20 AS dist
COPY --from=build /app/dist /dist
