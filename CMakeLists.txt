cmake_minimum_required(VERSION 3.21)
project(Nexa VERSION 0.3.1 LANGUAGES CXX DESCRIPTION "Nexa Download Manager")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

if(WIN32)
    enable_language(RC)
endif()

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Qt6 REQUIRED COMPONENTS Core Network Widgets Sql)
# Translations are optional at build time: LinguistTools is only needed to turn
# translations/*.ts into the .qm files that ship. Without it the app still builds
# and simply runs in its source language (English).
find_package(Qt6 QUIET COMPONENTS LinguistTools)
# AES-128-CTR + CBC-MAC for MEGA downloads (libcrypto is already pulled in by
# libtorrent, so this adds no new runtime dependency to the bundles).
find_package(OpenSSL REQUIRED COMPONENTS Crypto)

# BitTorrent support via libtorrent-rasterbar.
# On Windows (MSYS2/MinGW) use the CMake config package to avoid pkg-config
# path issues; on Linux use pkg-config as before.
if(WIN32)
    # CONFIG forces only the package config file — skips FindLibtorrentRasterbar.cmake
    # which runs both config + pkgconfig modes and creates a duplicate alias target.
    find_package(LibtorrentRasterbar CONFIG REQUIRED)
    set(LIBTORRENT_TARGET LibtorrentRasterbar::torrent-rasterbar)
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(LIBTORRENT REQUIRED IMPORTED_TARGET libtorrent-rasterbar)
    set(LIBTORRENT_TARGET PkgConfig::LIBTORRENT)
endif()

add_executable(nexa
    resources.qrc
    $<$<BOOL:${WIN32}>:packaging/nexa.rc>
    src/main.cpp
    src/license/LicenseToken.cpp
    src/license/KeyIntegrity.cpp
    src/license/Guard.cpp
    src/core/Database.cpp
    src/core/Categories.cpp
    src/core/RateLimiter.cpp
    src/core/UpdateChecker.cpp
    src/core/SegmentDownloader.cpp
    src/core/DownloadTask.cpp
    src/core/DownloadEngine.cpp
    src/license/CredentialStore.cpp
    src/license/LicenseManager.cpp
    src/grabber/HlsGrabber.cpp
    src/torrent/TorrentManager.cpp
    src/site/YtDlpGrabber.cpp
    src/site/MegaGrabber.cpp
    src/site/SpotifyGrabber.cpp
    src/auth/CookieFile.cpp
    src/auth/AuthUtils.cpp
    src/auth/AuthenticationManager.cpp
    src/auth/BrowserLogin.cpp
    src/auth/CloudProviders.cpp
    src/ai/AiClient.cpp
    src/ipc/IpcServer.cpp
    src/ipc/NativeHostRegistrar.cpp
    src/ipc/ExtensionInstaller.cpp
    src/shell/ShellIntegration.cpp
    src/web/WebServer.cpp
    src/web/PublicUrlPolicy.cpp
    src/ui/UiHelpers.cpp
    src/ui/DownloadDetailsDialog.cpp
    src/ui/SiteLoginsDialog.cpp
    src/ui/CategoriesDialog.cpp
    src/ui/SettingsDialog.cpp
    src/core/DownloadImport.cpp
    src/core/Portable.cpp
    src/core/VirusScanner.cpp
    src/core/ProxyConfig.cpp
    src/ui/ClipboardMonitor.cpp
    src/ui/Localization.cpp
    src/ui/Theme.cpp
    src/ui/Motion.cpp
    src/ui/ThemeGalleryDialog.cpp
    src/ads/AdService.cpp
    src/ui/AdBanner.cpp
    src/ui/FirstRunWizard.cpp
    src/ui/LinkGrabberDialog.cpp
    src/ui/BatchDownloadDialog.cpp
    src/grabber/SiteCrawler.cpp
    src/ui/WebsiteGrabberDialog.cpp
    src/ui/MainWindow.cpp
)

target_include_directories(nexa PRIVATE src)
target_link_libraries(nexa PRIVATE
    Qt6::Core
    Qt6::Network
    Qt6::Widgets
    Qt6::Sql
    ${LIBTORRENT_TARGET}
    OpenSSL::Crypto
)

# Developer builds only: honour the NEXA_* endpoint overrides
# (NEXA_LICENSE_API_URL, NEXA_ADS_API_URL, NEXA_UPDATE_URL, and the
# plain-HTTP-on-loopback escape hatch NEXA_ALLOW_INSECURE_LICENSE_API).
#
# A shipped build MUST NOT read them. Pointing the licence endpoint at a
# server you control is otherwise a complete, no-reverse-engineering licence
# bypass: return {"valid":true,"plan":"pro",...} and the client believes it.
# The same applies to the ad endpoint (adFree) and the update feed, where a
# fake feed supplies both the installer URL and the SHA-256 it is checked
# against — i.e. arbitrary code execution, not just a lost sale.
#
# Configure a dev build with:  cmake -B build -DNEXA_DEV_BUILD=ON
option(NEXA_DEV_BUILD "Allow NEXA_* endpoint overrides (developer builds only)" OFF)
if(NEXA_DEV_BUILD)
    target_compile_definitions(nexa PRIVATE NEXA_DEV_BUILD)
    message(WARNING
        "NEXA_DEV_BUILD=ON — this build honours NEXA_LICENSE_API_URL / "
        "NEXA_ADS_API_URL / NEXA_UPDATE_URL and is NOT fit to ship.")
