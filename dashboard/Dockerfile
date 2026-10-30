FROM node:24-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
