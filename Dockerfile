# Simple container for the Slack ↔ Clay enricher bot
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
