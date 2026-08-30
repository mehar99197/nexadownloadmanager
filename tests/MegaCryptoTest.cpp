// MEGA protocol crypto tests: key folding, attribute decryption, and the
// streaming AES-128-CTR + chunked CBC-MAC against an independent reference.
#include "site/MegaGrabber.h"

#include <QCoreApplication>
#include <QByteArray>
#include <QDebug>
#include <QRandomGenerator>
#include <openssl/evp.h>
#include <cstring>
#include <cstdlib>

using nexa::MegaGrabber;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

static QByteArray randomBytes(int n)
{
    QByteArray b(n, '\0');
    for (int i = 0; i < n; ++i)
        b[i] = char(QRandomGenerator::global()->bounded(256));
    return b;
}

static QByteArray aesEcbBlock(const QByteArray &key, const QByteArray &block)
{
    QByteArray out(16, '\0');
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int outl = 0, fin = 0;
    EVP_EncryptInit_ex(ctx, EVP_aes_128_ecb(), nullptr,
                       reinterpret_cast<const unsigned char *>(key.constData()), nullptr);
    EVP_CIPHER_CTX_set_padding(ctx, 0);
    EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char *>(out.data()), &outl,
                      reinterpret_cast<const unsigned char *>(block.constData()), 16);
    EVP_EncryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(out.data()) + outl, &fin);
    EVP_CIPHER_CTX_free(ctx);
    return out;
}

static QByteArray xorBytes(const QByteArray &a, const QByteArray &b)
{
    QByteArray r(a.size(), '\0');
    for (int i = 0; i < a.size(); ++i)
        r[i] = char(uchar(a[i]) ^ uchar(b[i]));
    return r;
}

// Straight port of the reference algorithm (mega.py / MEGA SDK) — block by block.
static QByteArray referenceMetaMac(const QByteArray &key, const QByteArray &nonce, const QByteArray &plain)
{
    QByteArray fileMac(16, '\0');
    const QByteArray chunkIv = nonce + nonce;
    qint64 pos = 0;
    qint64 size = 0x20000;
    while (pos < plain.size()) {
        const qint64 len = qMin<qint64>(size, plain.size() - pos);
        QByteArray chunkMac = chunkIv;
        for (qint64 off = 0; off < len; off += 16) {
            QByteArray block = plain.mid(int(pos + off), int(qMin<qint64>(16, len - off)));
            if (block.size() < 16)
                block.append(QByteArray(16 - block.size(), '\0'));
            chunkMac = aesEcbBlock(key, xorBytes(chunkMac, block));
        }
        fileMac = aesEcbBlock(key, xorBytes(fileMac, chunkMac));
        pos += len;
        if (size < 0x100000)
            size += 0x20000;
    }
    QByteArray meta(8, '\0');
    for (int i = 0; i < 4; ++i) {
        meta[i]     = char(uchar(fileMac[i])     ^ uchar(fileMac[i + 4]));
        meta[i + 4] = char(uchar(fileMac[i + 8]) ^ uchar(fileMac[i + 12]));
    }
    return meta;
}

static QByteArray aesCtrEncrypt(const QByteArray &key, const QByteArray &nonce, const QByteArray &plain)
{
    QByteArray out(plain.size(), '\0');
    unsigned char iv[16] = {0};
    std::memcpy(iv, nonce.constData(), 8);
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int outl = 0, fin = 0;
    EVP_EncryptInit_ex(ctx, EVP_aes_128_ctr(), nullptr,
                       reinterpret_cast<const unsigned char *>(key.constData()), iv);
    EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char *>(out.data()), &outl,
                      reinterpret_cast<const unsigned char *>(plain.constData()), plain.size());
    EVP_EncryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(out.data()) + outl, &fin);
    EVP_CIPHER_CTX_free(ctx);
    return out;
}

static QByteArray aesCbcZeroIvEncrypt(const QByteArray &key, const QByteArray &plainPadded)
{
    QByteArray out(plainPadded.size(), '\0');
    unsigned char iv[16] = {0};
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int outl = 0, fin = 0;
    EVP_EncryptInit_ex(ctx, EVP_aes_128_cbc(), nullptr,
                       reinterpret_cast<const unsigned char *>(key.constData()), iv);
    EVP_CIPHER_CTX_set_padding(ctx, 0);
    EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char *>(out.data()), &outl,
                      reinterpret_cast<const unsigned char *>(plainPadded.constData()), plainPadded.size());
    EVP_EncryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(out.data()) + outl, &fin);
    EVP_CIPHER_CTX_free(ctx);
    return out;
}

