// T-094 — WASAPI loopback-захват звука для демонстрации экрана (Windows-only).
//
//   • Захват ОДНОГО процесса (и его дерева), по-дискордовски, через
//     ActivateAudioInterfaceAsync + process-loopback PROPVARIANT.
//   • Захват ВСЕГО системного звука с default render endpoint.
//   • Непрерывный стрим PCM в JS (мост в LiveKit, см. stream_capture).
//   • Перечисление звучащих приложений/окон для пикера источника звука.
//
// Компилируется только на Windows (см. `#[cfg(windows)]` в mod.rs).

use std::collections::HashMap;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows::core::{implement, Interface, BOOL, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AudioSessionStateActive, IAudioSessionControl2,
    IAudioSessionManager2, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

/// AUDCLNT_BUFFERFLAGS_SILENT — данные пакета считать тишиной. Берём литералом,
/// чтобы не зависеть от типа константы в конкретной версии windows-crate.
const BUFFERFLAGS_SILENT: u32 = 0x2;

/// Формат, который запрашиваем для process-loopback (там своего endpoint-микса
/// нет, формат задаём сами). 48 кГц/16 бит/стерео + AUTOCONVERTPCM — движок сам
/// приведёт любой источник к этому. 48к — то, что дальше нужно Opus (Stage C).
const PROC_SAMPLE_RATE: u32 = 48_000;
const PROC_CHANNELS: u16 = 2;
const PROC_BITS: u16 = 16;

/// Аудио-сессия для пикера «звук приложения»: pid + имя exe + играет ли прямо
/// сейчас (active). Это то, что реально способно звучать, в отличие от полного
/// списка процессов.
pub struct AudioSessionInfo {
    pub pid: u32,
    pub name: String,
    pub active: bool,
}

/// Видимое top-level окно: pid владельца + заголовок + имя exe. Кандидат для
/// автопривязки звука демки к окну, выбранному в системном пикере (T-094).
pub struct WindowInfo {
    pub pid: u32,
    pub title: String,
    pub name: String,
}

#[derive(Clone, Copy)]
enum SampleKind {
    Int,
}

/// Разобранный формат потока, который мы сами задаём для захвата (см.
/// `stream_format`) — всегда фиксированный PCM int.
struct SrcFormat {
    kind: SampleKind,
    bits: u16,
    channels: u16,
    block_align: u16,
}

/// CoUninitialize при выходе из функции (в т.ч. по `?`).
struct ComGuard;
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// CloseHandle при выходе (event-хэндлы, снапшоты).
struct HandleGuard(HANDLE);
impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// ──────────────────── Захват звука одного процесса (дерева) ────────────────

/// Хэндлер завершения асинхронной активации: сигналит event, который ждёт
/// вызывающий поток. Сам результат забираем через GetActivateResult на op.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    done: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        unsafe {
            let _ = SetEvent(self.done);
        }
        Ok(())
    }
}

