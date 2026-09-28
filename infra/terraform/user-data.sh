#!/bin/bash
# First boot only. Everything the server needs that does not change per
# release: the container runtime and the directory releases land in.
# Releases themselves arrive through SSM - see infra/server/deploy.sh.
set -euxo pipefail

dnf install -y docker amazon-ecr-credential-helper

# AL2023 packages docker but not the compose plugin. Pinned rather than
# "latest", so two servers built a month apart run the same compose.
COMPOSE_VERSION=v5.5.1
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64"
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Pulls from ECR authenticate with the instance role through this helper,
# so there is no `docker login` and no registry password on disk.
mkdir -p /root/.docker
echo '{ "credsStore": "ecr-login" }' > /root/.docker/config.json

systemctl enable --now docker

mkdir -p /opt/porchlight/releases
chmod 700 /opt/porchlight
