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

    // The Pro gate covers login-gated COURSE sites and nothing else. It used to
    // reuse the login-cookie list (isAuthSite), which also holds Google, Vimeo,
    // all of LinkedIn and Apple Music, so Free was refused a public Drive file
    // or a Vimeo video that the website says Free gets.
    const auto pro = [&](const char *url) {
        return providers.requiresPro(QUrl(QString::fromLatin1(url)));
    };
    CHECK(pro("https://www.udemy.com/course/some-course/learn/lecture/123"));
    CHECK(pro("https://acme.udemy.com/course/some-course/"));   // Udemy Business
    CHECK(pro("https://www.coursera.org/learn/machine-learning/lecture/abc"));
    CHECK(pro("https://www.skillshare.com/en/classes/some-class/123"));
    CHECK(pro("https://app.pluralsight.com/course-player?clipId=1"));
    CHECK(pro("https://www.linkedin.com/learning/some-course/welcome"));
    CHECK(!pro("https://www.linkedin.com/posts/someone_activity-123"));
    CHECK(!pro("https://www.linkedin.com/feed/update/urn:li:activity:1/"));
    CHECK(!pro("https://drive.google.com/file/d/1AbCdEfGh/view"));
    CHECK(!pro("https://docs.google.com/document/d/1AbC/export?format=pdf"));
    CHECK(!pro("https://photos.google.com/share/AbCd"));
    CHECK(!pro("https://vimeo.com/76979871"));
    CHECK(!pro("https://player.vimeo.com/video/76979871"));
    CHECK(!pro("https://music.apple.com/us/album/x/1"));
    CHECK(!pro("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    // Boundary-aware, like every other host match in the registry.
    CHECK(!pro("https://evil-udemy.com/course/x"));
    CHECK(!pro("https://udemy.com.evil.test/course/x"));
    CHECK(!pro("https://notlinkedin.com/learning/x"));

    // Which sites are paid is a product decision, so changing the list should
    // take a deliberate edit here too.
    QStringList gated;
    for (const auto &p : providers.all()) {
        if (p.proOnly)
            gated.append(p.id);
    }
    gated.sort();
    CHECK(gated == (QStringList{QStringLiteral("coursera"), QStringLiteral("linkedin"),
                                QStringLiteral("pluralsight"), QStringLiteral("skillshare"),
                                QStringLiteral("udemy")}));

    return failures == 0 ? 0 : 1;
}
