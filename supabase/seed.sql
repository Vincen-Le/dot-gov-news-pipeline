-- The infrastructure bootstrap does not require seed data.

-- The auto-membership grant from CREATE ROLE gives postgres admin_option
-- on corpus_reader but not set_option (since corpus_reader is NOINHERIT),
-- so postgres cannot SET ROLE corpus_reader without this. Needed so the
-- local db admin connection (pgTAP tests, psql) can impersonate the role;
-- harmless since corpus_reader itself stays nologin/noinherit.
grant corpus_reader to postgres with set true;

-- extensions schema holds pgTAP's assertion functions (lives_ok, throws_ok);
-- other client roles (anon, authenticated, service_role) already have this,
-- and corpus_reader needs it so the pgTAP suite can impersonate it in tests.
grant usage on schema extensions to corpus_reader;
