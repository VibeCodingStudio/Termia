FROM ubuntu:24.04

# The minimal base has no CA roots; apt signatures remain verified while they are bootstrapped.
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
  && apt-get -o Acquire::https::Verify-Peer=false update \
  && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-client openssh-server \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash termia

COPY entrypoint.sh /usr/local/bin/termia-ssh-entrypoint
RUN chmod 0755 /usr/local/bin/termia-ssh-entrypoint

ENTRYPOINT ["/usr/local/bin/termia-ssh-entrypoint"]
