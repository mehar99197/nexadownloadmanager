# Backend tests

```bash
npm test          # unit tests always; integration tests when a database is reachable
```

Two kinds live here:

| Kind | Files | Needs MySQL |
|------|-------|-------------|
| Unit | `config.test.js`, `jwt.test.js`, `license.test.js`, `releaseFeed.test.js`, `schemas.test.js` | no |
| Integration | `*.integration.test.js` | yes — **skipped** when absent |

The integration tests drive the real Express app against a real MySQL server,
because the risky part of this backend is the SQL itself: transactions, the
seat cap, webhook idempotency and timestamp handling. A stubbed database would
only prove the stub works. They caught two production bugs already — a schema
migration ordering error, and a timezone mismatch that stopped trials expiring.

## Running them locally

Any MySQL 8 will do. A throwaway instance, no root password, on port 3399:

```bash
mkdir -p /tmp/nexa-mysql/{data,run}
mysqld --initialize-insecure --datadir=/tmp/nexa-mysql/data --user="$(whoami)"
mysqld --datadir=/tmp/nexa-mysql/data --socket=/tmp/nexa-mysql/run/mysql.sock \
       --port=3399 --bind-address=127.0.0.1 --mysqlx=OFF --skip-log-bin \
       --user="$(whoami)" &

mysql --socket=/tmp/nexa-mysql/run/mysql.sock -u root -e "
  CREATE DATABASE ndm_test CHARACTER SET utf8mb4;
  CREATE USER 'ndm'@'%' IDENTIFIED BY 'test_password_at_least_16_chars';
  GRANT ALL ON ndm_test.* TO 'ndm'@'%';"

npm test
```

Or point them at any other server:

```bash
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=root MYSQL_PASS=secret \
MYSQL_DB=ndm_test npm test
```

### Windows, with nothing installed

Production runs **MariaDB 11.8**, and `test/tools/testdb.sh` stands up that
exact version from the portable zip — no installer, no administrator rights —
under `backend/.testdb/` (gitignored), on `127.0.0.1:3399` with the credentials
above already provisioned:

```bash
bash test/tools/testdb.sh up      # first run downloads ~95 MB, then unpacks, inits, starts
npm test                          # 0 skipped
bash test/tools/testdb.sh down    # stop; the data directory is kept for next time
bash test/tools/testdb.sh wipe    # stop and empty the database (the download is kept)
bash test/tools/testdb.sh purge   # stop and delete everything under .testdb
```

The suite must report **0 skipped**. A skip means no database was reachable,
and a green run with skips has not tested the HTTP or SQL layer at all.

Run it **twice** after touching anything that writes rows. The suites share one
database and `srv.reset()` truncates it between them, so a table missing from
that list passes on a fresh database and fails on the second run — which is how
`faq_votes` and `license_token_rejections` were found.

`test/helpers/testServer.js` fills in every other env var (test secrets, a
loopback admin allowlist) and truncates all tables between suites.

### In CI

`.github/workflows/website.yml` runs this suite on **every push to any branch**
that touches `ndm-website/`, against a `mariadb:11.8` service (production's
engine and version) on Node 22 (production's runtime). It reads the summary
line and fails the job unless the whole suite ran with **0 skipped** — so a
database service that quietly stops answering cannot turn into a green tick.
The frontend and admin panel are linted, tested and built in two parallel
jobs alongside it.

## Notes

- `RATE_LIMIT_DISABLED=1` lifts the rate limits so the suites can drive hundreds
  of requests from one address. `rateLimit.integration.test.js` deliberately does
  **not** set it, so the real limits are still tested. The flag is ignored when
  `NODE_ENV=production`.
- The test database is wiped by `srv.reset()`. Never point these at real data.
- **Run one integration suite at a time.** They all share the one database and
  each calls `srv.reset()`, which truncates every table — so two suites in
  parallel delete each other's rows mid-test and fail in scattered, misleading
  ways (a token 401ing immediately after a successful login is the usual
  symptom). `npm test` passes `--test-concurrency=1` and is safe; what is not
  safe is starting a second `node --test` run while one is still going.
