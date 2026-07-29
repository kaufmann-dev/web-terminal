FROM quay.io/centos/centos:stream10

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /app

RUN dnf --assumeyes update \
    && dnf --assumeyes install dnf-plugins-core epel-release \
    && dnf config-manager --set-enabled crb \
    && dnf --assumeyes --setopt=install_weak_deps=False install \
      bash-completion \
      bind-utils \
      ca-certificates \
      cage \
      chezmoi \
      chromium \
      curl \
      fd-find \
      fontconfig \
      fuse-overlayfs \
      fzf \
      gcc \
      gcc-c++ \
      gh \
      git \
      git-filter-repo \
      glibc-langpack-en \
      iproute \
      iputils \
      jq \
      less \
      libX11-devel \
      libXcursor-devel \
      libXi-devel \
      libXinerama-devel \
      libXrandr-devel \
      libXtst-devel \
      libxkbcommon-devel \
      lsof \
      make \
      mesa-dri-drivers \
      mesa-libGL-devel \
      mesa-vulkan-drivers \
      micro \
      nodejs24 \
      nodejs24-npm \
      openssh-clients \
      passt \
      perl-podlators \
      pkgconf-pkg-config \
      podman \
      procps-ng \
      python3 \
      ripgrep \
      rsync \
      shadow-utils \
      shadow-utils-subid \
      tar \
      tree \
      unzip \
      util-linux \
      uv \
      vulkan-loader-devel \
      which \
      xorg-x11-server-Xwayland \
      xorg-x11-xauth \
      xwayland-run \
      yq \
      zip \
    && ln --symbolic /usr/bin/node-24 /usr/local/bin/node \
    && ln --symbolic /usr/bin/npm-24 /usr/local/bin/npm \
    && ln --symbolic /usr/bin/npx-24 /usr/local/bin/npx \
    && node --version | grep --extended-regexp --quiet '^v24\.' \
    && sed --regexp-extended --in-place \
      's/^[[:space:]]*Compositor[[:space:]]*=.*$/    Compositor = cage/' \
      /usr/share/wlheadless/wlheadless.conf \
    && python3 -c \
      'from configparser import ConfigParser; import sys; config = ConfigParser(); config.read(sys.argv[1]); sys.exit("wlheadless default compositor is not cage") if config.defaults().get("compositor") != "cage" else None' \
      /usr/share/wlheadless/wlheadless.conf \
    && dnf clean all \
    && rm -rf -- /var/cache/dnf

COPY scripts/install-xdotool.sh /tmp/install-xdotool.sh
RUN bash /tmp/install-xdotool.sh \
    && rm -- /tmp/install-xdotool.sh

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && node -e 'require("node-pty")' \
    && ./node_modules/.bin/agent-browser --version \
    && ./node_modules/.bin/opencode --version \
    && npm cache clean --force

COPY . .

RUN bash scripts/install-git-wrangler.sh \
    && bash scripts/install-nixpacks.sh \
    && bash scripts/install-rootless-podman.sh

ENV NODE_ENV=production
ENV FONTCONFIG_FILE="/etc/fonts/fonts.conf"
ENV FONTCONFIG_PATH="/etc/fonts"
ENV LIBGL_DRIVERS_PATH="/usr/lib64/dri"
ENV PATH="/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV XDG_DATA_DIRS="/usr/local/share:/usr/share"

CMD ["bash", "scripts/start.sh"]
