cmake_minimum_required(VERSION 3.21)
project(Nexa VERSION 0.2.1 LANGUAGES CXX DESCRIPTION "Nexa Download Manager")

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
    src/core/Database.cpp
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
    src/web/WebServer.cpp
    src/web/PublicUrlPolicy.cpp
    src/ui/UiHelpers.cpp
    src/ui/DownloadDetailsDialog.cpp
    src/ui/SiteLoginsDialog.cpp
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

# Developer overrides for the network endpoints the app trusts — the licence
# API (NEXA_LICENSE_API_URL, NEXA_ALLOW_INSECURE_LICENSE_API), the ad feed
# (NEXA_ADS_API_URL) and the update feed (NEXA_UPDATE_URL). They exist so a
# developer can point a build at localhost. In a shipped binary the same
# variables let anyone redirect licence validation to a server that answers
# "pro" — or, worse, the updater to a feed that hands it an installer to run.
# OFF by default, so a release build compiles every one of those lookups out;
# turn it on for a local dev build: cmake -DNEXA_DEV_OVERRIDES=ON ...
option(NEXA_DEV_OVERRIDES "Honour NEXA_*_URL environment overrides (dev builds only)" OFF)
if(NEXA_DEV_OVERRIDES)
    target_compile_definitions(nexa PRIVATE NEXA_DEV_OVERRIDES=1)
    message(WARNING "NEXA_DEV_OVERRIDES is ON: this build trusts NEXA_* endpoint overrides. Never ship it.")
endif()

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

    add_executable(nexa_database_persistence_test
        tests/DatabasePersistenceTest.cpp
        src/core/Database.cpp
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
    add_executable(nexa_engine_helpers_test
        tests/EngineHelpersTest.cpp
        src/core/DownloadEngine.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/core/Database.cpp
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
        src/license/CredentialStore.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_engine_helpers_test PRIVATE src)
    target_link_libraries(nexa_engine_helpers_test PRIVATE
        Qt6::Core Qt6::Network Qt6::Sql ${LIBTORRENT_TARGET} OpenSSL::Crypto)

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

    # End-to-end DownloadTask against a local Range-capable server: worker-thread
    # preallocation, 8-way segmented transfer, sparse destination on Windows.
    add_executable(nexa_download_task_test
        tests/DownloadTaskTest.cpp
        src/core/DownloadTask.cpp
        src/core/SegmentDownloader.cpp
        src/core/RateLimiter.cpp
        src/core/Database.cpp
        src/auth/AuthUtils.cpp
        src/auth/CloudProviders.cpp
        src/web/PublicUrlPolicy.cpp
        resources.qrc
    )
    target_include_directories(nexa_download_task_test PRIVATE src)
    target_link_libraries(nexa_download_task_test PRIVATE Qt6::Core Qt6::Network Qt6::Sql)

    enable_testing()
    add_test(NAME mega_crypto COMMAND nexa_mega_crypto_test)
    add_test(NAME extension_installer COMMAND nexa_extension_installer_test)
    add_test(NAME download_import COMMAND nexa_download_import_test)
    add_test(NAME engine_helpers COMMAND nexa_engine_helpers_test)
    add_test(NAME auth   COMMAND nexa_auth_test)
    add_test(NAME format COMMAND nexa_format_test)
    add_test(NAME themes COMMAND nexa_theme_test)
    add_test(NAME public_url COMMAND nexa_public_url_test)
    add_test(NAME cloud_providers COMMAND nexa_cloud_providers_test)
    add_test(NAME range_integrity COMMAND nexa_range_integrity_test)
    add_test(NAME database_persistence COMMAND nexa_database_persistence_test)
    add_test(NAME download_task COMMAND nexa_download_task_test)
endif()

# ===========================================================================
# Packaging (CPack): Debian .deb on Linux, NSIS .exe installer on Windows.
# ===========================================================================
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
set(CPACK_PACKAGE_HOMEPAGE_URL "https://github.com/")
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