endif()

# The Ed25519 public key that licence tokens are verified against.
#
# Supply it as 64 hex characters, either with -DNEXA_LICENSE_PUBLIC_KEY=... or
# by writing it to packaging/license-public-key.txt. Generate a pair with
# `npm run license:keygen` in ndm-website/backend: the private half goes in the
# server environment, this is the public half.
#
# The key file is committed on purpose — a verification key is not a secret,
# and checking it in is what lets CI and a fresh clone build a shippable binary.
#
# A release build without one is a hard error on purpose. The fallback baked
# into LicenseToken.cpp is derived from the development seed that is committed
# to this repository, so a shipped binary trusting it could be handed a
# self-signed "Pro" token by anybody. Better to fail at configure time than to
# ship that silently.
set(NEXA_LICENSE_PUBLIC_KEY "" CACHE STRING
    "Ed25519 licence-token public key, 64 hex chars")
set(NEXA_LICENSE_KEY_FILE "${CMAKE_CURRENT_SOURCE_DIR}/packaging/license-public-key.txt")
if(NOT NEXA_LICENSE_PUBLIC_KEY AND EXISTS "${NEXA_LICENSE_KEY_FILE}")
    file(READ "${NEXA_LICENSE_KEY_FILE}" NEXA_LICENSE_PUBLIC_KEY)
    string(STRIP "${NEXA_LICENSE_PUBLIC_KEY}" NEXA_LICENSE_PUBLIC_KEY)
endif()

if(NEXA_LICENSE_PUBLIC_KEY)
    # Checked in two steps because CMake's regex engine has no {n} quantifier.
    string(LENGTH "${NEXA_LICENSE_PUBLIC_KEY}" NEXA_LICENSE_KEY_LENGTH)
    if(NOT NEXA_LICENSE_KEY_LENGTH EQUAL 64
       OR NOT NEXA_LICENSE_PUBLIC_KEY MATCHES "^[0-9a-fA-F]+$")
        message(FATAL_ERROR
            "NEXA_LICENSE_PUBLIC_KEY must be exactly 64 hex characters (a 32-byte "
            "Ed25519 public key); got ${NEXA_LICENSE_KEY_LENGTH} characters: "
            "${NEXA_LICENSE_PUBLIC_KEY}")
    endif()
    # A digest of the key, kept in a different translation unit (KeyIntegrity.cpp)
    # so that swapping the embedded public key for an attacker's own — much
    # cheaper than defeating Ed25519, and invisible to the verifier itself —
    # requires a second, separate edit. Derived here from the same value that is
    # compiled in, so the two can never disagree by accident.
    string(SHA256 NEXA_LICENSE_KEY_DIGEST "${NEXA_LICENSE_PUBLIC_KEY}")
    target_compile_definitions(nexa PRIVATE
        NEXA_LICENSE_PUBLIC_KEY="${NEXA_LICENSE_PUBLIC_KEY}"
        NEXA_LICENSE_KEY_DIGEST="${NEXA_LICENSE_KEY_DIGEST}")
    message(STATUS "Licence tokens verified against key ${NEXA_LICENSE_PUBLIC_KEY}")
elseif(NEXA_DEV_BUILD)
    message(WARNING
        "No NEXA_LICENSE_PUBLIC_KEY set — falling back to the PUBLIC development "
        "key. Anyone can mint a Pro licence against it. Developer builds only.")
else()
    message(FATAL_ERROR
        "NEXA_LICENSE_PUBLIC_KEY is required for a release build.\n"
        "  Generate a keypair:  cd ndm-website/backend && npm run license:keygen\n"
        "  Then either:         echo <public-key-hex> > packaging/license-public-key.txt\n"
        "  or configure with:   cmake -B build -DNEXA_LICENSE_PUBLIC_KEY=<public-key-hex>\n"
        "  For local work only: cmake -B build -DNEXA_DEV_BUILD=ON\n"
        "Without this the binary would trust the development key that is committed "
        "to this repository, and licence tokens could be forged by anyone.")
endif()

