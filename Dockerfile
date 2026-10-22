FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY scripts/patch_capacitor_cli.cjs ./scripts/patch_capacitor_cli.cjs
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY --from=build /app/www ./www
EXPOSE 3000
CMD ["npm", "start"]
