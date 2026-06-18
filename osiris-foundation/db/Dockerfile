# ─────────────────────────────────────────────────────────────
#  OSIRIS Foundry DB — PostgreSQL 16 + pgvector + Apache AGE
#  One Postgres that does relational + vector + graph.
#  Base already ships pgvector; we compile Apache AGE on top.
# ─────────────────────────────────────────────────────────────
FROM pgvector/pgvector:pg16

ARG AGE_BRANCH=release/PG16/1.5.0

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        git build-essential flex bison \
        postgresql-server-dev-16 \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${AGE_BRANCH} https://github.com/apache/age.git /tmp/age \
    && cd /tmp/age \
    && make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config \
    && make install PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config \
    && rm -rf /tmp/age

# AGE must be preloaded so its operators/functions are available everywhere.
# (init SQL still runs CREATE EXTENSION + LOAD for each session that needs it.)
RUN echo "shared_preload_libraries = 'age'" >> /usr/share/postgresql/postgresql.conf.sample

USER postgres
