import Section from '../components/Section';
import Button from '../components/Button';
import usePageMeta from '../hooks/usePageMeta';

export default function NotFound() {
  usePageMeta({ title: "Page not found", description: "The page you were looking for does not exist." });

  return (
    <Section className="text-center">
      <span className="eyebrow"><span className="eyebrow-dot" />Signal lost</span>
      <p className="text-7xl font-extrabold tracking-tight text-gradient sm:text-8xl">
        404
      </p>
      <h1 className="mt-4 text-2xl font-bold text-white sm:text-3xl">
        Page not found
      </h1>
      <p className="mx-auto mt-3 max-w-md text-zinc-400">
        The page you’re looking for doesn’t exist, was moved, or the link is
        broken.
      </p>
      <div className="mt-8 flex items-center justify-center gap-3">
        <Button to="/">Back home</Button>
        <Button to="/download" variant="ghost">
          Get the app
        </Button>
      </div>
    </Section>
  );
}
