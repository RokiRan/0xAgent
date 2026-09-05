#!/bin/bash
# 免 Gradle 手搓 APK：aapt2 compile+link（含 AAR 库 res）→ javac → d8 --multidex → zip(dex+so) → apksigner
# 依赖闭包在 libs/（*.aar + *.jar），由 /tmp/fetch_mlkit.py 从 dl.google.com/maven2 拉取
set -euo pipefail

SDK="$HOME/Library/Android/sdk"
BT="$SDK/build-tools/34.0.0"
ANDROID_JAR="$SDK/platforms/android-35/android.jar"
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/app"
BUILD="$ROOT/build"
SRC="$APP/src/main/java"
LIBS="$ROOT/libs"
KEYSTORE="$ROOT/debug.keystore"

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$BUILD/libres"

echo "== extract AARs (idempotent)"
for aar in "$LIBS"/*.aar; do
    d="$LIBS/x_$(basename "${aar%.aar}")"
    if [ ! -d "$d" ]; then
        mkdir -p "$d"
        unzip -qo "$aar" -d "$d"
    fi
done

echo "== aapt2 compile app + lib res"
"$BT/aapt2" compile --dir "$APP/src/main/res" -o "$BUILD/res.zip"
LIBRES=()
EXTRA_PKGS=()
ASSET_DIRS=()
for d in "$LIBS"/x_*/; do
    name=$(basename "$d")
    if [ -d "$d/res" ]; then
        "$BT/aapt2" compile --dir "$d/res" -o "$BUILD/libres/$name.zip"
        LIBRES+=("$BUILD/libres/$name.zip")
        pkg=$(grep -oE 'package="[^"]+"' "$d/AndroidManifest.xml" | head -1 | cut -d'"' -f2)
        EXTRA_PKGS+=("$pkg")
    fi
    if [ -d "$d/assets" ]; then
        ASSET_DIRS+=("$d/assets")
    fi
done

echo "== aapt2 link (extra-packages: ${#EXTRA_PKGS[@]} libs)"
LINK_ARGS=(
    -o "$BUILD/base.apk"
    -I "$ANDROID_JAR"
    --manifest "$APP/src/main/AndroidManifest.xml"
    --java "$BUILD/gen"
    --auto-add-overlay
)
for a in "${ASSET_DIRS[@]}"; do LINK_ARGS+=(-A "$a"); done
# app 自身 assets（sherpa-onnx ASR 模型等）
if [ -d "$APP/src/main/assets" ]; then LINK_ARGS+=(-A "$APP/src/main/assets"); fi
if [ ${#EXTRA_PKGS[@]} -gt 0 ]; then
    LINK_ARGS+=(--extra-packages "$(IFS=:; echo "${EXTRA_PKGS[*]}")")
fi
"$BT/aapt2" link "${LINK_ARGS[@]}" "$BUILD/res.zip" "${LIBRES[@]}"

echo "== javac"
CP="$ANDROID_JAR"
for d in "$LIBS"/x_*/; do
    [ -f "$d/classes.jar" ] && CP="$CP:$d/classes.jar"
done
for j in "$LIBS"/*.jar; do CP="$CP:$j"; done
find "$SRC" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
javac -source 1.8 -target 1.8 \
    -classpath "$CP" \
    -d "$BUILD/classes" \
    @"$BUILD/sources.txt"

echo "== d8 (multidex, min-api 26 原生支持)"
D8_INPUTS=($(find "$BUILD/classes" -name '*.class'))
for d in "$LIBS"/x_*/; do
    [ -f "$d/classes.jar" ] && D8_INPUTS+=("$d/classes.jar")
done
for j in "$LIBS"/*.jar; do D8_INPUTS+=("$j"); done
"$BT/d8" --min-api 26 \
    --output "$BUILD/dex" \
    "${D8_INPUTS[@]}"

echo "== package (dex + arm64 native libs)"
cp "$BUILD/base.apk" "$BUILD/app-unsigned.apk"
(cd "$BUILD/dex" && zip -q "$BUILD/app-unsigned.apk" classes*.dex)
mkdir -p "$BUILD/native/lib/arm64-v8a"
for d in "$LIBS"/x_*/; do
    if [ -d "$d/jni/arm64-v8a" ]; then
        cp "$d"/jni/arm64-v8a/*.so "$BUILD/native/lib/arm64-v8a/"
    fi
done
(cd "$BUILD/native" && zip -q -r "$BUILD/app-unsigned.apk" lib)

echo "== sign"
if [ ! -f "$KEYSTORE" ]; then
    keytool -genkeypair -v -keystore "$KEYSTORE" \
        -alias debug -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass android -keypass android \
        -dname "CN=0xAgent Debug,O=0xAgent,C=CN" 2>/dev/null
fi
"$BT/apksigner" sign \
    --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
    --out "$ROOT/bus-agent.apk" \
    "$BUILD/app-unsigned.apk"

echo "OK: $ROOT/bus-agent.apk ($(du -h "$ROOT/bus-agent.apk" | cut -f1))"
