# nexa-host — Native Messaging Bridge

Browsers cannot launch a desktop `.exe` directly. They talk to a small
registered **native messaging host** over `stdin`/`stdout` using a simple
framed-JSON protocol:

```
[ 4-byte little-endian uint32 length ][ UTF-8 JSON payload ]
```

`nexa-host` reads one such message from the extension, then relays it to the
running Nexa engine over a local socket (`QLocalSocket` / named pipe). If the
engine isn't running, the host launches it.

## Message the extension sends

```json
{
  "type": "download",
  "url": "https://example.com/file.zip",
  "referrer": "https://example.com/page",
  "userAgent": "Mozilla/5.0 ...",
  "cookies": "session=abc; theme=dark",
  "headers": { "Authorization": "Bearer ..." },
  "filename": "file.zip"
}
```

The `cookies`, `userAgent` and `referrer` are **essential** — without replaying
them the engine gets 403s on authenticated / CDN-protected links. This is the
detail most IDM clones get wrong.

## Reply the host sends back

```json
{ "ok": true, "id": 42 }
```

## Install (registration)

Each browser looks for a host manifest in a well-known location:

| Browser           | Manifest location (Linux)                                   |
|-------------------|-------------------------------------------------------------|
| Chrome            | `~/.config/google-chrome/NativeMessagingHosts/com.nexa.host.json` |
| Chromium          | `~/.config/chromium/NativeMessagingHosts/com.nexa.host.json`      |
| Brave             | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/...`  |
| Edge              | `~/.config/microsoft-edge/NativeMessagingHosts/...`               |
| Firefox           | `~/.mozilla/native-messaging-hosts/com.nexa.host.json`            |

Run `./install.sh` (Linux/Mac) or `install.ps1` (Windows) after building to
generate the manifest with the correct absolute path and extension id.
