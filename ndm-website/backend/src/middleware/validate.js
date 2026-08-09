'use strict';

const { ZodError } = require('zod');
const { fail } = require('../utils/respond');

// validate({ body?, query?, params? }) — parse each present part with its
// zod schema and assign the parsed (coerced/stripped) result back to req.
function validate(schemas) {
  return (req, res, next) => {
    try {
      for (const part of ['body', 'query', 'params']) {
        if (schemas[part]) {
          req[part] = schemas[part].parse(req[part]);
        }
      }
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return fail(res, 'VALIDATION_ERROR', 'Invalid input', 400, err.flatten());
      }
      return next(err);
    }
  };
}

module.exports = validate;
