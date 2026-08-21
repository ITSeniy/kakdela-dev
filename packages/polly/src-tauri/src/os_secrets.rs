// OS-keychain для мелких секретов фронта (аудит 2026-08, M-3): JWT-сессия
// (access+refresh) живёт в Windows Credential Manager / macOS Keychain /
// Linux secret-service через крейт keyring — вместо софтверного шифрования
// IndexedDB. JS-сторона: lib/host/secrets.ts (osSecrets-бэкенд).
//
// Значения — строки (JSON сессии). Секреты никогда не попадают в ошибки
// (см. error.rs) и не логируются.

use crate::error::CmdError;

/// Service в keychain = identifier приложения (один AUMID/credential-namespace).
const SERVICE: &str = "com.kakdela.polly";

/// Ключ — короткая метка ('kd:session'), а не произвольная строка: ограничиваем
/// алфавит, чтобы не плодить странные записи в системном хранилище.
fn validate_key(key: &str) -> Result<(), CmdError> {
    let ok = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(CmdError::internal(
            "bad-secret-key",
            "secret key must be 1..64 chars of [a-zA-Z0-9:_-]",
        ))
    }
}

fn entry(key: &str) -> Result<keyring::Entry, CmdError> {
    validate_key(key)?;
    keyring::Entry::new(SERVICE, key)
        .map_err(|e| CmdError::internal("no-keychain", &format!("OS keychain unavailable: {e}")))
}

/// Прочитать секрет. None — записи нет (не ошибка).
#[tauri::command]
pub fn os_secret_get(key: String) -> Result<Option<String>, CmdError> {
    let entry = entry(&key)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CmdError::internal(
            "keychain-read",
            &format!("cannot read secret: {e}"),
        )),
    }
}

/// Записать (создать/перезаписать) секрет.
#[tauri::command]
pub fn os_secret_set(key: String, value: String) -> Result<(), CmdError> {
    let entry = entry(&key)?;
    entry
        .set_password(&value)
        .map_err(|e| CmdError::internal("keychain-write", &format!("cannot store secret: {e}")))
}

/// Удалить секрет. Отсутствие записи — не ошибка (идемпотентно).
#[tauri::command]
pub fn os_secret_delete(key: String) -> Result<(), CmdError> {
    let entry = entry(&key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CmdError::internal(
            "keychain-delete",
            &format!("cannot delete secret: {e}"),
        )),
    }
}
