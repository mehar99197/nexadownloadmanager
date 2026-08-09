import { Link } from 'react-router-dom';
import Button from '../components/Button.jsx';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-6xl font-bold text-admin-accent">404</p>
      <h1 className="text-xl font-semibold text-admin-text">Page not found</h1>
      <p className="max-w-sm text-sm text-admin-muted">
        The page you are looking for doesn’t exist or has been moved.
      </p>
      <Link to="/dashboard">
        <Button variant="primary">Back to dashboard</Button>
      </Link>
    </div>
  );
}
