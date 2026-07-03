// T-094 — нативный захват системного/процессного звука (Windows, WASAPI).
//
// ЭТО STAGE 0: определение возможностей ОС. Сам захват PCM и мост в WebRTC
// (кастомный трек в существующую LiveKit-комнату) добавятся следующими
// стадиями — см. tasks/T-094.md. Транспорт остаётся LiveKit, Mediasoup НЕ
// вводим (осознанное решение, ARCHITECTURE.md §3.5).
//
// Две ступени захвата на Windows и их доступность по версии ОС:
//   • System loopback — весь звук устройства вывода (AUDCLNT_STREAMFLAGS_LOOPBACK).
//     Есть со времён Vista, гейта по билду нет.
//   • Process loopback — звук ОДНОГО приложения (по-дискордовски), через
//     ActivateAudioInterfaceAsync + AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS.
//     API появился в Windows 10 version 2004 = build 19041 (май 2020). Microsoft
//     в официальном сэмпле документирует минимум build 20348 (Server 2022/Win11),
//     но на практике (OBS win-capture-audio, Discord) фича работает с 19041.
//     Поэтому порог ставим 19041 — это и есть «не Win11-only», как и хотели.
//
// ВАЖНО: билд-номер — это БЫСТРЫЙ ХИНТ для UI, а не гарантия. Источник истины —
// реальная попытка активации в Stage B: если ActivateAudioInterfaceAsync с
// process-loopback вернёт ошибку на конкретной машине, откатываемся на
// system-loopback. Так дизайн устойчив к расхождению 19041-vs-20348.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::error::CmdError;

// Stage A/B/C — сам WASAPI loopback-захват (Windows-only).
#[cfg(windows)]
mod capture;

/// Практический минимум билда Windows 10 для process-loopback (version 2004).
/// Официальный минимум Microsoft — 20348; держим 19041 как реально работающий
/// across OBS/Discord, с runtime-фолбэком на system-loopback при ошибке.
#[cfg(windows)]
const PROCESS_LOOPBACK_MIN_BUILD: u32 = 19041;

/// Высшая доступная ступень нативного захвата звука на этой машине.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum AudioCaptureMode {
    /// Нативный захват недоступен (не Windows, либо слишком старый билд).
    /// Конструируется только в ветке `cfg(not(windows))` — на Windows-сборке
    /// это «мёртвый» вариант, отсюда allow.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    /// Доступен только захват всего системного звука (устройство вывода).
    SystemLoopback,
    /// Доступен захват звука отдельного процесса (и весь системный — тоже).
    ProcessLoopback,
}

/// Возможности ОС по части нативного захвата звука — отдаётся в JS (camelCase).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioCapability {
    /// Высшая доступная ступень захвата.
    pub mode: AudioCaptureMode,
    /// Доступен ли захват всего системного звука.
    pub system_loopback: bool,
    /// Доступен ли per-process захват.
    pub process_loopback: bool,
    /// Номер билда Windows (0 — не Windows / не удалось определить).
    pub build_number: u32,
}

/// Истинный билд Windows через RtlGetVersion (ntdll) — единственный способ без
/// манифеста: GetVersionEx шимится и врёт неманифестированным приложениям
/// (отдаёт 6.2). RtlGetVersion не шимится и всегда возвращает STATUS_SUCCESS.
#[cfg(windows)]
fn windows_build_number() -> u32 {
    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform_id: u32,
        csd_version: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }
    let mut info: OsVersionInfoW = unsafe { std::mem::zeroed() };
    info.size = std::mem::size_of::<OsVersionInfoW>() as u32;
    unsafe { RtlGetVersion(&mut info) };
    info.build
}

/// Классифицирует возможности захвата на текущей ОС.
pub fn detect_capability() -> AudioCapability {
    #[cfg(windows)]
    {
        let build = windows_build_number();
        let process_loopback = build >= PROCESS_LOOPBACK_MIN_BUILD;
        AudioCapability {
            mode: if process_loopback {
                AudioCaptureMode::ProcessLoopback
            } else {
                AudioCaptureMode::SystemLoopback
            },
            // System loopback есть на любой поддерживаемой Windows.
            system_loopback: true,
            process_loopback,
            build_number: build,
        }
    }
    #[cfg(not(windows))]
    {
        AudioCapability {
            mode: AudioCaptureMode::Unsupported,
            system_loopback: false,
            process_loopback: false,
            build_number: 0,
        }
    }
}

/// Что умеет ОС по части нативного захвата звука (Stage 0, T-094).
#[tauri::command]
pub fn audio_capture_capability() -> AudioCapability {
    detect_capability()
}

/// Аудио-сессия для пользовательского пикера: pid + имя + играет ли сейчас.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionEntry {
    pub pid: u32,
    pub name: String,
    pub active: bool,
}

