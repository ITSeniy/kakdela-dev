// КакДела: desktop — системный трей + native notifications (T-086); mobile —
// тот же webview без трея (T-100, Фаза 6). Десктопная обвязка (трей, меню,
// close-to-tray, глобальные хоткеи) изолирована под #[cfg(desktop)], чтобы
// Android-сборка линковалась без tray-icon / window API.

// Секретные чаты (T-101 крипто-ядро + T-102 локальная история) — кросс-платформенно
// (мобайл-онли по смыслу, но компилируется и на desktop ради единого cargo check).
mod commands;
mod crypto;
mod error;
mod os_secrets;
mod sealed;
mod store;

// Нативный захват звука для демонстрации экрана (T-094). Stage 0 — определение
// возможностей ОС; компилируется на всех платформах (вне Windows = Unsupported).
mod audio;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";

#[cfg(desktop)]
const CALL_POPUP_LABEL: &str = "call-popup";

/// Данные текущего входящего звонка (T-087). Окно-попап (статичная страница)
/// забирает их через `get_call_popup_data` — это надёжнее, чем query-параметр
/// (никакого percent-кодирования `?`) и init-скрипта (никаких гонок инъекции).
#[derive(Default)]
struct PendingCall(std::sync::Mutex<Option<String>>);

/// Закрывать окно в трей (true) или выходить (false). Управляется из настроек
/// (set_close_to_tray); читается в обработчике CloseRequested. Дефолт — в трей.
struct CloseToTray(std::sync::atomic::AtomicBool);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // single-instance ОБЯЗАН быть первым плагином (Tauri docs): повторный запуск
    // не плодит окно, а фокусирует уже открытое. Автозапуск регистрируется с
    // флагом --minimized — фронт по нему + настройке решает, прятать ли окно.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }));
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ));
        // Updater (M-5): плагин активен, но check() вернёт ошибку, пока в
        // tauri.conf.json не появятся plugins.updater { endpoints, pubkey } —
        // см. docs/DEPLOY.md §9. Фронт дёргает его только из host/updater.ts.
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::CryptoState::default())
        .manage(commands::HistoryState::default())
        .manage(audio::AudioStreamState::default())
        .manage(PendingCall::default())
        .manage(CloseToTray(std::sync::atomic::AtomicBool::new(true)))
        .invoke_handler(tauri::generate_handler![
            greet,
            focus_main_window,
            notify_with_target,
            set_tray_badge,
            set_taskbar_badge,
            set_close_to_tray,
            keep_awake,
            hide_main_window,
            launched_minimized,
            open_call_popup,
            close_call_popup,
            get_call_popup_data,
            commands::crypto_init,
            commands::crypto_publish_keys,
            commands::crypto_topup,
            commands::crypto_process_bundle,
            commands::crypto_encrypt,
            commands::crypto_decrypt,
            commands::crypto_session_exists,
            commands::crypto_safety_number,
            commands::crypto_clear_session,
            commands::secret_history_append_outgoing,
            commands::secret_history_append_incoming,
            commands::secret_history_mark_read,
            commands::secret_history_list,
            commands::secret_history_peers,
            os_secrets::os_secret_get,
            os_secrets::os_secret_set,
            os_secrets::os_secret_delete,
            relaunch_app,
            audio::audio_capture_capability,
            audio::audio_list_sessions,
            audio::audio_list_windows,
            audio::audio_stream_start,
            audio::audio_stream_stop,
        ])
        .setup(|app| {
            // Вся десктопная обвязка — в setup_desktop под cfg(desktop).
            #[cfg(desktop)]
            setup_desktop(app)?;
            #[cfg(not(desktop))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ───── Desktop-only: трей, меню, close-to-tray, глобальные хоткеи ─────

#[cfg(desktop)]
fn setup_desktop(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Глобальные хоткеи (мут/деафен при свёрнутом окне) — desktop only.
    app.handle()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

    let show_i = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    // Иконку трея берём из default_window_icon (он же icon.ico). На Windows
    // tray-icon рендерит её 16×16, чего достаточно.
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("default window icon is not configured")?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("как дела")
        .menu(&menu)
        // По умолчанию click по trayicon на Windows показывает меню — нам это не
        // нужно, мы вместо этого toggle'им окно.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // Close-to-tray: перехватываем закрытие главного окна. Если в настройках
    // выбрано «сворачивать в трей» (дефолт) — прячем; иначе даём окну закрыться
    // (приложение завершится). Полный quit всегда доступен через меню трея.
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let win_clone = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let to_tray = win_clone
                    .app_handle()
                    .state::<CloseToTray>()
                    .0
                    .load(std::sync::atomic::Ordering::Relaxed);
                if to_tray {
                    api.prevent_close();
                    let _ = win_clone.hide();
                }
            }
        });
    }

    // Окно-попап звонка (T-087) переиспользуется: любое закрытие (Alt+F4) —
    // прячем, а не уничтожаем, иначе следующий звонок не найдёт окно.
    if let Some(popup) = app.get_webview_window(CALL_POPUP_LABEL) {
        let popup_clone = popup.clone();
        popup.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = popup_clone.hide();
            }
        });
    }

    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("привет, {}!", name)
}

