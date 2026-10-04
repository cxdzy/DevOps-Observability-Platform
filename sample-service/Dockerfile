FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./

EXPOSE 4000
USER node
CMD ["node", "--expose-gc", "index.js"]