# --- Licence-check obfuscation + per-release rotation -------------------------
#
# The guard behind verifiedFeatures() (src/license/Guard.cpp) combines several
# independent, redundant checks. Two build knobs shape how it compiles:
#
#   NEXA_OBFUSCATE_LICENSE  — flatten the guard's control flow, wrap its branches
#     in opaque predicates and carry its booleans masked, so the "is this paid?"
#     decision is not one readable branch to find and flip. ON for shipping
#     builds, OFF for dev and every test target (which then compile the plain,
#     debuggable, identical-in-result path — GuardTest proves the two agree).
#
#   NEXA_CHECK_ROTATION_SEED — a compile-time seed that permutes the check order,
#     the opaque-predicate constants and the masks. Derived from PROJECT_VERSION
#     so every release compiles the guard into a DIFFERENT shape: a byte patch
#     crafted for one build lands on differently arranged code in the next.
#     Override with -DNEXA_CHECK_ROTATION_SEED=0x... to rotate out of band.
#
# Neither is a barrier on its own (nothing client-side is). They raise the price
# of reading and patching the gate, which is the point once the value that
# matters lives on the server.
option(NEXA_OBFUSCATE_LICENSE "Obfuscate the licence guard's control flow in shipping builds" ON)

set(NEXA_CHECK_ROTATION_SEED "" CACHE STRING
    "32-bit hex seed (0x...) for licence-check rotation; empty = derive from version")
if(NOT NEXA_CHECK_ROTATION_SEED)
    string(SHA256 NEXA_ROTATION_HASH "nexa-license-guard-${PROJECT_VERSION}")
    string(SUBSTRING "${NEXA_ROTATION_HASH}" 0 8 NEXA_ROTATION_HEX)
    set(NEXA_CHECK_ROTATION_SEED "0x${NEXA_ROTATION_HEX}u")
endif()
# The seed is a plain compile-time constant with no runtime cost; it is compiled
# into every build (dev included) so a given source + seed is reproducible.
target_compile_definitions(nexa PRIVATE
    NEXA_CHECK_ROTATION_SEED=${NEXA_CHECK_ROTATION_SEED})
message(STATUS "Licence-check rotation seed: ${NEXA_CHECK_ROTATION_SEED}")

# The obfuscated shape is applied to the shipping executable only, and never to a
# developer build (which must stay debuggable) — the same reasoning as the symbol
# stripping below. Announced when skipped so "I built RelWithDebInfo" does not
# quietly ship the readable guard.
if(NEXA_OBFUSCATE_LICENSE AND NOT NEXA_DEV_BUILD
   AND (CMAKE_BUILD_TYPE STREQUAL "Release" OR CMAKE_BUILD_TYPE STREQUAL "MinSizeRel"))
    target_compile_definitions(nexa PRIVATE NEXA_OBFUSCATE_LICENSE)
    message(STATUS "Licence guard obfuscation on")

    # Optional machine-level control-flow flattening via an Obfuscator-LLVM
    # toolchain, applied to the licence sources only. Strictly opt-in and
    # feature-detected: it is a no-op on a stock GCC/Clang/MSVC (the flag check
    # simply fails and nothing is added), so the default build is untouched. The
    # portable, always-on obfuscation is the source-level one above; this is a
    # bonus when a capable toolchain is present.
    option(NEXA_LLVM_OBFUSCATION "Apply OLLVM control-flow flattening to licence sources (needs an OLLVM toolchain)" OFF)
    if(NEXA_LLVM_OBFUSCATION)
        include(CheckCXXSourceCompiles)
        set(CMAKE_REQUIRED_FLAGS "-mllvm -fla")
        check_cxx_source_compiles("int main(){return 0;}" NEXA_OLLVM_FLA_OK)
        unset(CMAKE_REQUIRED_FLAGS)
        if(NEXA_OLLVM_FLA_OK)
            set_source_files_properties(
                src/license/Guard.cpp
                src/license/LicenseToken.cpp
                src/license/KeyIntegrity.cpp
                src/license/LicenseManager.cpp
                PROPERTIES COMPILE_OPTIONS "-mllvm;-fla;-mllvm;-bcf;-mllvm;-sub")
            message(STATUS "OLLVM control-flow flattening applied to licence sources")
        else()
            message(STATUS "NEXA_LLVM_OBFUSCATION requested but the toolchain has no -fla; skipping")
        endif()
    endif()
elseif(NEXA_OBFUSCATE_LICENSE AND NOT NEXA_DEV_BUILD)
    message(WARNING
        "Licence guard obfuscation is OFF because CMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}. "
        "Build with -DCMAKE_BUILD_TYPE=Release for anything you ship.")
endif()

# On Windows, build the GUI as a windows-subsystem (GUI) app so launching it does
# NOT pop up a black console window. Qt6::Core supplies the WinMain entry point
# automatically for WIN32_EXECUTABLE targets. NOTE: only nexa gets this — the
# native-messaging host (nexa-host) MUST stay a console app, as it speaks the
# browser's stdio protocol over its console stdin/stdout streams.
if(WIN32)
    set_target_properties(nexa PROPERTIES WIN32_EXECUTABLE TRUE)
    target_link_libraries(nexa PRIVATE Advapi32)
endif()

# The version the app reports to the update feed, the licence server and the
# extension's ping. Defined from the project version so it can never drift from
# the installer / package version again (main.cpp carried its own "0.2.0").
target_compile_definitions(nexa PRIVATE NEXA_VERSION="${PROJECT_VERSION}")

