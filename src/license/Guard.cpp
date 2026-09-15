#include "license/Guard.h"
#include "license/Obfuscation.h"

namespace nexa::guard {

namespace {

// The single source of truth for what the checks MEAN. Both the plain and the
// obfuscated path fill `r` with the same five booleans and then call this, so
// the two can never drift: the obfuscation changes how the answer is computed,
// never what it is.
//
// paid   = KeyIntact && (LivePaid || CachedGrace)
// tamper = !paid && MemoryClaimsPaid && !(KeyIntact && SignedGrant)
//
// The `!paid` term makes paid and tamper mutually exclusive for EVERY input, so
// a genuinely granted install can never latch the canary — the safety property
// that matters most, and one that must not depend on how the predicates happen
// to be wired. In practice a live/cached paid token always implies a signed
// grant exists, so `!paid` changes nothing for real inputs; it just closes the
// door on any future predicate that violated that.
Result combine(const bool (&r)[SlotCount])
{
    Result out;
    out.paid = r[KeyIntact] && (r[LivePaid] || r[CachedGrace]);
    out.tamper = !out.paid
        && r[MemoryClaimsPaid] && !(r[KeyIntact] && r[SignedGrant]);
    return out;
}

} // namespace

#ifdef NEXA_OBFUSCATE_LICENSE

Result evaluate(const Checks &checks)
{
    // The order in which the checks run — a compile-time permutation of the
    // slots derived from this build's rotation seed. The checks are
    // side-effect free, so the order never changes the result; it changes the
    // instruction sequence a disassembler sees, per release.
    constexpr auto order = obf::permutation<SlotCount>(obf::seedAt(7));

    // Per-slot key/mask for the masked booleans, and per-slot opaque-predicate
    // salts. All baked in from the seed.
    obf::MaskedBool masked[SlotCount];

    // A flattened dispatch: instead of five straight-line calls, a state machine
    // visits the slots in `order`, one per turn, each turn guarded by an opaque
    // predicate. This is textbook control-flow flattening, contained to one
    // function so it costs nothing in readability elsewhere.
    int state = 0;
    for (;;) {
        if (state >= static_cast<int>(SlotCount))
            break;
        // opaqueTrue is always true; the &&-chain just denies the optimiser a
        // clean loop it can unroll back into five labelled calls.
        if (obf::guardedTrue(true, obf::seedAt(20u + static_cast<std::uint32_t>(state)))) {
            const int slot = order[static_cast<std::size_t>(state)];
            const std::uint32_t key = obf::seedAt(40u + static_cast<std::uint32_t>(slot));
            const std::uint32_t mask =
                obf::seedAt(60u + static_cast<std::uint32_t>(slot)) | 1u; // never zero
            const bool value = checks[static_cast<std::size_t>(slot)]();
            masked[slot] = obf::MaskedBool::make(value, key, mask);
        }
        state += 1;
    }

    bool r[SlotCount];
    for (int i = 0; i < static_cast<int>(SlotCount); ++i)
        r[i] = masked[i].decode();

    return combine(r);
}

#else  // plain passthrough — dev and test builds

Result evaluate(const Checks &checks)
{
    bool r[SlotCount];
    for (int i = 0; i < static_cast<int>(SlotCount); ++i)
        r[i] = checks[static_cast<std::size_t>(i)]();
    return combine(r);
}

#endif

} // namespace nexa::guard
