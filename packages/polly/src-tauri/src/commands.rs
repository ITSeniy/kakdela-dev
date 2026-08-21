// T-101 — tauri-команды крипто-ядра, экспонируемые в JS через host/crypto.ts.
//
// Стор держится в managed-state как Mutex<Option<CryptoCore>>: лениво грузится
// с диска при первом обращении, создаётся в crypto_init. Все операции
// синхронные (block_on внутри ядра), Mutex сериализует доступ к ratchet-состоянию.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::crypto::{self, BundleIn, CryptoCore, EncryptOut, OneTimePrekeyOut, PublicBundle};
use crate::error::CmdError;
use crate::store::local_db::{self, HistoryStore, StoredMessage};

/// Managed-state крипто-ядра. None — пока устройство не инициализировано/не загружено.
pub struct CryptoState(pub Mutex<Option<CryptoCore>>);

impl Default for CryptoState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Managed-state локальной истории. None — пока не загружена с диска.
pub struct HistoryState(pub Mutex<Option<HistoryStore>>);

impl Default for HistoryState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, CmdError> {
    app.path()
        .app_data_dir()
        .map_err(|e| CmdError::internal("no-data-dir", &e.to_string()))
}

/// Выполнить операцию над загруженным ядром. Лениво грузит с диска; если стор
/// ещё не инициализирован (нет файла) — ошибка not-initialized.
fn with_core<T>(
    app: &AppHandle,
    state: &CryptoState,
    f: impl FnOnce(&mut CryptoCore) -> Result<T, CmdError>,
) -> Result<T, CmdError> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| CmdError::internal("lock-poisoned", "crypto state lock poisoned"))?;
    if guard.is_none() {
        *guard = crypto::open(&app_data_dir(app)?)?;
    }
    let core = guard
        .as_mut()
        .ok_or_else(|| CmdError::new("not-initialized", "call crypto_init first"))?;
    f(core)
}

/// Идемпотентно создаёт identity при первом запуске. Повторный вызов — no-op.
#[tauri::command]
pub fn crypto_init(
    app: AppHandle,
    state: State<CryptoState>,
    self_user_id: String,
) -> Result<(), CmdError> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| CmdError::internal("lock-poisoned", "crypto state lock poisoned"))?;
    if guard.is_none() {
        let dir = app_data_dir(&app)?;
        *guard = crypto::open(&dir)?;
        if guard.is_none() {
            *guard = Some(crypto::create(&dir, &self_user_id)?);
        }
    }
    Ok(())
}

/// Сформировать публичный бандл (для POST /api/keys/bundle). count — сколько
/// одноразовых prekey'ев сгенерировать (по умолчанию 100).
#[tauri::command]
pub fn crypto_publish_keys(
    app: AppHandle,
    state: State<CryptoState>,
    count: Option<u32>,
) -> Result<PublicBundle, CmdError> {
    with_core(&app, &state, |core| core.publish_keys(count.unwrap_or(100)))
}

/// Долить одноразовые prekey'и (для POST /api/keys/topup).
#[tauri::command]
pub fn crypto_topup(
    app: AppHandle,
    state: State<CryptoState>,
    count: Option<u32>,
) -> Result<Vec<OneTimePrekeyOut>, CmdError> {
    with_core(&app, &state, |core| core.topup(count.unwrap_or(100)))
}

/// Установить сессию из бандла собеседника (PQXDH).
#[tauri::command]
pub fn crypto_process_bundle(
    app: AppHandle,
    state: State<CryptoState>,
    user_id: String,
    bundle: BundleIn,
) -> Result<(), CmdError> {
    with_core(&app, &state, |core| core.process_bundle(&user_id, bundle))
}

/// Зашифровать строку. bundle нужен только если сессии ещё нет (первое сообщение).
#[tauri::command]
pub fn crypto_encrypt(
    app: AppHandle,
    state: State<CryptoState>,
    to_user_id: String,
    plaintext: String,
    bundle: Option<BundleIn>,
) -> Result<EncryptOut, CmdError> {
    with_core(&app, &state, |core| {
        core.encrypt(&to_user_id, &plaintext, bundle)
    })
}

/// Расшифровать. msg_type: "prekey" | "message".
#[tauri::command]
pub fn crypto_decrypt(
    app: AppHandle,
    state: State<CryptoState>,
    from_user_id: String,
    ciphertext: String,
    msg_type: String,
) -> Result<String, CmdError> {
    with_core(&app, &state, |core| {
        core.decrypt(&from_user_id, &ciphertext, &msg_type)
    })
}

