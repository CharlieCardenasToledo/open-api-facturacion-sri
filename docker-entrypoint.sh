#!/bin/sh
# =================================================
# Docker Entrypoint — Open API Facturación SRI
# =================================================
# Fixes bind-mount permissions then drops to appuser.
# Standard pattern for non-root containers with host volumes.
# =================================================
set -e

DATA_DIRS="/data/templates /data/pdfs /data/certs /data/xmls /data/pdfs/con_firma /data/pdfs/others /data/pdfs/documents /data/pdfs/images"

# Fix ownership of all data directories (bind mounts override Dockerfile chown)
for dir in $DATA_DIRS; do
  if [ -d "$dir" ]; then
    chown -R appuser:appgroup "$dir" 2>/dev/null || true
  fi
done

# Drop to appuser and execute the main command
exec su-exec appuser "$@"
