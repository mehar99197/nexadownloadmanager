import Button from './Button.jsx';

/**
 * Pagination — Prev/Next + page indicator.
 * Props: page (1-based), totalPages, onPageChange(nextPage).
 */
export default function Pagination({ page = 1, totalPages = 1, onPageChange }) {
  const canPrev = page > 1;
  const canNext = page < totalPages;

  if (!totalPages || totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-4 pt-4">
      <p className="text-sm text-admin-muted">
        Page <span className="text-admin-text">{page}</span> of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!canPrev}
          onClick={() => canPrev && onPageChange?.(page - 1)}
        >
          Prev
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canNext}
          onClick={() => canNext && onPageChange?.(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
