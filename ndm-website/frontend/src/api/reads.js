import api, { unwrap } from './client';

/**
 * The last answer to each public read, kept for the life of the tab.
 *
 * Every page that shows data asked for it again on every visit, so going
 * back to a page already seen drew its skeleton and then its content all over
 * again, a few hundred milliseconds apart. Worse, Back could not return the
 * reader to where they had been: the scroll position was restored onto the
 * skeleton, which is a different height from the content that replaced it.
 * With the last answer kept, a revisit draws the real content in its first
 * frame and asks again underneath (stale-while-revalidate); a changed answer
 * simply updates in place.
 *
 * Public reads only — plans, releases, reviews, stats. Nothing that belongs
 * to an account is kept here, so there is nothing to forget on sign-out.
 */
const answers = new Map();

function keyOf(url, params) {
  if (!params) return url;
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([name, value]) => [name, String(value)]),
  ).toString();
  return query ? `${url}?${query}` : url;
}

/** What this tab last got for a public read, or undefined if it has not asked yet. */
export const lastRead = (url, params) => answers.get(keyOf(url, params));

/** GET a public read, keep the answer, and return it unwrapped. */
export async function readPublic(url, params) {
  const res = params ? await api.get(url, { params }) : await api.get(url);
  const data = unwrap(res);
  answers.set(keyOf(url, params), data);
  return data;
}

/** An answer that no longer holds — a release withdrawn, so /latest now says 404. */
export const forgetRead = (url, params) => {
  answers.delete(keyOf(url, params));
};

/** For tests, which render the same page against different answers. */
export const forgetAllReads = () => answers.clear();
