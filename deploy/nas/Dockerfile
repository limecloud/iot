FROM node:24.21.0-bookworm-slim AS home
WORKDIR /source
COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY apps/home/package.json apps/home/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/control-ui/package.json packages/control-ui/package.json
RUN npm ci --ignore-scripts
COPY apps/home apps/home
COPY packages/control-ui packages/control-ui
COPY packages/protocol packages/protocol
COPY examples/companions examples/companions
COPY examples/compositions examples/compositions
RUN npm run build:home

FROM rust:1.93.1-bookworm AS gateway
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY gateway gateway
COPY tools/simulator tools/simulator
COPY tools/model-validator tools/model-validator
COPY contracts contracts
COPY deploy/dev/config.json deploy/dev/config.json
RUN cargo build -j 1 --workspace --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends mosquitto python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/limeiot
COPY --from=gateway /source/target/release/limeiot-gateway /usr/local/bin/limeiot-gateway
COPY --from=gateway /source/target/release/limeiot-simulator /usr/local/bin/limeiot-simulator
COPY --from=gateway /source/target/release/limeiot-model-validator /usr/local/bin/limeiot-model-validator
COPY --from=gateway /source/target/release/limeiot-ota /usr/local/bin/limeiot-ota
COPY --from=home /source/apps/home/dist home
COPY contracts/models models
COPY deploy/nas/entrypoint.py deploy/nas/healthcheck.py deploy/nas/device_identity.py ./
COPY LICENSE ./LICENSE
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LIMEIOT_LISTEN=0.0.0.0:17880 LIMEIOT_MQTT_HOST=127.0.0.1 LIMEIOT_MQTT_PORT=18884 LIMEIOT_HOME_DIR=/opt/limeiot/home LIMEIOT_CONFIG=/config/gateway.json LIMEIOT_DB=/data/gateway.sqlite LIMEIOT_TOKEN_FILE=/secrets/owner-token LIMEIOT_MQTT_PASSWORD_FILE=/secrets/gateway-password
USER 10001:10001
EXPOSE 17880 8883
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s CMD ["python3", "/opt/limeiot/healthcheck.py"]
ENTRYPOINT ["python3", "/opt/limeiot/entrypoint.py"]
CMD ["gateway"]
