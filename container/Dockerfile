FROM oven/bun

# toolset
RUN apt-get update -qq && \
  apt install -y \
    curl zip git less jq yq nano vim procps man-db gh \
    ripgrep fd-find bat findutils coreutils sed gawk \
    && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

# agents
RUN curl -fsSL https://opencode.ai/install | bash
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN bun i -g \
  @openai/codex \
  @mariozechner/pi-coding-agent

COPY entrypoint.sh /
ENTRYPOINT ["/entrypoint.sh"]
