import { Link } from 'react-router-dom';

export function BrandMark({ size = 40, className = '' }) {
  return (
    <img
      src="/nexa-logo-final.svg"
      alt=""
      width={size}
      height={size}
      className={`brand-mark shrink-0 ${className}`.trim()}
      aria-hidden="true"
    />
  );
}

export default function Brand({ to = '/', compact = false, className = '' }) {
  return (
    <Link to={to} className={`brand-lockup ${className}`.trim()}>
      <BrandMark size={compact ? 34 : 42} />
      <span className="brand-wordmark">
        <span className="brand-name">Nexa</span>
        <span className="brand-product">DownloadManager</span>
      </span>
    </Link>
  );
}