/// Клик по native-notification: показать и сфокусировать окно (desktop).
/// На mobile окна-в-трее нет — no-op.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
    #[cfg(desktop)]
    show_main_window(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Спрятать главное окно в трей (используется при автозапуске с --minimized).
#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }
    #[cfg(not(desktop))]
    let _ = app;
}

/// Запущено ли приложение с флагом автозапуска (--minimized). Фронт по нему +
/// настройке «стартовать свёрнутым» решает, прятать ли окно.
#[tauri::command]
fn launched_minimized() -> bool {
    std::env::args().any(|a| a == "--minimized")
}

/// Переключатель «закрывать в трей vs выходить» — пишет в managed-флаг, который
/// читает обработчик CloseRequested.
#[tauri::command]
fn set_close_to_tray(app: tauri::AppHandle, to_tray: bool) {
    use tauri::Manager;
    app.state::<CloseToTray>()
        .0
        .store(to_tray, std::sync::atomic::Ordering::Relaxed);
}

/// Числовой бейдж непрочитанного на иконке таскбара (Windows). Картинку рисует
/// фронт (canvas → base64 PNG); `None` — снять бейдж. На Windows нативный
/// set_badge_count не работает — используется overlay-иконка.
#[tauri::command]
fn set_taskbar_badge(app: tauri::AppHandle, icon_base64: Option<String>) {
    #[cfg(windows)]
    {
        use tauri::image::Image;
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else { return };
        match icon_base64 {
            Some(b64) => {
                use base64::engine::general_purpose::STANDARD;
                use base64::Engine;
                if let Ok(bytes) = STANDARD.decode(b64.as_bytes()) {
                    if let Ok(img) = Image::from_bytes(&bytes) {
                        let _ = window.set_overlay_icon(Some(img));
                    }
                }
            }
            None => {
                let _ = window.set_overlay_icon(None);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (app, icon_base64);
}

/// Не давать системе уснуть/гасить экран, пока true (на время звонка). На
/// Windows — SetThreadExecutionState на главном потоке (там состояние
/// долгоживущее и корректно сбрасывается тем же вызовом с ES_CONTINUOUS).
#[tauri::command]
fn keep_awake(app: tauri::AppHandle, on: bool) {
    #[cfg(windows)]
    {
        let _ = app.run_on_main_thread(move || {
            const ES_CONTINUOUS: u32 = 0x8000_0000;
            const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
            const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
            extern "system" {
                fn SetThreadExecutionState(es_flags: u32) -> u32;
            }
            let flags = if on {
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
            } else {
                ES_CONTINUOUS
            };
            unsafe {
                SetThreadExecutionState(flags);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, on);
}

/// Перезапуск приложения (после установки обновления). Никогда не возвращается.
#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

/// Готовит круглую иконку тоста (appLogoOverride): аватар автора, отрисованный
/// фронтом в canvas (base64 PNG), а при его отсутствии/ошибке — встроенное лого
/// приложения. Пишем во временный файл (WinRT грузит картинку по file:// в
/// момент показа).
///
/// Аудит 2026-08 (L): имя файла НЕ предсказуемо — случайный hex в выделенном
/// подкаталоге %TEMP%\kakdela-toast\ (никаких общих слотов, которые другой
/// процесс мог бы подменить между записью и показом тоста). Протухшие файлы
/// (>1 ч) подчищаем на каждой записи — WinRT успевает прочитать иконку при
/// показе, а тосты не живут часами.
#[cfg(windows)]
fn write_toast_icon(icon_base64: Option<String>) -> Option<std::path::PathBuf> {
    use rand::RngCore;

    let dir = std::env::temp_dir().join("kakdela-toast");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    cleanup_stale_icons(&dir);

    let mut name = [0u8; 8];
    crate::sealed::os_rng().fill_bytes(&mut name);
    let hex: String = name.iter().map(|b| format!("{b:02x}")).collect();

    if let Some(b64) = icon_base64 {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        if let Ok(bytes) = STANDARD.decode(b64.as_bytes()) {
            let path = dir.join(format!("kakdela-toast-{hex}.png"));
            if std::fs::write(&path, &bytes).is_ok() {
                return Some(path);
            }
        }
    }
    // Фолбэк — встроенное лого приложения (всегда доступно, без сети).
    const LOGO: &[u8] = include_bytes!("../icons/128x128.png");
    let path = dir.join(format!("kakdela-logo-{hex}.png"));
    if std::fs::write(&path, LOGO).is_ok() {
        return Some(path);
    }
    None
}

/// Чистит иконки тостов старше часа (тосты к тому моменту давно скрыты).
#[cfg(windows)]
fn cleanup_stale_icons(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let max_age = std::time::Duration::from_secs(3600);
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Нативный тост с переходом по клику. Десктоп-плагин активацию в JS не
/// пробрасывает (notify-rust `.show()` без обработчика), поэтому на Windows
/// показываем тост сами через `tauri-winrt-notification`: круглая иконка слева
/// (appLogoOverride) + жирный заголовок + строка (в духе Discord), клик ловим в
/// `on_activated` → эмитим `notify-activated` с целевым URL. Фронт слушает
/// событие и переходит к сообщению (см. lib/host/notify.ts).
#[tauri::command]
fn notify_with_target(
    app: tauri::AppHandle,
    title: String,
    body: String,
    target: String,
    icon_base64: Option<String>,
) {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        use tauri_winrt_notification::{IconCrop, Toast};

        // app_id: установленное приложение → его identifier (AUMID регистрирует
        // инсталлятор); dev-сборка из target/debug|release → POWERSHELL_APP_ID,
        // он всегда зарегистрирован и ловит клик в процессе.
        let app_id = {
            let identifier = app.config().identifier.clone();
            let is_dev = tauri::utils::platform::current_exe()
                .ok()
                .and_then(|e| e.parent().map(|p| p.to_path_buf()))
                .map(|d| {
                    let s = d.to_string_lossy().to_lowercase();
                    s.ends_with("\\target\\debug") || s.ends_with("\\target\\release")
                })
                .unwrap_or(false);
            if is_dev {
                Toast::POWERSHELL_APP_ID.to_string()
            } else {
                identifier
            }
        };

        let icon_path = write_toast_icon(icon_base64);
        let app_for_cb = app.clone();

        let mut toast = Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            // Тихий тост: звук уведомления играет само приложение
            // (playSound('notification')); системный звук Windows был бы дублем.
            .sound(None);
        if let Some(path) = &icon_path {
            toast = toast.icon(path, IconCrop::Circular, "");
        }
        let res = toast
            .on_activated(move |_action| {
                let _ = app_for_cb.emit("notify-activated", target.clone());
                Ok(())
            })
            .show();
        if let Err(err) = res {
            eprintln!("[notify] winrt toast failed: {err:?}");
        }
    }
    #[cfg(not(windows))]
    {
        // macOS/Linux/mobile: переход по клику плагином не поддержан — просто
        // показываем тост (приложение Windows-first, регрессии тут нет).
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
        let _ = (target, icon_base64);
    }
}

/// Badge с unread count поверх trayicon (desktop). На mobile трея нет — no-op.
///
/// В Tauri 2 нет встроенного «нарисуй число поверх иконки» — самое близкое
/// доступное на всех desktop-платформах — поменять tooltip; на macOS также
/// ставим текстовый badge у menu-bar иконки. `count == 0` → дефолтный tooltip.
#[tauri::command]
fn set_tray_badge(app: tauri::AppHandle, count: u32) {
    #[cfg(desktop)]
    {
        let Some(tray) = app.tray_by_id("main") else { return };
        let tooltip = if count == 0 {
            "как дела".to_string()
        } else if count > 99 {
            "как дела · 99+ непрочитанных".to_string()
        } else {
            format!("как дела · {} непрочитанных", count)
        };
        let _ = tray.set_tooltip(Some(&tooltip));
        #[cfg(target_os = "macos")]
        {
            let title = if count == 0 {
                None
            } else if count > 99 {
                Some("99+".to_string())
            } else {
                Some(count.to_string())
            };
            let _ = tray.set_title(title.as_deref());
        }
    }
    #[cfg(not(desktop))]
    let _ = (app, count);
}

/// Входящий DM-звонок (T-087): на desktop ПОКАЗЫВАЕМ отдельное маленькое окно
/// поверх всех окон — звонок видно, даже когда КакДела свёрнут или перекрыт.
/// Окно НЕ создаём на лету (рантайм-создание второго webview на Windows виснет
/// белым) — оно заранее объявлено в tauri.conf.json (label `call-popup`,
/// visible:false) и грузит статичную public/call-popup.html. Здесь лишь кладём
/// данные в state, дёргаем страницу событием `call-popup-show` (она перечитает
/// get_call_popup_data) и показываем окно. На mobile — no-op (хватает тоста).
#[tauri::command]
fn open_call_popup(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingCall>,
    channel_id: String,
    from_name: String,
    from_avatar_url: Option<String>,
) {
    // Кладём данные звонка в app-state — попап заберёт их через get_call_popup_data.
    let json = serde_json::json!({
        "channelId": channel_id,
        "fromName": from_name,
        "fromAvatarUrl": from_avatar_url,
    })
    .to_string();
    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(json);
    }
    #[cfg(desktop)]
    {
        use tauri::Emitter;
        if let Some(win) = app.get_webview_window(CALL_POPUP_LABEL) {
            // Просим (уже загруженную) страницу перечитать данные и показываем.
            let _ = win.emit("call-popup-show", ());
            let _ = win.show();
            // current_monitor знает монитор только после show — позиционируем после.
            position_call_popup(&win);
            let _ = win.set_always_on_top(true);
            let _ = win.set_focus();
        }
    }
    #[cfg(not(desktop))]
    let _ = app;
}

/// Статичная страница попапа забирает данные текущего звонка отсюда.
#[tauri::command]
fn get_call_popup_data(state: tauri::State<'_, PendingCall>) -> Option<String> {
    state.0.lock().ok().and_then(|g| g.clone())
}

/// Скрыть попап входящего звонка (после принятия/отклонения/таймаута/отмены).
/// Именно hide (не close): окно переиспользуется, не пересоздаётся.
#[tauri::command]
fn close_call_popup(app: tauri::AppHandle) {
    #[cfg(desktop)]
    {
        if let Some(win) = app.get_webview_window(CALL_POPUP_LABEL) {
            let _ = win.hide();
        }
    }
    #[cfg(not(desktop))]
    let _ = app;
}

/// Ставим попап в правый верхний угол текущего монитора с небольшим отступом.
#[cfg(desktop)]
fn position_call_popup(win: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = win.current_monitor() else {
        return;
    };
    let Ok(win_size) = win.outer_size() else {
        return;
    };
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let margin = (16.0 * monitor.scale_factor()).round() as i32;
    let x = mon_pos.x + mon_size.width as i32 - win_size.width as i32 - margin;
    let y = mon_pos.y + margin;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else { return };
    match window.is_visible() {
        Ok(true) => {
            // is_visible не учитывает minimized: если окно «висит» в taskbar,
            // лучше показать и сфокусировать, а не спрятать.
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            } else if window.is_focused().unwrap_or(false) {
                let _ = window.hide();
            } else {
                let _ = window.set_focus();
            }
        }
        _ => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}
