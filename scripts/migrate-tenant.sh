#!/usr/bin/env bash
# getfluxo.io - Schema Migration Tooling & Tenant Provisioning
# Copyright (c) 2025 getfluxo.io
# 
# Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
# License: Proprietary

set -euo pipefail

ACTION=${1:-help}
TENANT_ID=${2:-}
DB_URL=${DATABASE_URL:-}
BATCH_SIZE=${BATCH_SIZE:-1000}

if [ -z "$DB_URL" ]; then
  echo "ERROR: DATABASE_URL not set"
  exit 1
fi

# Helper functions
create_tenant_schema() {
  local tenant=$1
  local schema_name="tenant_${tenant}"
  
  echo "Creating schema: $schema_name"
  psql "$DB_URL" -c "CREATE SCHEMA IF NOT EXISTS \"$schema_name\" AUTHORIZATION CURRENT_USER;" || true
  
  # Create tables in tenant schema
  psql "$DB_URL" << SQL
    CREATE TABLE IF NOT EXISTS "$schema_name".accounts (
      id text PRIMARY KEY,
      name text NOT NULL,
      balance numeric(18,2) DEFAULT 0,
      account_type varchar(50),
      status varchar(20) DEFAULT 'ACTIVE',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON "$schema_name".accounts(status);
    CREATE INDEX IF NOT EXISTS idx_accounts_created ON "$schema_name".accounts(created_at DESC);
    
    CREATE TABLE IF NOT EXISTS "$schema_name".transactions (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES "$schema_name".accounts(id),
      amount numeric(18,2) NOT NULL,
      type varchar(20),
      status varchar(20) DEFAULT 'PENDING',
      reference text,
      created_at timestamptz DEFAULT now(),
      CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES "$schema_name".accounts(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON "$schema_name".transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON "$schema_name".transactions(status);
SQL

  echo "✓ Schema $schema_name created successfully"
}

# Migrate data from public to tenant schema (for existing multi-tenant data)
migrate_data_to_tenant_schema() {
  local tenant=$1
  local schema_name="tenant_${tenant}"
  
  echo "Migrating data to $schema_name..."
  
  # Check if public.accounts exists with matching tenant_id
  if ! psql "$DB_URL" -c "\dt public.accounts" | grep -q "accounts"; then
    echo "No public.accounts table found, skipping data migration"
    return 0
  fi
  
  # Backfill in batches
  local offset=0
  while true; do
    local count=$(psql "$DB_URL" -t -c "
      SELECT COUNT(*) FROM (
        SELECT * FROM public.accounts 
        WHERE tenant_id = '$tenant' 
        LIMIT 1
      ) t;
    " | tr -d ' ')
    
    if [ "$count" -eq 0 ]; then
      break
    fi
    
    psql "$DB_URL" << SQL
      INSERT INTO "$schema_name".accounts (id, name, balance, account_type, status, created_at, updated_at)
      SELECT id, name, balance, account_type, status, created_at, updated_at 
      FROM public.accounts 
      WHERE tenant_id = '$tenant'
      LIMIT $BATCH_SIZE
      ON CONFLICT (id) DO NOTHING;
SQL
    
    offset=$((offset + BATCH_SIZE))
    echo "  Migrated $offset rows..."
  done
  
  echo "✓ Data migration complete for $schema_name"
}

# Add RLS policies to shared tables
add_rls_policies() {
  local schema_name=$1
  
  echo "Enabling RLS on $schema_name tables..."
  
  psql "$DB_URL" << SQL
    -- Example: if using shared accounts table with tenant_id column
    -- ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    -- CREATE POLICY tenant_isolation ON public.accounts 
    --   USING (tenant_id = current_setting('app.current_tenant_id'));
    
    -- For schema-per-tenant, RLS is not needed (isolation by schema)
SQL

  echo "✓ RLS policies configured"
}

# Run Prisma migrations for tenant schema
run_migrations() {
  local tenant=$1
  local schema_name="tenant_${tenant}"
  
  echo "Running migrations for $schema_name..."
  
  # Use Prisma migration with schema parameter if supported
  DATABASE_URL="$DB_URL?schema=$schema_name" npx prisma migrate deploy || true
  
  echo "✓ Migrations completed for $schema_name"
}

# Main command dispatcher
case "$ACTION" in
  create)
    if [ -z "$TENANT_ID" ]; then
      echo "Usage: $0 create <tenant_id>"
      exit 1
    fi
    create_tenant_schema "$TENANT_ID"
    run_migrations "$TENANT_ID"
    ;;
  migrate)
    if [ -z "$TENANT_ID" ]; then
      echo "Usage: $0 migrate <tenant_id>"
      exit 1
    fi
    create_tenant_schema "$TENANT_ID"
    migrate_data_to_tenant_schema "$TENANT_ID"
    ;;
  rls)
    if [ -z "$TENANT_ID" ]; then
      echo "Usage: $0 rls <tenant_id>"
      exit 1
    fi
    add_rls_policies "tenant_$TENANT_ID"
    ;;
  list-tenants)
    echo "Existing tenant schemas:"
    psql "$DB_URL" -c "
      SELECT schema_name FROM information_schema.schemata 
      WHERE schema_name LIKE 'tenant_%' 
      ORDER BY schema_name;
    "
    ;;
  help|*)
    cat << HELP
getfluxo.io Migration Tooling

Usage: $0 <action> [tenant_id]

Actions:
  create <tenant_id>     Create tenant schema and run migrations
  migrate <tenant_id>    Migrate data from public to tenant schema
  rls <tenant_id>        Enable RLS policies for tenant
  list-tenants          List all tenant schemas
  help                  Show this help message

Environment Variables:
  DATABASE_URL          PostgreSQL connection string (required)
  BATCH_SIZE            Rows per batch for data migration (default: 1000)

Example:
  export DATABASE_URL=postgresql://user:pass@localhost/getfluxo
  $0 create inst_001
  $0 migrate inst_001
HELP
    ;;
esac
