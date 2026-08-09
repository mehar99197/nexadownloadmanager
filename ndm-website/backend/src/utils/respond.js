'use strict';

// Standard response envelope helpers.
// Success: { ok:true, data }
// Error:   { ok:false, error:{ code, message, details? } }
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function fail(res, code, message, status = 400, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ ok: false, error });
}

module.exports = { ok, fail };