/// Асинхронно активирует IAudioClient для process-loopback указанного PID
/// (включая дочерние процессы) и блокируется до завершения активации.
unsafe fn activate_process_loopback_client(pid: u32) -> Result<IAudioClient, String> {
    // Параметры активации: захват дерева процессов целевого PID.
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };

    // Упаковываем параметры в PROPVARIANT как VT_BLOB. КРИТИЧНО: НЕ давать
    // сработать Drop у PROPVARIANT — он зовёт PropVariantClear, который для
    // VT_BLOB делает CoTaskMemFree(pBlobData). А pBlobData указывает на `params`
    // на СТЕКЕ → free() стекового адреса → STATUS_HEAP_CORRUPTION. Оборачиваем в
    // ManuallyDrop: своей heap-памяти этот PROPVARIANT не владеет, «течь» нечему.
    let mut prop = std::mem::ManuallyDrop::new(PROPVARIANT::default());
    {
        let inner = &mut prop.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &mut params as *mut _ as *mut u8,
        };
    }

    let event = CreateEventW(None, false, false, PCWSTR::null()).map_err(|e| e.to_string())?;
    let _guard = HandleGuard(event);

    let handler: IActivateAudioInterfaceCompletionHandler =
        ActivationHandler { done: event }.into();

    let op: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&*prop),
        &handler,
    )
    .map_err(|e| format!("ActivateAudioInterfaceAsync: {e}"))?;

    // Ждём завершения (до 5 с) — handler сигналит event.
    if WaitForSingleObject(event, 5000) != WAIT_OBJECT_0 {
        return Err("activation timed out".into());
    }

    let mut activate_hr = windows::core::HRESULT(0);
    let mut activated: Option<windows::core::IUnknown> = None;
    op.GetActivateResult(&mut activate_hr, &mut activated)
        .map_err(|e| e.to_string())?;
    activate_hr.ok().map_err(|e| format!("activation result: {e}"))?;

    let unknown = activated.ok_or_else(|| "activation returned no interface".to_string())?;
    unknown.cast::<IAudioClient>().map_err(|e| e.to_string())
}

/// pid → имя exe через toolhelp-снапшот. Общая основа для списка процессов и
/// для перечисления аудио-сессий (оно отдаёт только pid — имя резолвим тут,
/// без OpenProcess: меньше требуемых прав и поверхности).
unsafe fn process_name_map() -> Result<HashMap<u32, String>, String> {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?;
    let _guard = HandleGuard(snapshot);

    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    let mut map = HashMap::new();
    if Process32FirstW(snapshot, &mut entry).is_ok() {
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if entry.th32ProcessID != 0 {
                map.insert(entry.th32ProcessID, name);
            }
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
    }
    Ok(map)
}

/// Перечисляет приложения с аудио-сессией на устройстве вывода по умолчанию —
/// то, что реально способно звучать. Источник для пользовательского пикера
/// «звук приложения»: IAudioSessionManager2 → IAudioSessionEnumerator →
/// IAudioSessionControl2 (pid + состояние), имя резолвим из toolhelp-карты.
pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    unsafe { list_audio_sessions_inner() }
}

unsafe fn list_audio_sessions_inner() -> Result<Vec<AudioSessionInfo>, String> {
    CoInitializeEx(None, COINIT_MULTITHREADED)
        .ok()
        .map_err(|e| format!("CoInitializeEx: {e}"))?;
    let _com = ComGuard;

    let names = process_name_map()?;

    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    // Сессии берём с того же default-render endpoint, что и loopback-захват —
    // список совпадает с тем, что реально попадёт в системный микс.
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| e.to_string())?;
    let manager: IAudioSessionManager2 =
        device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
    let sessions = manager.GetSessionEnumerator().map_err(|e| e.to_string())?;
    let count = sessions.GetCount().map_err(|e| e.to_string())?;

    // Один процесс может держать несколько сессий — агрегируем «активен» по OR
    // (хоть одна играет → приложение звучит).
    let mut acc: HashMap<u32, bool> = HashMap::new();
    for i in 0..count {
        let ctrl = match sessions.GetSession(i) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let ctrl2: IAudioSessionControl2 = match ctrl.cast() {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Системные звуки (уведомления, бипы) — не приложение, пропускаем.
        // IsSystemSoundsSession отдаёт S_OK(0), когда это та самая сессия.
        if ctrl2.IsSystemSoundsSession().0 == 0 {
            continue;
        }
        let pid = match ctrl2.GetProcessId() {
            Ok(p) if p != 0 => p,
            _ => continue,
        };
        let active = matches!(ctrl.GetState(), Ok(s) if s == AudioSessionStateActive);
        let slot = acc.entry(pid).or_insert(false);
        *slot = *slot || active;
    }

    let mut out: Vec<AudioSessionInfo> = acc
        .into_iter()
        .map(|(pid, active)| AudioSessionInfo {
            pid,
            name: names
                .get(&pid)
                .cloned()
                .unwrap_or_else(|| format!("PID {pid}")),
            active,
        })
        .collect();
    // Активные сверху, затем по имени без учёта регистра — стабильный порядок UI.
    out.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Перечисляет видимые top-level окна с заголовком. Используется автопривязкой
/// звука к окну демо: заголовок из `track.label` (Chromium) матчится на pid,
/// и звук берётся process-loopback'ом именно этого приложения. Фильтр нарочно
/// минимальный (видимо + заголовок непустой): лишние кандидаты матчингу не
/// мешают, а undermatching из-за агрессивных фильтров — мешает.
pub fn list_capture_windows() -> Result<Vec<WindowInfo>, String> {
    unsafe { list_capture_windows_inner() }
}

struct RawWindow {
    pid: u32,
    title: String,
}

unsafe extern "system" fn on_enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let acc = &mut *(lparam.0 as *mut Vec<RawWindow>);
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf) as usize;
    if len == 0 {
        return true.into();
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return true.into();
    }
    acc.push(RawWindow {
        pid,
        title: String::from_utf16_lossy(&buf[..len]),
    });
    true.into()
}

