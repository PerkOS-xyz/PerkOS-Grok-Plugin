# The guest seat holder. Small on purpose: it keeps websockets open and answers
# MCP calls, nothing else.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
ENV PORT=8791 BIND=0.0.0.0
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8791/healthz > /dev/null || exit 1
CMD ["node", "server/mcp.mjs"]