static void testSplitKey()
{
    QByteArray node(32, '\0');
    for (int i = 0; i < 32; ++i) node[i] = char(i * 7 + 3);
    QByteArray key, nonce, mac;
    CHECK(MegaGrabber::splitFileKey(node, key, nonce, mac), "splitFileKey accepts 32 bytes");
    CHECK(key.size() == 16 && nonce.size() == 8 && mac.size() == 8, "split sizes");
    for (int i = 0; i < 16; ++i)
        CHECK(uchar(key[i]) == (uchar(node[i]) ^ uchar(node[i + 16])), "key fold XOR");
    CHECK(nonce == node.mid(16, 8), "nonce = bytes 16..23");
    CHECK(mac == node.mid(24, 8), "meta-MAC = bytes 24..31");
    QByteArray k2, n2, m2;
    CHECK(!MegaGrabber::splitFileKey(node.left(16), k2, n2, m2), "16-byte (folder) key rejected");
}

static void testAttributes()
{
    const QByteArray key = randomBytes(16);
    QByteArray plain = QByteArrayLiteral("MEGA{\"n\":\"Quarterly report (final).pdf\",\"c\":\"x\"}");
    plain.append(QByteArray(16 - plain.size() % 16, '\0'));
    const QByteArray enc = aesCbcZeroIvEncrypt(key, plain);
    CHECK(MegaGrabber::decryptAttributeName(key, enc) == QStringLiteral("Quarterly report (final).pdf"),
          "attribute name decrypts");
    CHECK(MegaGrabber::decryptAttributeName(randomBytes(16), enc).isEmpty(), "wrong key → no name");
    CHECK(MegaGrabber::decryptAttributeName(key, enc.left(15)).isEmpty(), "unaligned blob rejected");

    QByteArray evil = QByteArrayLiteral("MEGA{\"n\":\"../../etc/passwd\"}");
    evil.append(QByteArray(16 - evil.size() % 16, '\0'));
    const QString safe = MegaGrabber::decryptAttributeName(key, aesCbcZeroIvEncrypt(key, evil));
    CHECK(!safe.contains(QLatin1Char('/')) && !safe.contains(QLatin1Char('\\')), "path separators neutralised");
}

static void testStream(int size, int pieceSize)
{
    const QByteArray key = randomBytes(16);
    const QByteArray nonce = randomBytes(8);
    QByteArray plain(size, '\0');
    for (int i = 0; i < size; ++i)
        plain[i] = char((i * 31 + (i >> 8)) & 0xff);
    QByteArray buf = aesCtrEncrypt(key, nonce, plain);
    CHECK(buf != plain || size == 0, "ciphertext differs from plaintext");

    const QByteArray mac = MegaGrabber::decryptAndMac(key, nonce, buf, pieceSize);
    CHECK(buf == plain, QStringLiteral("CTR round-trip size=%1 piece=%2").arg(size).arg(pieceSize));
    CHECK(mac == referenceMetaMac(key, nonce, plain),
          QStringLiteral("meta-MAC matches reference size=%1 piece=%2").arg(size).arg(pieceSize));

    // A flipped ciphertext byte must change the MAC (integrity actually bites).
    if (size > 0) {
        QByteArray tampered = aesCtrEncrypt(key, nonce, plain);
        tampered[size / 2] = char(uchar(tampered[size / 2]) ^ 0x01);
        const QByteArray mac2 = MegaGrabber::decryptAndMac(key, nonce, tampered, pieceSize);
        CHECK(mac2 != mac, "tampered byte changes MAC");
    }
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    testSplitKey();
    testAttributes();
    // Sizes straddle: sub-block, one block, first chunk boundary (128K), second
    // (128K+256K = 384K), and a multi-chunk file; fed whole and in odd pieces.
    for (int size : {5, 16, 17, 0x20000, 0x20000 + 1, 0x60000, 0x60000 + 12345, 900000})
        for (int piece : {0, 1000, 65536, 7})
            testStream(size, piece);
    if (g_failures == 0) {
        qInfo() << "MEGA crypto tests passed";
        return 0;
    }
    qWarning() << g_failures << "failure(s)";
    return 1;
}