# macOS: build a real .app bundle so Finder/Launchpad treat it as an app and the
# icon + identifier are right. nexa-host stays a plain command-line binary; the
# browsers exec it directly by path.
if(APPLE)
    set_target_properties(nexa PROPERTIES
        MACOSX_BUNDLE TRUE
        MACOSX_BUNDLE_BUNDLE_NAME "Nexa"
        MACOSX_BUNDLE_GUI_IDENTIFIER "com.nexa.downloadmanager"
        MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
        MACOSX_BUNDLE_COPYRIGHT "Nexa Download Manager")
endif()

# Native messaging bridge — a tiny standalone exe the browsers launch.
add_executable(nexa-host
    native-host/nexa-host.cpp
)
target_link_libraries(nexa-host PRIVATE
    Qt6::Core
    Qt6::Network
)
target_include_directories(nexa-host PRIVATE src)

install(TARGETS nexa nexa-host RUNTIME DESTINATION bin BUNDLE DESTINATION bin)

# ---------------------------------------------------------------------------
# Desktop integration files (Linux). These are installed relative to the
# install prefix (/usr for a .deb), giving the standard XDG locations:
#   /usr/share/applications/nexa.desktop
#   /usr/share/icons/hicolor/256x256/apps/nexa.png
#   /usr/share/pixmaps/nexa.png   (fallback for older menus)
# ---------------------------------------------------------------------------
if(NOT WIN32)
    install(FILES packaging/nexa.desktop
        DESTINATION share/applications)
    install(FILES assets/nexa-256.png
        DESTINATION share/icons/hicolor/256x256/apps
        RENAME nexa.png)
    install(FILES assets/nexa.png
        DESTINATION share/pixmaps)
    # Browser-extension auto-install: the .deb postinst runs this as root so
    # every browser on the machine picks the extension up on its next start.
    install(PROGRAMS packaging/register-browser-extensions
        DESTINATION share/nexa)
    install(FILES packaging/extension-ids.env
        DESTINATION share/nexa)
endif()

# ---------------------------------------------------------------------------
# Translations: compile every translations/nexa_<lang>.ts into a .qm and install
# it next to the binary (and under share/nexa for the .deb). Localization.cpp
# searches both locations at runtime.
file(GLOB NEXA_TS_FILES "${CMAKE_CURRENT_SOURCE_DIR}/translations/nexa_*.ts")
if(Qt6LinguistTools_FOUND AND NEXA_TS_FILES)
    qt_add_translations(nexa TS_FILES ${NEXA_TS_FILES}
        QM_FILES_OUTPUT_VARIABLE NEXA_QM_FILES)
    install(FILES ${NEXA_QM_FILES} DESTINATION share/nexa/translations)
elseif(NEXA_TS_FILES)
    message(STATUS "Qt6 LinguistTools not found - shipping untranslated (English) UI")
endif()

