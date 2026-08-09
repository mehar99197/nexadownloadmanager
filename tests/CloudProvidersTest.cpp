#include "auth/CloudProviders.h"

#include <QCoreApplication>
#include <QDebug>

namespace {
int failures = 0;

#define CHECK(expr) do { \
    if (!(expr)) { \
        qCritical() << "FAIL" << __LINE__ << #expr; \
        ++failures; \
    } \
} while (false)
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    nexa::CloudProviders providers;
    CHECK(providers.load());

    // ChatGPT attachment redirects commonly leave chatgpt.com for an
    // oaiusercontent.com CDN host. Both hosts must remain in one credential
    // scope so range workers replay Cookie/Authorization after the probe.
    CHECK(providers.sameCredentialScope(QStringLiteral("chatgpt.com"),
                                        QStringLiteral("files.oaiusercontent.com")));
    CHECK(providers.sameCredentialScope(QStringLiteral("chat.openai.com"),
                                        QStringLiteral("cdn.oaiusercontent.com")));
    CHECK(providers.sameCredentialScope(QStringLiteral("api.openai.com"),
                                        QStringLiteral("chatgpt.com")));

    // Provider matching is boundary-aware: an attacker-controlled suffix must
    // never inherit the ChatGPT credential scope.
    CHECK(!providers.sameCredentialScope(QStringLiteral("evil-openai.com"),
                                         QStringLiteral("chatgpt.com")));
    CHECK(!providers.sameCredentialScope(QStringLiteral("oaiusercontent.com.evil.test"),
                                          QStringLiteral("chatgpt.com")));

    // Browser-based AI assistants commonly redirect an authenticated page/API
    // request to a provider-owned asset host. Keep those approved siblings in
    // scope for the probe and every byte-range worker.
    CHECK(providers.sameCredentialScope(QStringLiteral("claude.ai"),
                                        QStringLiteral("files.claude.ai")));
    CHECK(providers.sameCredentialScope(QStringLiteral("grok.com"),
                                        QStringLiteral("assets.grok.com")));
    CHECK(providers.sameCredentialScope(QStringLiteral("grok.com"),
                                        QStringLiteral("imagine-public.x.ai")));
    CHECK(providers.sameCredentialScope(QStringLiteral("perplexity.ai"),
                                        QStringLiteral("pplx-res.cloudinary.com")));
    CHECK(!providers.sameCredentialScope(QStringLiteral("grok.com"),
                                         QStringLiteral("evil-grok.com")));

    CHECK(providers.providerForHost(QStringLiteral("files.claude.ai"))
              == providers.providerById(QStringLiteral("claude")));
    CHECK(providers.providerForHost(QStringLiteral("assets.grok.com"))
              == providers.providerById(QStringLiteral("grok")));
    CHECK(providers.providerForHost(QStringLiteral("pplx-res.cloudinary.com"))
              == providers.providerById(QStringLiteral("perplexity")));

    return failures == 0 ? 0 : 1;
}
