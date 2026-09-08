FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bash libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/root
RUN curl -fsSL https://x.ai/cli/install.sh -o /tmp/install-grok.sh \
    && bash /tmp/install-grok.sh && rm /tmp/install-grok.sh \
    && export PATH=/root/.local/bin:/root/.grok/bin:$PATH \
    && install "$(command -v grok)" /usr/local/bin/grok
ENV PATH=/root/.local/bin:/root/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV GROK_DISABLE_AUTOUPDATER=1
WORKDIR /review
ENTRYPOINT ["grok"]
