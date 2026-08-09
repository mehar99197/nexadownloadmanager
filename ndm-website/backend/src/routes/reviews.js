'use strict';

const router = require('express').Router();

const Review = require('../models/Review');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { ok } = require('../utils/respond');
const { createReviewSchema, listReviewsQuerySchema } = require('../schemas/review.schema');

router.get(
  '/', validate(listReviewsQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, limit, rating } = req.query;
    const [reviews, totalCount, averageRating, ratingBreakdown] = await Promise.all([
      Review.listApproved({ page, limit, rating }),
      Review.count({ status: 'approved', rating }),
      Review.avgRating(),
      Review.ratingBreakdown(),
    ]);
    return ok(res, {
      reviews, page, limit, totalCount,
      averageRating: Math.round(averageRating * 100) / 100,
      ratingBreakdown,
    });
  })
);

router.post(
  '/', requireAuth, validate(createReviewSchema),
  asyncHandler(async (req, res) => {
    const { rating, comment } = req.body;
    const review = await Review.upsertByUserId(req.user.id, {
      userName: req.user.name, rating, comment,
    });
    return ok(res, review, 201);
  })
);

module.exports = router;
