#!/bin/bash
# Creates test auth users for local development.
# Run after `supabase start`, before seeding.
#
# Usage: bash scripts/create-test-users.sh

API_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU}"
ANON_KEY="${SUPABASE_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0}"

create_user() {
  local id=$1 email=$2 password=$3
  echo "Creating $email ($id)..."
  curl -s -X POST "$API_URL/auth/v1/admin/users" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"$id\",\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  -> {d.get(\"id\",d.get(\"msg\",\"unknown\"))}')" 2>/dev/null || echo "  -> created"
}

echo "=== Creating test users ==="
create_user "11111111-1111-1111-1111-111111111111" "usera@test.com" "test123!"
create_user "22222222-2222-2222-2222-222222222222" "userb@test.com" "test123!"
create_user "33333333-3333-3333-3333-333333333333" "userc@test.com" "test123!"

echo ""
echo "=== Seeding data ==="
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/seed.sql

echo ""
echo "=== Done ==="
echo "Login credentials:"
echo "  User A: usera@test.com / test123!"
echo "  User B: userb@test.com / test123!"
echo "  User C: userc@test.com / test123!"
