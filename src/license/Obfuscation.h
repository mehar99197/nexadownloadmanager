#pragma once

#include <array>
#include <cstdint>

// Control-flow / value obfuscation primitives for the licence code paths.
//
// Everything here has TWO shapes, chosen by NEXA_OBFUSCATE_LICENSE:
//
//   • defined (a hardened release build) — opaque predicates, masked booleans
//     and a seed-driven execution order, so the "is this install paid?"
//     decision is not a single readable branch a decompiler can find and a
//     cracker can flip.
//
//   • undefined (dev and every unit-test target) — a trivial, optimiser- and
//     debugger-friendly passthrough. The logic is identical; only the *shape*
//     of the compiled code differs. GuardTest compiles the same source both
//     ways and asserts the two agree on all inputs, so the obfuscation can
//     never change the answer for a real user.
//
// None of this is a barrier on its own (nothing client-side is — see the notes
// in KeyIntegrity.h). It raises the price of reading and patching the gate,
// which is the whole game once the value that matters has been moved server
// side.

namespace nexa::obf {

// The rotation seed. CMake derives it from PROJECT_VERSION (overridable with
// -DNEXA_CHECK_ROTATION_SEED=...), so every release compiles the guard into a
// different shape: a byte patch crafted for one build lands on differently
// arranged code in the next. It is a plain compile-time constant with zero
// runtime cost.
#ifndef NEXA_CHECK_ROTATION_SEED
#define NEXA_CHECK_ROTATION_SEED 0x4e455841u   // "NEXA" — the stable dev/test seed
#endif

inline constexpr std::uint32_t kRotationSeed = NEXA_CHECK_ROTATION_SEED;

// A small constexpr mixer (splitmix32). Used only at compile time to spread the
// single seed into per-slot keys, masks and an execution order — so those are
// baked into the machine code rather than computed at runtime.
constexpr std::uint32_t mix(std::uint32_t x)
{
    x += 0x9e3779b9u;
    x = (x ^ (x >> 16)) * 0x21f0aaadu;
    x = (x ^ (x >> 15)) * 0x735a2d97u;
    return x ^ (x >> 15);
}

// The i-th derived constant for this build's seed.
constexpr std::uint32_t seedAt(std::uint32_t i)
{
    return mix(kRotationSeed ^ (i * 0x9e3779b9u + 0x85ebca6bu));
}

// A compile-time permutation of [0, N) from the seed (Fisher–Yates). This is
// the order the guard evaluates its checks in — different per release, and
// irrelevant to the result because every check is side-effect free.
template <std::size_t N>
constexpr std::array<int, N> permutation(std::uint32_t seed)
{
    std::array<int, N> order{};
    for (std::size_t i = 0; i < N; ++i)
        order[i] = static_cast<int>(i);
    std::uint32_t s = seed;
    for (std::size_t i = N; i > 1; --i) {
        s = mix(s);
        const std::size_t j = s % i;
        const int tmp = order[i - 1];
        order[i - 1] = order[j];
        order[j] = tmp;
    }
    return order;
}

// A boolean that is not stored as 0/1.
//
// It is carried as a 32-bit word that equals a per-slot key when true and that
// key XOR a non-zero mask when false, so there is no `test al,al; jz` on the
// entitlement decision — the compare that recovers the bool is against a
// build-specific constant. Exact and overflow-free: with a non-zero mask the
// two encodings can never collide, so decode() round-trips every value.
struct MaskedBool {
    std::uint32_t word = 0;
    std::uint32_t key = 0;
    std::uint32_t mask = 0;

    static MaskedBool make(bool value, std::uint32_t key, std::uint32_t mask)
    {
        // mask must be non-zero or true and false would encode identically.
        const std::uint32_t m = mask ? mask : 0xA5A5A5A5u;
        MaskedBool b;
        b.key = key;
        b.mask = m;
        b.word = value ? key : (key ^ m);
        return b;
    }

    bool decode() const { return word == key; }
};

#ifdef NEXA_OBFUSCATE_LICENSE

// Opaque predicates: functions that always return the same value but whose
// constant result the compiler and a decompiler do not trivially recover.
//
// Built from arithmetic identities that hold for EVERY 32-bit value, including
// under wraparound, so they can never accidentally flip:
//   • the parity of x*x equals the parity of x  (squaring preserves the low bit)
//   • (x | 1) is always odd
// The value is read through `volatile` so the identity is not constant-folded
// away at -O2.
inline bool opaqueTrue(std::uint32_t salt)
{
    volatile std::uint32_t sink = salt ^ seedAt(1);
    const std::uint32_t x = sink;
    const bool parityHolds = ((x * x) & 1u) == (x & 1u);   // always true
    const bool oddHolds = ((x | 1u) & 1u) == 1u;           // always true
    return parityHolds && oddHolds;
}

inline bool opaqueFalse(std::uint32_t salt) { return !opaqueTrue(salt); }

// Branch on `cond` but wrapped so the taken edge is guarded by an opaque
// predicate. Semantically just `cond`; shaped so the interesting branch does
// not sit alone.
inline bool guardedTrue(bool cond, std::uint32_t salt)
{
    return cond && opaqueTrue(salt);
}

#else  // plain passthrough — dev and test builds

inline bool opaqueTrue(std::uint32_t) { return true; }
inline bool opaqueFalse(std::uint32_t) { return false; }
inline bool guardedTrue(bool cond, std::uint32_t) { return cond; }

#endif

} // namespace nexa::obf