# Auth-layer unit tests (built opt-in: cmake -DNEXA_BUILD_TESTS=ON). Run with
# ./build/nexa_auth_test — no QtTest dependency, exits non-zero on any failure.
option(NEXA_BUILD_TESTS "Build Nexa unit tests" OFF)
if(NEXA_BUILD_TESTS)
    add_executable(nexa_auth_test
        tests/AuthTest.cpp
        src/auth/CookieFile.cpp
        src/auth/AuthUtils.cpp
        src/auth/AuthenticationManager.cpp
    )
    target_include_directories(nexa_auth_test PRIVATE src)
    target_link_libraries(nexa_auth_test PRIVATE Qt6::Core Qt6::Network)

    # Formatter tests (humanSize/humanSpeed/humanTime). UiHelpers pulls Widgets.
    add_executable(nexa_format_test
        tests/FormatTest.cpp
        src/ui/UiHelpers.cpp
        src/ui/Theme.cpp
    )
    target_include_directories(nexa_format_test PRIVATE src)
    target_link_libraries(nexa_format_test PRIVATE Qt6::Core Qt6::Widgets)

    # Theme catalogue: contrast + completeness for every built-in look.
    add_executable(nexa_theme_test
        tests/ThemeContrastTest.cpp
        src/ui/Theme.cpp
        src/ui/Motion.cpp
    )
    target_include_directories(nexa_theme_test PRIVATE src)
    target_link_libraries(nexa_theme_test PRIVATE Qt6::Core Qt6::Widgets)

    add_executable(nexa_public_url_test
        tests/PublicUrlPolicyTest.cpp
        src/web/PublicUrlPolicy.cpp
    )
    target_include_directories(nexa_public_url_test PRIVATE src)
    target_link_libraries(nexa_public_url_test PRIVATE Qt6::Core Qt6::Network)

    add_executable(nexa_cloud_providers_test
        tests/CloudProvidersTest.cpp
        src/auth/CloudProviders.cpp
        resources.qrc
    )
    target_include_directories(nexa_cloud_providers_test PRIVATE src)
    target_link_libraries(nexa_cloud_providers_test PRIVATE Qt6::Core Qt6::Network)

    add_executable(nexa_range_integrity_test
        tests/RangeIntegrityTest.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/auth/AuthUtils.cpp
        src/web/PublicUrlPolicy.cpp
    )
    target_include_directories(nexa_range_integrity_test PRIVATE src)
    target_link_libraries(nexa_range_integrity_test PRIVATE Qt6::Core Qt6::Network)

    # Download categories: the matching rule (which the user reorders by hand)
    # and the SQLite rows behind it, including the delete that has to clear the
    # id off every download that referenced it.
    add_executable(nexa_categories_test
        tests/CategoriesTest.cpp
        src/core/Categories.cpp
        src/core/Database.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/auth/AuthUtils.cpp
        src/auth/CloudProviders.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_categories_test PRIVATE src)
    target_link_libraries(nexa_categories_test PRIVATE Qt6::Core Qt6::Network Qt6::Sql)

    add_executable(nexa_database_persistence_test
        tests/DatabasePersistenceTest.cpp
        src/core/Database.cpp
        src/core/Categories.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/auth/AuthUtils.cpp
        src/auth/CloudProviders.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_database_persistence_test PRIVATE src)
    target_link_libraries(nexa_database_persistence_test PRIVATE
        Qt6::Core Qt6::Network Qt6::Sql)

    # Engine helpers: links the real DownloadEngine translation unit (and its
    # dependency closure) so the tested code is the shipped code, not a copy.
    # The website grabber's decisions, with no network in the loop: the save
    # path it derives from a URL (a "../.." there used to write outside the
    # chosen folder), page-vs-file, the wildcard filters and robots.txt.
    # Links the real DownloadEngine closure because SiteCrawler hands files to
    # the engine, so the tested code is the shipped code.
    add_executable(nexa_site_crawler_test
        tests/SiteCrawlerTest.cpp
        src/grabber/SiteCrawler.cpp
        src/core/DownloadEngine.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/core/Database.cpp
        src/core/Categories.cpp
        src/core/Portable.cpp
        src/core/UpdateChecker.cpp
        src/core/ProxyConfig.cpp
        src/grabber/HlsGrabber.cpp
        src/torrent/TorrentManager.cpp
        src/site/YtDlpGrabber.cpp
        src/site/MegaGrabber.cpp
        src/site/SpotifyGrabber.cpp
        src/ai/AiClient.cpp
        src/auth/AuthenticationManager.cpp
        src/auth/AuthUtils.cpp
        src/auth/BrowserLogin.cpp
        src/auth/CookieFile.cpp
        src/auth/CloudProviders.cpp
        src/license/LicenseManager.cpp
        src/license/LicenseToken.cpp
        src/license/KeyIntegrity.cpp
        src/license/Guard.cpp
        src/license/CredentialStore.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_site_crawler_test PRIVATE src)
    target_link_libraries(nexa_site_crawler_test PRIVATE
        Qt6::Core Qt6::Network Qt6::Sql ${LIBTORRENT_TARGET} OpenSSL::Crypto)

    add_executable(nexa_engine_helpers_test
        tests/EngineHelpersTest.cpp
        # The batch dialog's expansion is a pure static, so it is tested here
        # rather than in a target of its own: this one already links the engine
        # it needs, and no widget is ever constructed.
        src/ui/BatchDownloadDialog.cpp
        src/core/DownloadEngine.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/core/Database.cpp
        src/core/Categories.cpp
        src/core/Portable.cpp
        src/core/UpdateChecker.cpp
        src/core/ProxyConfig.cpp
        src/grabber/HlsGrabber.cpp
        src/torrent/TorrentManager.cpp
        src/site/YtDlpGrabber.cpp
        src/site/MegaGrabber.cpp
        src/site/SpotifyGrabber.cpp
        src/ai/AiClient.cpp
        src/auth/AuthenticationManager.cpp
        src/auth/AuthUtils.cpp
        src/auth/BrowserLogin.cpp
        src/auth/CookieFile.cpp
        src/auth/CloudProviders.cpp
        src/license/LicenseManager.cpp
        src/license/LicenseToken.cpp
        src/license/KeyIntegrity.cpp
        src/license/Guard.cpp
        src/license/CredentialStore.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_engine_helpers_test PRIVATE src)
    target_link_libraries(nexa_engine_helpers_test PRIVATE
        Qt6::Core Qt6::Network Qt6::Sql Qt6::Widgets ${LIBTORRENT_TARGET} OpenSSL::Crypto)

    add_executable(nexa_download_import_test
        tests/DownloadImportTest.cpp
        src/core/DownloadImport.cpp
    )
    target_include_directories(nexa_download_import_test PRIVATE src)
    target_link_libraries(nexa_download_import_test PRIVATE Qt6::Core)

    add_executable(nexa_mega_crypto_test
        tests/MegaCryptoTest.cpp
        src/site/MegaGrabber.cpp
    )
    target_include_directories(nexa_mega_crypto_test PRIVATE src)
    target_link_libraries(nexa_mega_crypto_test PRIVATE Qt6::Core Qt6::Network OpenSSL::Crypto)

    add_executable(nexa_extension_installer_test
        tests/ExtensionInstallerTest.cpp
        src/ipc/ExtensionInstaller.cpp
    )
    target_include_directories(nexa_extension_installer_test PRIVATE src)
    target_link_libraries(nexa_extension_installer_test PRIVATE Qt6::Core)

    # The Explorer hooks against a real registry, redirected under a test key so
    # it never touches the machine's actual shell. A no-op body off Windows.
    add_executable(nexa_shell_integration_test
        tests/ShellIntegrationTest.cpp
        src/shell/ShellIntegration.cpp
        src/core/Portable.cpp
    )
    target_include_directories(nexa_shell_integration_test PRIVATE src)
    target_link_libraries(nexa_shell_integration_test PRIVATE Qt6::Core)

    # End-to-end DownloadTask against a local Range-capable server: worker-thread
    # preallocation, 8-way segmented transfer, sparse destination on Windows.
    add_executable(nexa_download_task_test
        tests/DownloadTaskTest.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/core/Database.cpp
        src/core/Categories.cpp
        src/auth/AuthUtils.cpp
        src/auth/CloudProviders.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_download_task_test PRIVATE src)
    target_link_libraries(nexa_download_task_test PRIVATE Qt6::Core Qt6::Network Qt6::Sql)

    # White-box download core: pause/resume through the database, retry budget,
    # unknown-length (chunked) bodies, validator changes between sessions,
    # dynamic re-segmentation, rate limiting and the schema migration.
    add_executable(nexa_download_core_test
        tests/DownloadCoreTest.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/core/Database.cpp
        src/core/Categories.cpp
        src/auth/AuthUtils.cpp
        src/auth/CloudProviders.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_download_core_test PRIVATE src)
    target_link_libraries(nexa_download_core_test PRIVATE Qt6::Core Qt6::Network Qt6::Sql)
    # Deliberately built WITHOUT NEXA_LICENSE_PUBLIC_KEY: the forgery cases sign
    # tokens with the published development key, so the verifier under test has
    # to be the one that trusts it. A release binary's key is guaranteed by the
    # configure-time check above, not by this target.
    add_executable(nexa_license_token_test
        tests/LicenseTokenTest.cpp
        src/license/LicenseToken.cpp
    )
    target_include_directories(nexa_license_token_test PRIVATE src)
    target_link_libraries(nexa_license_token_test PRIVATE Qt6::Core OpenSSL::Crypto)

    # Drives the real LicenseManager against a real socket to prove offline
    # grace still works for a paying customer. NEXA_DEV_BUILD so the endpoint
    # can be pointed at a local fake server; no NEXA_LICENSE_PUBLIC_KEY so the
    # test can mint tokens with the published development key.
    add_executable(nexa_offline_grace_test
        tests/OfflineGraceTest.cpp
        src/license/LicenseManager.cpp
        src/license/LicenseToken.cpp
        src/license/KeyIntegrity.cpp
        src/license/Guard.cpp
        src/license/CredentialStore.cpp
    )
    target_include_directories(nexa_offline_grace_test PRIVATE src)
    # NEXA_TEST_CREDENTIAL_STORE swaps the OS credential store for an in-process
    # one. Without it these tests store the fake server's licence key in the
    # developer's real Windows Credential Manager / login keyring, where the
    # installed copy of Nexa reads it on its next launch.
    target_compile_definitions(nexa_offline_grace_test PRIVATE
        NEXA_DEV_BUILD NEXA_TEST_CREDENTIAL_STORE)
    target_link_libraries(nexa_offline_grace_test PRIVATE
        Qt6::Core Qt6::Network OpenSSL::Crypto)

    # Account sign-in (the device-authorization flow) against a real socket:
    # the code, the approval, which credential goes on the wire, and the
    # asymmetry between `signed_out` (forget the token) and a lapsed plan
    # (keep it, drop to Free).
    add_executable(nexa_account_signin_test
        tests/AccountSignInTest.cpp
        src/license/LicenseManager.cpp
        src/license/LicenseToken.cpp
        src/license/KeyIntegrity.cpp
        src/license/Guard.cpp
        src/license/CredentialStore.cpp
    )
    target_include_directories(nexa_account_signin_test PRIVATE src)
    target_compile_definitions(nexa_account_signin_test PRIVATE
        NEXA_DEV_BUILD NEXA_TEST_CREDENTIAL_STORE)
    target_link_libraries(nexa_account_signin_test PRIVATE
        Qt6::Core Qt6::Network OpenSSL::Crypto)

    # The licence guard, compiled BOTH ways from the same source, each asserting
    # the same results. No Qt: the guard depends only on the standard library.
    #   nexa_guard_test      — the plain, debuggable path (what dev/test builds use)
    #   nexa_guard_obf_test  — the flattened/opaque/masked path a release ships,
    #                          proving the obfuscation never changes the answer.
    add_executable(nexa_guard_test
        tests/GuardTest.cpp
        src/license/Guard.cpp)
    target_include_directories(nexa_guard_test PRIVATE src)

    add_executable(nexa_guard_obf_test
        tests/GuardTest.cpp
        src/license/Guard.cpp)
    target_include_directories(nexa_guard_obf_test PRIVATE src)
    target_compile_definitions(nexa_guard_obf_test PRIVATE NEXA_OBFUSCATE_LICENSE)

    enable_testing()
    add_test(NAME mega_crypto COMMAND nexa_mega_crypto_test)
    add_test(NAME extension_installer COMMAND nexa_extension_installer_test)
    add_test(NAME shell_integration COMMAND nexa_shell_integration_test)
    add_test(NAME download_import COMMAND nexa_download_import_test)
    add_test(NAME engine_helpers COMMAND nexa_engine_helpers_test)
    add_test(NAME auth   COMMAND nexa_auth_test)
    add_test(NAME format COMMAND nexa_format_test)
    add_test(NAME themes COMMAND nexa_theme_test)
    add_test(NAME public_url COMMAND nexa_public_url_test)
    add_test(NAME cloud_providers COMMAND nexa_cloud_providers_test)
    add_test(NAME range_integrity COMMAND nexa_range_integrity_test)
    add_test(NAME database_persistence COMMAND nexa_database_persistence_test)
    add_test(NAME categories COMMAND nexa_categories_test)
    add_test(NAME site_crawler COMMAND nexa_site_crawler_test)
    add_test(NAME download_task COMMAND nexa_download_task_test)
    add_test(NAME download_core COMMAND nexa_download_core_test)
    add_test(NAME license_token COMMAND nexa_license_token_test)
    add_test(NAME offline_grace COMMAND nexa_offline_grace_test)
    add_test(NAME account_signin COMMAND nexa_account_signin_test)
    add_test(NAME guard COMMAND nexa_guard_test)
    add_test(NAME guard_obfuscated COMMAND nexa_guard_obf_test)
