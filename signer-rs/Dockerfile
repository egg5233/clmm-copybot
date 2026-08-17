# Rust signer — multi-stage so the runtime image carries no toolchain.
#
# Build context is the repo root (see docker-compose.yml), because the workspace
# lives under signer-rs/ and Docker cannot COPY above its context.

FROM rust:1-bookworm AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Dependency layer: manifests only, with stub sources so `cargo fetch` and a
# throwaway `cargo build` populate the registry and compile every dependency.
# Neither is invalidated by a change to our own code, which is where nearly all
# of a rebuild's time would otherwise go.
COPY signer-rs/Cargo.toml signer-rs/Cargo.lock signer-rs/rust-toolchain.toml ./
COPY signer-rs/crates/signer-core/Cargo.toml crates/signer-core/
COPY signer-rs/crates/signer-daemon/Cargo.toml crates/signer-daemon/
RUN mkdir -p crates/signer-core/src crates/signer-daemon/src \
  && echo '//! placeholder' > crates/signer-core/src/lib.rs \
  && echo 'fn main() {}' > crates/signer-daemon/src/main.rs \
  && cargo fetch --locked \
  && cargo build --release --locked \
  && rm -rf crates/signer-core/src crates/signer-daemon/src

# Real sources.
#
# COPY preserves the build context's mtimes, so the real sources can land *older*
# than the stub build's artifacts — cargo then calls our crates fresh and the
# image ships the placeholder `fn main() {}`. Deleting our own fingerprints forces
# a rebuild regardless of mtimes, while leaving the cached dependency artifacts
# alone, which is the whole point of the layer above.
COPY signer-rs/clippy.toml ./
COPY signer-rs/crates ./crates
RUN rm -rf target/release/.fingerprint/signer-core-* target/release/.fingerprint/signer-daemon-* \
  && cargo build --release --locked --bin signer-daemon

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/signer-daemon /usr/local/bin/signer-daemon

# The socket directory is a volume shared with the bot container; the keyfile
# directory is mounted read-only from the host.
RUN mkdir -p /run/signer /keys

ENV SIGNER_SOCKET_PATH=/run/signer/signer.sock

CMD ["signer-daemon"]
