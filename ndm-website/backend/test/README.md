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

`test/helpers/testServer.js` fills in every other env var (test secrets, a
loopback admin allowlist) and truncates all tables between suites.

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
