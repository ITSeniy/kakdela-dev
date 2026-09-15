# Android: разработка и ограничения

Сверено с исходниками 2026-09-15. Мобильное направление — личные cloud-DM, звонки 1:1 и device-bound секретные чаты. Серверная навигация desktop в MobileShell не переносится. [Текущий этап](../.claude/CURRENT_PHASE.md) · [T-100](../tasks/T-100.md) · [T-101](../tasks/T-101.md) · [T-102](../tasks/T-102.md) · [T-103](../tasks/T-103.md).

**Текущий блокер секретных чатов:** в `src-tauri/src/sealed.rs` Android DEK-провайдер возвращает `keychain-unavailable`. Android Keystore ещё не реализован. Июньская сборка/работа software-провайдера, описанная в старых карточках, не подтверждает работоспособность текущей версии.

## UI без Android toolchain

Выполнить [локальную настройку](DEVELOPMENT.md), затем:

```sh
pnpm dev:web
```

Открыть `http://localhost:1420`, сузить окно до 600 px или меньше. `app/useIsMobile.ts` выбирает MobileShell по ширине в web и по платформе на native mobile. Это позволяет проверить layout и cloud-DM; native secret-chat API в browser-режиме возвращает `secret-chats-unsupported`.

## Нативное окружение

Общие требования: Node 24 / pnpm 9.12.0, Rust и `protoc`. Для Android дополнительно нужны Android SDK, NDK, JDK и Rust targets.

Исторически **2026-06-27** APK был собран и запущен на Pixel 10 Pro x86_64 эмуляторе с **JDK 17** и **NDK 30.0.14904198**. Эти версии — сохранённое рабочее окружение, не свежая проверка нынешнего HEAD.

Пример настройки PowerShell, пути адаптировать к установленным версиям:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA/Android/Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NDK_HOME = "$env:ANDROID_HOME/ndk/30.0.14904198"
$env:JAVA_HOME = 'C:/Program Files/Eclipse Adoptium/jdk-17.0.19.10-hotspot'
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
java -version
protoc --version
```

На Windows `JAVA_HOME` должен быть Windows-путём (`C:/...`), даже при запуске из Git Bash: `gradlew.bat` не понимает `/c/...`.

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cargo install cargo-ndk
# Из корня репозитория:
cargo ndk -t x86_64 --platform 24 check --manifest-path packages/polly/src-tauri/Cargo.toml
```

## Сборка

`packages/polly/src-tauri/gen/android` уже отслеживается в Git; `tauri android init` повторно не нужен. Manifest, Gradle и платформенные исходники ревьюятся; `build/`, `.gradle` и `local.properties` — локальные артефакты.

```sh
# Эмулятор x86_64:
pnpm --filter @kakdela/polly exec tauri android build --debug --target x86_64
# Физическое arm64-устройство: использовать --target aarch64

# Dev с горячей перезагрузкой:
pnpm --filter @kakdela/polly exec tauri android dev
```

APK для указанной debug-сборки ожидается в `packages/polly/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

Пример установки на уже запущенный эмулятор в PowerShell:

```powershell
$androidAdb = "$env:ANDROID_HOME/platform-tools/adb.exe"
& $androidAdb install -r packages/polly/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
& $androidAdb shell monkey -p com.kakdela.polly -c android.intent.category.LAUNCHER 1
```

## Backend и голос

`polly/src/lib/serverUrl.ts` отдаёт приоритет build-time `VITE_SPEEDY_URL`. Без него Android использует `http://10.0.2.2:3001` (хост эмулятора), desktop/web — `http://localhost:3001`. Физическому телефону нужен доступный LAN-адрес или домен. Env-файлы Vite лежат в `packages/polly`, см. [DEVELOPMENT](DEVELOPMENT.md).

Для production использовать HTTPS backend, WSS событий и WSS `/livekit` admission gateway. Прямой SFU :7880 клиенту не задавать. Cleartext разрешён в debug-манифесте. Доступ к микрофону/камере, разрешения WebView, звонок A→B и reconnect проверять на реальных целевых устройствах отдельно.

## Auth-хранилище и ключи секретных чатов

Это два отдельных механизма:

- `lib/host/secrets.ts`: native OS-keychain с fallback в AES-GCM/IndexedDB и sessionStorage. `features/auth/api.ts` сохраняет user + access token в `kd:session`, native refresh — отдельным ключом. Web refresh обычно обслуживается httpOnly-cookie. Поэтому описание «Android уже использует Keystore» неверно.
- `src-tauri/src/sealed.rs`: общий DEK для crypto/history требует безопасного native keychain. SoftwareKeyProvider применяется тестами; вне тестов fallback отключён, на Android провайдер пока отказывает.

Внедрение Android Keystore, разделение server/account/device и безопасное восстановление — открытые части №4/17 [аудита](../audit-fixes.md). Потерянный DEK нельзя заменять новым поверх прежних зашифрованных данных.

## Криптография и транспорт

Ядро libsignal закреплено на `v0.96.4` в Cargo.toml: PQXDH и Double Ratchet. `src-tauri/src/crypto/` хранит native ключи/состояние; `store/local_db.rs` — зашифрованный снапшот истории. Host API предоставляет UI расшифрованные сообщения, но не приватные ключи/ratchet-записи.

Сервер хранит публичные prekey и непрозрачные конверты. Текст/receipt/typing кодируются в зашифрованном SecretFrame; сервер всё же видит отправителя, получателя, время, размер и тип ciphertext libsignal. ACK удаляет доставленный конверт.

Атомарность отдельного файла не обеспечивает атомарность всего приёма: ratchet и history сохраняются отдельно, остаётся окно потери сообщения при сбое. Журнал приёма, идемпотентный outbox и fault-injection ещё нужны (№5 аудита). Device-bound история не синхронизируется между устройствами и не попадает в серверный backup.

## Исторические заметки по Windows-сборке

- ABI должна соответствовать устройству; Windows-эмулятор обычно требует x86_64, даже если поддерживает трансляцию ARM.
- Если Gradle не находит `pnpm`, проверить PATH именно процесса Gradle и доступность `.cmd`/`.bat` launcher. В старом окружении standalone pnpm требовал дополнительный `.bat` shim.
- В Git Bash `adb` может получить переписанные MSYS пути; для таких команд применяется `MSYS_NO_PATHCONV=1`.
- Большая debug `.so` может исчерпать диск эмулятора. Сброс AVD удаляет данные устройства; предпочтительно сначала проверить занятое место и выбранный вариант сборки.

Эти наблюдения не заменяют новый native-прогон. Проверки Windows Rust и обычные JS-тесты перечислены в [DEVELOPMENT](DEVELOPMENT.md); текущий CI не собирает Android APK.
