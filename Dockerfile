FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

ARG USER_ID=1000
ARG GROUP_ID=1000
ARG NODE_MAJOR=24

# Install Node.js and the pi.dev coding agent.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        sudo \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @earendil-works/pi-coding-agent \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://claude.ai/install.sh | bash \
    && mv /root/.local/share/claude /usr/local/share/claude \
    && rm /root/.local/bin/claude \
    && ln -s "$(ls -d /usr/local/share/claude/versions/* | head -n1)" /usr/local/bin/claude \
    && chmod -R a+rX /usr/local/share/claude

RUN if ! getent group "${GROUP_ID}" >/dev/null; then \
        groupadd -g "${GROUP_ID}" developer; \
    fi \
    && if getent passwd "${USER_ID}" >/dev/null; then \
        existing_user="$(getent passwd "${USER_ID}" | cut -d: -f1)"; \
        if [ "${existing_user}" != developer ]; then \
            usermod -l developer -d /home/developer -m "${existing_user}"; \
        fi; \
        usermod -g "${GROUP_ID}" -s /bin/bash developer; \
    else \
        useradd -m -u "${USER_ID}" -g "${GROUP_ID}" -s /bin/bash developer; \
    fi \
    && echo 'developer ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/developer \
    && chmod 0440 /etc/sudoers.d/developer

USER developer

WORKDIR /home/developer

CMD ["bash"]
