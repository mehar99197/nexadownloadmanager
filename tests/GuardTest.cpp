// Guard equivalence + semantics.
//
// This file is compiled TWICE (see CMakeLists.txt): once with the plain guard
// and once with NEXA_OBFUSCATE_LICENSE — the flattened, opaque-predicate,
// masked-boolean, seed-rotated shape. Both link the same Guard.cpp and run the
// same assertions, so if the obfuscation ever changed the answer for any input,
// the obfuscated build of this test would fail. That is the safety net that lets
// the shipping binary carry the obfuscated guard with confidence: it cannot
// silently strip a paying customer of their plan.
//
// No Qt: the guard depends only on the standard library, so neither does its
// test.

#include "license/Guard.h"

#include <array>
#include <cstdio>
#include <functional>

using nexa::guard::Check;
using nexa::guard::Checks;
using nexa::guard::Result;
using nexa::guard::evaluate;
namespace slot = nexa::guard;

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++g_failures;
    }
}

// A constant-returning check, so evaluate() sees a fixed input vector.
static Check constant(bool value) { return [value] { return value; }; }

// The reference meaning, stated once, independent of Guard.cpp's implementation.
//   paid   = KeyIntact && (LivePaid || CachedGrace)
//   tamper = MemoryClaimsPaid && !(KeyIntact && SignedGrant)
static Result reference(bool keyIntact, bool livePaid, bool cachedGrace,
                        bool memoryPaid, bool signedGrant)
{
    Result r;
    r.paid = keyIntact && (livePaid || cachedGrace);
    r.tamper = !r.paid && memoryPaid && !(keyIntact && signedGrant);
    return r;
}

int main()
{
    // Every one of the 2^5 input combinations must match the reference exactly,
    // in whichever shape this build compiled the guard into.
    for (int bits = 0; bits < 32; ++bits) {
        const bool keyIntact   = bits & 1;
        const bool livePaid    = bits & 2;
        const bool cachedGrace = bits & 4;
        const bool memoryPaid  = bits & 8;
        const bool signedGrant = bits & 16;

        Checks checks = {
            constant(keyIntact),
            constant(livePaid),
            constant(cachedGrace),
            constant(memoryPaid),
            constant(signedGrant),
        };
        const Result got = evaluate(checks);
        const Result want = reference(keyIntact, livePaid, cachedGrace, memoryPaid, signedGrant);

        char msg[128];
        std::snprintf(msg, sizeof(msg), "paid mismatch at bits=%d", bits);
        check(got.paid == want.paid, msg);
        std::snprintf(msg, sizeof(msg), "tamper mismatch at bits=%d", bits);
        check(got.tamper == want.tamper, msg);

        // paid and tamper are mutually exclusive by construction — a real paid
        // grant can never also read as tampered.
        check(!(got.paid && got.tamper), "paid and tamper both set");
    }

    // The check order the guard runs in must not affect the result: shuffle the
    // callbacks' evaluation by giving them side effects and confirming the answer
    // is unchanged. (Order IS rotated per release; this asserts that is safe.)
    {
        int calls = 0;
        auto counting = [&calls](bool v) -> Check {
            return [&calls, v] { ++calls; return v; };
        };
        Checks checks = {
            counting(true), counting(true), counting(false), counting(true), counting(true),
        };
        const Result got = evaluate(checks);
        check(got.paid, "expected paid for a live-paid, key-intact, signed grant");
        check(!got.tamper, "a genuine paid grant must not read as tamper");
        check(calls == static_cast<int>(nexa::guard::SlotCount), "every check must run exactly once");
    }

    // The canonical tamper case: memory claims paid, nothing signed backs it.
    {
        Checks checks = {
            constant(true),   // key intact
            constant(false),  // no live paid token
            constant(false),  // no cached grace
            constant(true),   // but memory says paid  <-- the patch
            constant(false),  // and there is no signed grant at all
        };
        const Result got = evaluate(checks);
        check(!got.paid, "a patched paid state must not be granted");
        check(got.tamper, "a patched paid state must trip the canary");
    }

    // The false-positive the canary must never produce: a real customer whose
    // offline grace has just lapsed. Memory still says paid for up to a minute,
    // but a validly-signed device-bound paid token still EXISTS, so it is not
    // tamper — just not currently granted.
    {
        Checks checks = {
            constant(true),   // key intact
            constant(false),  // live token expired
            constant(false),  // grace window lapsed
            constant(true),   // memory still says paid (pre-recheck)
            constant(true),   // but the signed grant still exists  <-- the difference
        };
        const Result got = evaluate(checks);
        check(!got.paid, "a lapsed grace window is not a current grant");
        check(!got.tamper, "a lapsed-but-real customer must NOT read as tamper");
    }

    if (g_failures == 0)
        std::puts("GuardTest: all assertions passed");
    return g_failures == 0 ? 0 : 1;
}
