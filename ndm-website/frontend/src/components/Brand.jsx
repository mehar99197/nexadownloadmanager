import { Link } from 'react-router-dom';

export function BrandMark({ size = 40, className = '' }) {
  return (
    <img
      src="/nexa-logo-final.svg"
      alt=""
      width={size}
      height={size}
      className={`shrink-0 ${className}`.trim()}
      aria-hidden="true"
    />
  );
}

export default function Brand({ to = '/', compact = false, className = '' }) {
  return (
    <Link to={to} className={`brand-lockup ${className}`.trim()}>
      <BrandMark size={compact ? 34 : 42} />
      <span className="brand-wordmark">
        Nexa<span className="text-gradient">DownloadManager</span>
      </span>
    </Link>
  );
}
