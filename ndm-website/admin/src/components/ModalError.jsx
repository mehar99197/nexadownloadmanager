/**
 * ModalError — an error shown INSIDE an open dialog.
 *
 * The pages keep one `error` string and used to render it only in the page
 * banner, which an open Modal sits on top of. A save that failed therefore
 * looked like a save that did nothing: the dialog stayed open with no reason
 * given, and the natural next move — pressing the button again — is exactly
 * wrong for a reply that was already stored. Rendering the same string here
 * puts the reason where the person is looking. role="alert" announces it.
 */
export default function ModalError({ children }) {
  if (!children) return null;
  return (
    <div role="alert" className="mb-4 rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">
      {children}
    </div>
  );
}