endif()

# ===========================================================================
# Packaging (CPack): Debian .deb on Linux, NSIS .exe installer on Windows.
# ===========================================================================
# --- Release hardening -------------------------------------------------------
#
# None of this stops a determined reverse engineer — nothing client-side can.
# It raises the price: today `nm build/nexa | grep -i licens` lists ~90 named
# symbols, which walks an attacker straight to the entitlement checks. Hiding
# and stripping them means finding those branches by reading disassembly
# instead of reading a symbol table.
#
# Applied to the shipped executables only. Tests keep their symbols so a
# failure is still debuggable, and a debug build is left completely alone.
option(NEXA_HARDEN_RELEASE "Strip symbols and hide visibility in release builds" ON)

# Release and MinSizeRel are the shipping configurations. RelWithDebInfo keeps
# its symbols on purpose (that is what it is for), so hardening is skipped there
# — announced rather than silent, because "I built RelWithDebInfo and shipped it"
# is exactly how an unstripped binary escapes.
if(NEXA_HARDEN_RELEASE AND NOT NEXA_DEV_BUILD
   AND (CMAKE_BUILD_TYPE STREQUAL "Release" OR CMAKE_BUILD_TYPE STREQUAL "MinSizeRel"))
    set(NEXA_HARDENED TRUE)
    foreach(shipped_target nexa nexa-host)
        set_target_properties(${shipped_target} PROPERTIES
            CXX_VISIBILITY_PRESET hidden
            VISIBILITY_INLINES_HIDDEN ON)
    endforeach()

    # -s asks the linker to drop the symbol table outright. Kept separate from
    # visibility because visibility alone still leaves local symbols behind.
    if(NOT MSVC)
        foreach(shipped_target nexa nexa-host)
            target_link_options(${shipped_target} PRIVATE -s)
        endforeach()
    endif()

    # Link-time optimisation also inlines small functions away, which dissolves
    # some of the one-to-one mapping between a gate and a call site. Enabled
    # only when the toolchain actually supports it, since it is not universal
    # across the MinGW/macOS/Linux matrix this ships on.
    include(CheckIPOSupported)
    check_ipo_supported(RESULT NEXA_IPO_OK OUTPUT NEXA_IPO_WHY)
    if(NEXA_IPO_OK)
        foreach(shipped_target nexa nexa-host)
            set_target_properties(${shipped_target} PROPERTIES
                INTERPROCEDURAL_OPTIMIZATION TRUE)
        endforeach()
    else()
        message(STATUS "LTO unavailable, skipping: ${NEXA_IPO_WHY}")
    endif()
    message(STATUS "Release hardening on: symbols hidden and stripped")
