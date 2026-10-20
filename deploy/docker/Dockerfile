# Release artifact, not a checkout of upstream source. No credentials or host-specific paths.
FROM debian:bookworm-slim
ARG VERSION=2026.10.0
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar unzip coreutils && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$TARGETARCH" in amd64) platform=x64;; arm64) platform=arm64;; *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1;; esac; \
    base="https://github.com/Jhacarreiro/AgentHydra-Community/releases/download/v${VERSION}"; \
    artifact="AgentHydra-${VERSION}-linux-${platform}.tar.gz"; \
    curl -fsSL --retry 3 -o /tmp/SHA256SUMS.txt "$base/SHA256SUMS.txt"; \
    curl -fsSL --retry 3 -o "/tmp/$artifact" "$base/$artifact"; \
    cd /tmp && grep -F "  $artifact" SHA256SUMS.txt | sha256sum -c -; \
    mkdir -p /opt/agenthydra && tar -xzf "$artifact" -C /opt/agenthydra --strip-components=1; \
    rm -f "/tmp/$artifact" /tmp/SHA256SUMS.txt
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin hydra && chown -R hydra:hydra /opt/agenthydra
USER hydra
WORKDIR /opt/agenthydra
# Resolve/download the version-pinned Bun runtime when the image is built, not on first start.
RUN ./agenthydra --ensure-bun
ENV HOME=/srv/agenthydra-state AGENTHYDRA_HOME=/srv/agenthydra-state/.agenthydra PORT=7787 AGENTHYDRA_PORT_FIXED=1
EXPOSE 7787
CMD ["./agenthydra"]
