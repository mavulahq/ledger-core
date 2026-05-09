#!/usr/bin/env bash
set -euo pipefail

TENANT_ID=${1:-inst_0001}
PSQL=${PSQL:-psql}
DB_URL=${DATABASE_URL:-}

if [ -z "$DB_URL" ]; then
  echo "DATABASE_URL must be set"
  exit 1
fi

SCHEMA_NAME=tenant_${TENANT_ID}

echo "Creating schema $SCHEMA_NAME"
$PSQL "$DB_URL" -c "CREATE SCHEMA IF NOT EXISTS \"$SCHEMA_NAME\" AUTHORIZATION CURRENT_USER;"

# Example: create accounts table in tenant schema using ddl from migrations
$PSQL "$DB_URL" -c "CREATE TABLE IF NOT EXISTS \"$SCHEMA_NAME\".accounts (id text PRIMARY KEY, name text NOT NULL, balance numeric DEFAULT 0, created_at timestamptz DEFAULT now());"

echo "Schema $SCHEMA_NAME ready. Run tenant-specific migrations if needed."