unsafe fn list_capture_windows_inner() -> Result<Vec<WindowInfo>, String> {
    // user32 + toolhelp, без COM — можно звать с любого потока.
    let mut wins: Vec<RawWindow> = Vec::new();
    EnumWindows(Some(on_enum_window), LPARAM(&mut wins as *mut _ as isize))
        .map_err(|e| e.to_string())?;
    let names = process_name_map()?;
    Ok(wins
        .into_iter()
        .map(|w| WindowInfo {
            pid: w.pid,
            name: names
                .get(&w.pid)
                .cloned()
                .unwrap_or_else(|| format!("PID {}", w.pid)),
            title: w.title,
        })
        .collect())
}

// ───────── Stage C, шаг 1: непрерывный стрим PCM (мост в LiveKit) ─────────

/// Фиксированный формат стрима: 48к/16/стерео — один для system и process
/// (через AUTOCONVERTPCM движок сам приводит источник к нему). JS знает формат
/// заранее, ресемплинг не нужен (48к — то, что хочет Opus/WebRTC в Stage C).
fn stream_format() -> (WAVEFORMATEX, SrcFormat) {
    let block_align = PROC_CHANNELS * (PROC_BITS / 8);
    let wfx = WAVEFORMATEX {
        wFormatTag: 1, // WAVE_FORMAT_PCM
        nChannels: PROC_CHANNELS,
        nSamplesPerSec: PROC_SAMPLE_RATE,
        nAvgBytesPerSec: PROC_SAMPLE_RATE * PROC_CHANNELS as u32 * (PROC_BITS as u32 / 8),
        nBlockAlign: block_align,
        wBitsPerSample: PROC_BITS,
        cbSize: 0,
    };
    let fmt = SrcFormat {
        kind: SampleKind::Int,
        bits: PROC_BITS,
        channels: PROC_CHANNELS,
        block_align,
    };
    (wfx, fmt)
}

/// Непрерывный стрим PCM (48к/16/стерео) до выставления `stop`. На каждый дренаж
/// зовёт `sink` с интерливленными i16-сэмплами. pid=None → весь системный звук,
/// Some → конкретный процесс (и дерево). Не пишет WAV — это транспорт в LiveKit.
pub fn stream_capture(
    pid: Option<u32>,
    stop: Arc<AtomicBool>,
    sink: impl FnMut(&[i16]) -> Result<(), String>,
) -> Result<(), String> {
    unsafe { stream_capture_inner(pid, stop, sink) }
}