/// Список «звучащих» приложений (аудио-сессии устройства вывода) — основа
/// пикера «звук приложения». Не сыпет все процессы системы, а только те, что
/// реально способны звучать.
///
/// async + spawn_blocking ОБЯЗАТЕЛЬНО: внутри COM-цикл (`CoInitializeEx`
/// MULTITHREADED). Синхронная команда исполнилась бы на главном потоке, который
/// уже COM-инициализирован как STA → `CoInitializeEx(MTA)` вернул бы
/// RPC_E_CHANGED_MODE и список оказался бы пуст. На отдельном blocking-потоке MTA
/// проходит.
#[tauri::command]
pub async fn audio_list_sessions() -> Result<Vec<AudioSessionEntry>, CmdError> {
    #[cfg(windows)]
    {
        let list = tauri::async_runtime::spawn_blocking(capture::list_audio_sessions)
            .await
            .map_err(|_| CmdError::internal("audio-session-panic", "session list task panicked"))?
            .map_err(|e| CmdError::internal("audio-session-list-failed", &e))?;
        Ok(list
            .into_iter()
            .map(|s| AudioSessionEntry { pid: s.pid, name: s.name, active: s.active })
            .collect())
    }
    #[cfg(not(windows))]
    {
        Err(CmdError::new("unsupported", "audio session list is Windows-only"))
    }
}

/// Видимое окно для автопривязки звука (пикер демо): pid + заголовок + имя exe.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindowEntry {
    pub pid: u32,
    pub title: String,
    pub name: String,
}

/// Список видимых top-level окон с заголовками. Нужен автопривязке звука демки:
/// после выбора окна в системном пикере JS матчит `track.label` (заголовок окна
/// в Chromium) на pid и запускает process-loopback именно этого приложения.
/// user32 + toolhelp без COM → обычная sync-команда.
#[tauri::command]
pub fn audio_list_windows() -> Result<Vec<CaptureWindowEntry>, CmdError> {
    #[cfg(windows)]
    {
        let list =
            capture::list_capture_windows().map_err(|e| CmdError::internal("window-list-failed", &e))?;
        Ok(list
            .into_iter()
            .map(|w| CaptureWindowEntry { pid: w.pid, title: w.title, name: w.name })
            .collect())
    }
    #[cfg(not(windows))]
    {
        Err(CmdError::new("unsupported", "window list is Windows-only"))
    }
}

// ───────── Stage C, шаг 1: непрерывный стрим PCM в JS (мост в LiveKit) ─────────

/// Управление активным стримом захвата. Stop-флаг + поток. None — стрим не идёт.
pub struct AudioStreamState(Mutex<Option<StreamHandle>>);

struct StreamHandle {
    stop: Arc<AtomicBool>,
    join: std::thread::JoinHandle<()>,
}

impl Default for AudioStreamState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Параметры стрима для JS (формат фиксированный, но отдаём явно).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub sample_rate: u32,
    pub channels: u16,
}

/// Stage C шаг 1: запустить непрерывный стрим PCM (48к/16/стерео) в JS через
/// Channel сырыми байтами (ArrayBuffer на той стороне). pid=None → системный
/// звук, Some → процесс. Один стрим за раз.
#[tauri::command]
pub fn audio_stream_start(
    state: State<AudioStreamState>,
    pid: Option<u32>,
    on_pcm: Channel<InvokeResponseBody>,
) -> Result<AudioStreamInfo, CmdError> {
    #[cfg(windows)]
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| CmdError::internal("lock-poisoned", "stream state poisoned"))?;
        if guard.is_some() {
            return Err(CmdError::new("already-streaming", "audio stream already running"));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let join = std::thread::spawn(move || {
            // i16-сэмплы → LE-байты → сырой Channel-пакет (без re-encode на JS).
            let sink = move |samples: &[i16]| -> Result<(), String> {
                let mut bytes = Vec::with_capacity(samples.len() * 2);
                for s in samples {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                on_pcm
                    .send(InvokeResponseBody::Raw(bytes))
                    .map_err(|e| e.to_string())
            };
            if let Err(e) = capture::stream_capture(pid, stop_thread, sink) {
                eprintln!("[audio] stream_capture error: {e}");
            }
        });
        *guard = Some(StreamHandle { stop, join });
        Ok(AudioStreamInfo { sample_rate: 48_000, channels: 2 })
    }
    #[cfg(not(windows))]
    {
        let _ = (state, pid, on_pcm);
        Err(CmdError::new("unsupported", "audio stream is Windows-only"))
    }
}

/// Остановить активный стрим (idempotent).
#[tauri::command]
pub fn audio_stream_stop(state: State<AudioStreamState>) -> Result<(), CmdError> {
    let handle = state
        .0
        .lock()
        .map_err(|_| CmdError::internal("lock-poisoned", "stream state poisoned"))?
        .take();
    if let Some(h) = handle {
        h.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = h.join.join();
    }
    Ok(())
}
