#!/usr/bin/env bash
# Regenerate the store tiles and an app screenshot.
# Needs ImageMagick; the screenshot additionally needs xvfb-run + xdotool.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/store-assets"
mkdir -p "$out"

tile() {
  local W=$1 H=$2 FILE=$3 LOGO=$4 TITLE=$5 SUB=$6
  convert -size ${W}x${H} gradient:'#12102b-#070a14' \
    \( -size ${W}x${H} radial-gradient:'#2b2260'-'#00000000' -alpha set -channel A -evaluate multiply 0.55 +channel \) \
    -compose over -composite \
    \( "$here/assets/nexa-256.png" -resize ${LOGO}x${LOGO} \) -gravity west -geometry +$((W/12))+0 -composite \
    -gravity west -fill '#ffffff' -pointsize ${TITLE} -font DejaVu-Sans-Bold \
      -annotate +$((W/12 + LOGO + W/28))-$((H/14)) 'Nexa Download Manager' \
    -gravity west -fill '#9fb3ff' -pointsize ${SUB} -font DejaVu-Sans \
      -annotate +$((W/12 + LOGO + W/28))+$((H/12)) 'Faster downloads · videos · torrents — free' \
    "$out/$FILE"
  echo "  $FILE"
}

echo "Tiles:"
tile 1400 560 promo-marquee-1400x560.png 260 62 30
tile 920  680 promo-large-920x680.png    200 44 21
tile 440  280 promo-small-440x280.png    110 26 13
convert "$here/assets/nexa-256.png" -resize 128x128 "$out/icon-128.png"
convert "$here/assets/nexa-256.png" -resize 96x96  "$out/icon-96.png"
echo "  icon-128.png, icon-96.png"

if command -v xvfb-run >/dev/null && command -v xdotool >/dev/null && [ -x "$here/build/nexa" ]; then
  echo "Screenshot:"
  xvfb-run -a --server-args="-screen 0 1280x800x24" bash -c "
    QT_QPA_PLATFORM=xcb '$here/build/nexa' >/dev/null 2>&1 &
    APP=\$!; sleep 8
    WID=\$(xwininfo -root -tree 2>/dev/null | grep 'Nexa Download Manager' | grep -o '0x[0-9a-f]*' | head -1)
    xdotool windowmap \$WID; xdotool windowsize \$WID 1280 800; xdotool windowactivate \$WID; sleep 3
    import -window \$WID '$out/screenshot-1-app-1280x800.png'
    kill \$APP 2>/dev/null" && echo "  screenshot-1-app-1280x800.png"
else
  echo "Screenshot: skipped (needs xvfb-run, xdotool and a built build/nexa)"
fi
