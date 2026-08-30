# Migrations

The base schema in `../config/schema.js` is idempotent (`CREATE TABLE IF NOT
EXISTS` plus `addColumnIfMissing`) and covers ordinary additive changes, so most
work needs no file here.

Add a migration when a change cannot be expressed that way:

- backfilling or rewriting existing rows,
- dropping or renaming a column,
- changing a type or a constraint on live data.

Name it `NNN-what-it-does.js`, ordered by number:

```js
'use strict';
module.exports = {
  async up(conn) {
    await conn.execute("UPDATE subscriptions SET seats = 1 WHERE seats IS NULL");
  },
};
```

`up(conn)` receives a transaction connection; throwing rolls the whole migration
back and stops the run. Applied names are recorded in `schema_migrations`, so
each file runs exactly once. Check what is pending with `npm run migrate -- --status`.
