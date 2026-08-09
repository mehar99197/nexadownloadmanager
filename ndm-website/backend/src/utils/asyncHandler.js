'use strict';

// Wrap async route handlers so rejected promises reach Express's errorHandler.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
