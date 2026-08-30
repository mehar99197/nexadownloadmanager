import { forwardRef } from 'react';
import { Link } from 'react-router-dom';

/**
 * Button — renders a <button>, or an <a>/<Link> when `href`/`to` is provided.
 * variant: 'primary' | 'ghost'. Forwards its ref so dialogs can focus it.
 */
const Button = forwardRef(function Button({
  variant = 'primary',
  to,
  href,
  className = '',
  children,
  type = 'button',
  ...rest
}, ref) {
  const cls = `btn ${variant === 'ghost' ? 'btn-ghost' : 'btn-primary'} ${className}`.trim();

  if (to) {
    return (
      <Link ref={ref} to={to} className={cls} {...rest}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a ref={ref} href={href} className={cls} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {children}
    </button>
  );
});

export default Button;
