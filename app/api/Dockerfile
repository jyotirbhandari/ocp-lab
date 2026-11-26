FROM registry.access.redhat.com/ubi9/nodejs-24

WORKDIR /opt/app-root/src

COPY --chown=1001:0 package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=1001:0 src ./src
COPY --chown=1001:0 migrations ./migrations
RUN chmod -R g=u /opt/app-root/src

USER 1001
EXPOSE 8080
CMD ["node", "src/server.js"]
