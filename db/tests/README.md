# Testes dos scripts SQL

Rodam num Postgres local descartável, nunca no Supabase.

```bash
createdb tokenhub_test
psql -d tokenhub_test -v ON_ERROR_STOP=1 -f db/tests/supabase-shim.sql   # simula auth.uid() e os papéis do Supabase
psql -d tokenhub_test -v ON_ERROR_STOP=1 -f db/admin-setup.sql
psql -d tokenhub_test -v ON_ERROR_STOP=1 -f db/brlzx.sql
psql -d tokenhub_test -v ON_ERROR_STOP=1 -f db/brlzx.sql                 # de novo: confere que é idempotente
psql -d tokenhub_test -f db/tests/brlzx.test.sql
dropdb tokenhub_test
```

A última linha da saída deve ser `brlzx: todos os testes passaram`.