unsafe fn stream_capture_inner(
    pid: Option<u32>,
    stop: Arc<AtomicBool>,
    mut sink: impl FnMut(&[i16]) -> Result<(), String>,
) -> Result<(), String> {
    CoInitializeEx(None, COINIT_MULTITHREADED)
        .ok()
        .map_err(|e| format!("CoInitializeEx: {e}"))?;
    let _com = ComGuard;

    let (wfx, fmt) = stream_format();
    let mut scratch: Vec<i16> = Vec::new();

    match pid {
        None => {
            // Весь системный звук: endpoint loopback + AUTOCONVERTPCM (приводим к
            // фикс-формату), polling-цикл (как в Stage A).
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| e.to_string())?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    2_000_000,
                    0,
                    &wfx,
                    None,
                )
                .map_err(|e| format!("Initialize(system stream): {e}"))?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
            client.Start().map_err(|e| e.to_string())?;
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(10));
                drain_to_sink(&capture, &fmt, &mut scratch, &mut sink)?;
            }
            client.Stop().map_err(|e| e.to_string())?;
        }
        Some(pid) => {
            // Процесс: async-активация (как в Stage B) + event-driven цикл.
            let client = activate_process_loopback_client(pid)?;
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    2_000_000,
                    0,
                    &wfx,
                    None,
                )
                .map_err(|e| format!("Initialize(process stream): {e}"))?;
            let event =
                CreateEventW(None, false, false, PCWSTR::null()).map_err(|e| e.to_string())?;
            let _ev = HandleGuard(event);
            client.SetEventHandle(event).map_err(|e| e.to_string())?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
            client.Start().map_err(|e| e.to_string())?;
            while !stop.load(Ordering::Relaxed) {
                WaitForSingleObject(event, 200);
                drain_to_sink(&capture, &fmt, &mut scratch, &mut sink)?;
            }
            client.Stop().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Вычитывает все доступные сейчас пакеты capture-клиента, конвертит в 16-бит и
/// отдаёт сэмплы в callback (стрим PCM → JS).
unsafe fn drain_to_sink(
    capture: &IAudioCaptureClient,
    fmt: &SrcFormat,
    scratch: &mut Vec<i16>,
    sink: &mut impl FnMut(&[i16]) -> Result<(), String>,
) -> Result<(), String> {
    let channels = fmt.channels as usize;
    let block_align = fmt.block_align as usize;
    let bytes_per_sample = (fmt.bits / 8) as usize;
    loop {
        let packet = capture.GetNextPacketSize().map_err(|e| e.to_string())?;
        if packet == 0 {
            break;
        }
        let mut p_data: *mut u8 = std::ptr::null_mut();
        let mut num_frames: u32 = 0;
        let mut flags: u32 = 0;
        capture
            .GetBuffer(&mut p_data, &mut num_frames, &mut flags, None, None)
            .map_err(|e| e.to_string())?;
        let frames = num_frames as usize;
        scratch.clear();
        scratch.reserve(frames * channels);
        if (flags & BUFFERFLAGS_SILENT) != 0 || p_data.is_null() {
            scratch.resize(frames * channels, 0);
        } else {
            let data = std::slice::from_raw_parts(p_data, frames * block_align);
            for f in 0..frames {
                let frame_off = f * block_align;
                for c in 0..channels {
                    let off = frame_off + c * bytes_per_sample;
                    scratch.push(sample_to_i16(&data[off..off + bytes_per_sample], fmt.kind, fmt.bits));
                }
            }
        }
        if !scratch.is_empty() {
            sink(scratch)?;
        }
        capture.ReleaseBuffer(num_frames).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Нормализует один сэмпл к i16 (через f32 в [-1,1]). PCM int 16/24/32 — формат
/// задаём сами (см. `stream_format`), поэтому только целочисленные варианты.
fn sample_to_i16(bytes: &[u8], kind: SampleKind, bits: u16) -> i16 {
    let SampleKind::Int = kind;
    let norm = match bits {
        16 => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32_768.0,
        24 => {
            let raw = (bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
            let signed = (raw << 8) >> 8; // знаковое расширение 24→32
            signed as f32 / 8_388_608.0
        }
        32 => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0,
        _ => 0.0,
    };
    (norm.clamp(-1.0, 1.0) * 32_767.0).round() as i16
}

