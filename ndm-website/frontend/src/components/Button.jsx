import { Link } from 'react-router-dom';

/**
 * Button — renders a <button>, or an <a>/<Link> when `href`/`to` is provided.
 * variant: 'primary' | 'ghost'
 */
export default function Button({
  variant = 'primary',
  to,
  href,
  className = '',
  children,
  type = 'button',
  ...rest
}) {
  const cls = `btn ${variant === 'ghost' ? 'btn-ghost' : 'btn-primary'} ${className}`.trim();

  if (to) {
    return (
      <Link to={to} className={cls} {...rest}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={cls} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}
