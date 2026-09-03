#pragma once

#include <array>
#include <functional>

namespace nexa::guard {

// The independent checks the guard combines. Every one is a cheap,
// side-effect-free query that re-derives ground truth from the signed token and
// the compiled-in public key — never a heuristic — so no legitimate user can
// ever fail one. TRUE means what the name says.
//
// They are deliberately redundant and differently shaped. `LivePaid` and
// `CachedGrace` overlap with `SignedGrant`; `KeyIntact` overlaps with the key
// check already inside verification. The point of a decoy is that patching the
// one obvious gate leaves the others standing.
enum Slot {
    KeyIntact = 0,    // the embedded public key is the one this build shipped with
    LivePaid,         // a valid, unexpired, device-bound paid token is held right now
    CachedGrace,      // the cached token still grants a paid plan inside offline grace
    MemoryClaimsPaid, // the in-memory plan/entitlements currently say paid
    SignedGrant,      // a validly-signed, device-bound paid token EXISTS (ignoring
                      // expiry/grace) — the fact a real customer always has and a
                      // patched "paid" state never does
    SlotCount
};

using Check = std::function<bool()>;
using Checks = std::array<Check, SlotCount>;

struct Result {
    // The install may use paid entitlements right now.
    //   paid = KeyIntact && (LivePaid || CachedGrace)
    bool paid = false;

    // The in-memory state claims paid but no signature backs it — the signature
    // of tampering, not of an expired grace window (a lapsed-but-real customer
    // still has SignedGrant). A canary, not an immediate action: the caller
    // records it and lets scattered checks fold quietly to Free later.
    //   tamper = !paid && MemoryClaimsPaid && !(KeyIntact && SignedGrant)
    bool tamper = false;
};

// Run the checks and combine them. In a hardened build the checks execute in a
// seed-chosen order inside a flattened dispatch, their results are carried as
// masked words, and the branches are wrapped in opaque predicates; in a plain
// build it is a straight loop. Both funnel through the same `combine()`, so the
// answer is identical — GuardTest proves it across every input combination.
Result evaluate(const Checks &checks);

} // namespace nexa::guard