/// Есть ли установленная сессия с собеседником.
#[tauri::command]
pub fn crypto_session_exists(
    app: AppHandle,
    state: State<CryptoState>,
    user_id: String,
) -> Result<bool, CmdError> {
    with_core(&app, &state, |core| Ok(core.session_exists(&user_id)))
}

/// Symmetric safety number (для верификации, T-103).
#[tauri::command]
pub fn crypto_safety_number(
    app: AppHandle,
    state: State<CryptoState>,
    user_id: String,
) -> Result<String, CmdError> {
    with_core(&app, &state, |core| core.safety_number(&user_id))
}

/// Забыть сессию + identity собеседника после смены его ключа (re-verify, T-103).
#[tauri::command]
pub fn crypto_clear_session(
    app: AppHandle,
    state: State<CryptoState>,
    user_id: String,
) -> Result<(), CmdError> {
    with_core(&app, &state, |core| core.clear_session(&user_id))
}

// ───────── локальная история (T-102) ─────────

/// Выполнить операцию над историей. Лениво открывает (пустая история валидна,
/// «инициализации» не требует — в отличие от крипто-ядра).
fn with_history<T>(
    app: &AppHandle,
    state: &HistoryState,
    f: impl FnOnce(&mut HistoryStore) -> Result<T, CmdError>,
) -> Result<T, CmdError> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| CmdError::internal("lock-poisoned", "history state lock poisoned"))?;
    if guard.is_none() {
        *guard = Some(local_db::open(&app_data_dir(app)?)?);
    }
    f(guard.as_mut().expect("history store loaded"))
}

/// Записать своё исходящее сообщение (после успешной отправки на релей).
#[tauri::command]
pub fn secret_history_append_outgoing(
    app: AppHandle,
    state: State<HistoryState>,
    peer_user_id: String,
    body: String,
    sent_at_ms: u64,
) -> Result<StoredMessage, CmdError> {
    with_history(&app, &state, |h| h.append_outgoing(&peer_user_id, body, sent_at_ms))
}

/// Записать входящее сообщение (после расшифровки крипто-ядром) и запомнить
/// конверт. None — конверт уже обработан (повторная доставка, M-10): дубликат
/// в историю не пишется.
#[tauri::command]
pub fn secret_history_append_incoming(
    app: AppHandle,
    state: State<HistoryState>,
    peer_user_id: String,
    body: String,
    sent_at_ms: u64,
    envelope_id: String,
) -> Result<Option<StoredMessage>, CmdError> {
    with_history(&app, &state, |h| {
        h.append_incoming(&peer_user_id, body, sent_at_ms, &envelope_id)
    })
}

/// Обработан ли уже этот конверт (дедуп повторной доставки, M-10).
#[tauri::command]
pub fn secret_history_is_envelope_seen(
    app: AppHandle,
    state: State<HistoryState>,
    peer_user_id: String,
    envelope_id: String,
) -> Result<bool, CmdError> {
    with_history(&app, &state, |h| {
        Ok(h.is_envelope_seen(&peer_user_id, &envelope_id))
    })
}

/// Запомнить конверт обработанным без записи в историю (read/typing).
#[tauri::command]
pub fn secret_history_mark_envelope_seen(
    app: AppHandle,
    state: State<HistoryState>,
    peer_user_id: String,
    envelope_id: String,
) -> Result<(), CmdError> {
    with_history(&app, &state, |h| h.mark_envelope_seen(&peer_user_id, &envelope_id))
}

/// Пометить исходящие прочитанными по входящему read-конверту (галочки в UI).
#[tauri::command]
pub fn secret_history_mark_read(
    app: AppHandle,
    state: State<HistoryState>,
    peer_user_id: String,
    before_ms: u64,
) -> Result<u32, CmdError> {
    with_history(&app, &state, |h| h.mark_outgoing_read(&peer_user_id, before_ms))
}

/// Вся история с собеседником (по возрастанию id).
#[tauri::command]
pub fn secret_history_list(
    app: AppHandle,
    state: State<HistoryState>,
    peer_user_id: String,
) -> Result<Vec<StoredMessage>, CmdError> {
    with_history(&app, &state, |h| Ok(h.list(&peer_user_id)))
}

/// userId'ы всех собеседников с историей (для списка секретных чатов, T-103).
#[tauri::command]
pub fn secret_history_peers(
    app: AppHandle,
    state: State<HistoryState>,
) -> Result<Vec<String>, CmdError> {
    with_history(&app, &state, |h| Ok(h.peers()))
}