elseif(NEXA_HARDEN_RELEASE AND NOT NEXA_DEV_BUILD)
    message(WARNING
        "Release hardening is OFF because CMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}. "
        "This binary keeps its full symbol table, so every licence gate is "
        "findable by name with `nm`. Build with -DCMAKE_BUILD_TYPE=Release "
        "for anything you ship.")
endif()

# Strip anything CPack copies into a package as well.
set(CPACK_STRIP_FILES TRUE)

set(CPACK_PACKAGE_NAME "nexa")
set(CPACK_PACKAGE_VENDOR "Nexa")
set(CPACK_PACKAGE_VERSION_MAJOR "${PROJECT_VERSION_MAJOR}")
set(CPACK_PACKAGE_VERSION_MINOR "${PROJECT_VERSION_MINOR}")
set(CPACK_PACKAGE_VERSION_PATCH "${PROJECT_VERSION_PATCH}")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Nexa Download Manager")
set(CPACK_PACKAGE_DESCRIPTION
    "Nexa is a fast multi-protocol download manager supporting HTTP/HTTPS \
segmented downloads, HLS video streams, BitTorrent, and site-specific media \
extraction via yt-dlp. It ships with a Qt6 GUI and a native-messaging host \
for browser integration.")
set(CPACK_PACKAGE_CONTACT "Nexa Maintainers <tauseeqtufail649@gmail.com>")
# The product's own site. This becomes the .deb's Homepage: field and both
# NSIS links ("help" and "about"), so a placeholder here sent every installer
# user to github.com's front page.
set(CPACK_PACKAGE_HOMEPAGE_URL "https://nexadownloadmanager.com")
set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_PACKAGE_INSTALL_DIRECTORY "Nexa")
set(CPACK_PACKAGING_INSTALL_PREFIX "/usr")

