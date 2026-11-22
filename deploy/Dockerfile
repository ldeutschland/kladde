FROM rust:1.100-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY vendor vendor
COPY apps/kladde/src-tauri apps/kladde/src-tauri
COPY server server
RUN cargo build --release --locked -p kladde-server
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin kladde && install -d -o kladde -g kladde -m 0700 /data
COPY --from=build /src/target/release/kladde-server /usr/local/bin/kladde-server
USER 10001:10001
ENV LISTEN_ADDR=0.0.0.0:7341 BLOB_DIR=/data/blobs OPAQUE_SETUP_FILE=/data/opaque.setup
ENTRYPOINT ["/usr/local/bin/kladde-server"]
