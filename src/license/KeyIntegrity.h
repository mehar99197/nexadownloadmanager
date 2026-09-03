#pragma once

namespace nexa::licensetoken {

/**
 * Whether the licence public key compiled into this binary is the one this
 * build was made with.
 *
 * The point: defeating Ed25519 is hard, but *replacing the public key* is easy
 * — swap those 32 bytes for your own and sign whatever licence you like with
 * the matching private half. That is by far the cheapest attack on everything
 * built on top of the signature, and it leaves the verifier itself untouched,
 * so no amount of care inside verify() would notice.
 *
 * This compares the embedded key against a digest CMake computed at build time
 * and stored in a separate translation unit. Swapping the key now means finding
 * and updating this too — two edits in two object files rather than one.
 *
 * Being honest about the limit: someone who can patch the key can patch this
 * check. It is one more thing to find, in a different object file, not a
 * barrier. It exists because the alternative — a single unguarded constant that
 * grants everything — is a much softer target.
 *
 * A build with no digest configured (a developer build) always returns true.
 */
bool publicKeyIntact();

} // namespace nexa::licensetoken