if(WIN32)
    # -----------------------------------------------------------------------
    # Windows: NSIS installer (.exe). Build this ON Windows after running
    # windeployqt against the installed nexa.exe so the Qt6 runtime DLLs and
    # plugins are co-located before CPack collects them. See packaging notes.
    # -----------------------------------------------------------------------
    set(CPACK_GENERATOR "NSIS")
    set(CPACK_NSIS_PACKAGE_NAME "Nexa Download Manager")
    set(CPACK_NSIS_DISPLAY_NAME "Nexa Download Manager")
    set(CPACK_NSIS_MODIFY_PATH ON)
    set(CPACK_NSIS_ENABLE_UNINSTALL_BEFORE_INSTALL ON)
    set(CPACK_NSIS_INSTALLED_ICON_NAME "bin\\\\nexa.exe")
    set(CPACK_NSIS_HELP_LINK "${CPACK_PACKAGE_HOMEPAGE_URL}")
    set(CPACK_NSIS_URL_INFO_ABOUT "${CPACK_PACKAGE_HOMEPAGE_URL}")
    # Start-menu / desktop shortcut to the GUI.
    set(CPACK_PACKAGE_EXECUTABLES "nexa" "Nexa Download Manager")
    set(CPACK_CREATE_DESKTOP_LINKS "nexa")
    # Take the Explorer context-menu / "Open with" keys back out on uninstall.
    # The app writes them itself on first launch (per-user, no elevation), so
    # the installer has nothing to add here -- but an uninstall that left a
    # "New download with Nexa" entry pointing at a deleted exe would be the
    # thing people remember about the product. `nexa --unregister-shell` is a
    # windowless no-op when there is nothing to remove, and the leading quote
    # style is what NSIS needs for a path with spaces.
    set(CPACK_NSIS_EXTRA_UNINSTALL_COMMANDS
        "ExecWait '\"$INSTDIR\\bin\\nexa.exe\" --unregister-shell'")
else()
    # -----------------------------------------------------------------------
    # Linux: Debian .deb.
    # -----------------------------------------------------------------------
    set(CPACK_GENERATOR "DEB")
    set(CPACK_DEBIAN_PACKAGE_MAINTAINER "${CPACK_PACKAGE_CONTACT}")
    set(CPACK_DEBIAN_PACKAGE_SECTION "net")
    set(CPACK_DEBIAN_PACKAGE_PRIORITY "optional")
    set(CPACK_DEBIAN_PACKAGE_HOMEPAGE "${CPACK_PACKAGE_HOMEPAGE_URL}")
    # Auto-resolve library shlib deps from the linked ELF binaries, then add
    # the explicit runtime tools/libraries Nexa shells out to or links against.
    set(CPACK_DEBIAN_PACKAGE_SHLIBDEPS ON)
    set(CPACK_DEBIAN_PACKAGE_DEPENDS
        "libqt6core6t64 (>= 6.4.0) | libqt6core6, \
libqt6network6 (>= 6.4.0), \
libqt6widgets6 (>= 6.4.0), \
libqt6sql6 (>= 6.4.0), \
libqt6sql6-sqlite (>= 6.4.0), \
 libtorrent-rasterbar2.0t64 (>= 2.0) | libtorrent-rasterbar2.0, \
 ffmpeg, \
 yt-dlp, \
 python3-secretstorage, \
 aria2")
    # Maintainer scripts to refresh the desktop/icon caches.
    set(CPACK_DEBIAN_PACKAGE_CONTROL_EXTRA
        "${CMAKE_CURRENT_SOURCE_DIR}/packaging/postinst;\
${CMAKE_CURRENT_SOURCE_DIR}/packaging/postrm")
endif()

include(CPack)
