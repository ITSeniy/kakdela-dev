// Общий слой шифрования-at-rest для device-bound секретов (T-101/T-102).
//
// Один DEK (data encryption key) запечатывает И крипто-стор сессий libsignal
// (crypto/store.rs), И локальную историю секретных чатов (store/local_db.rs) —
// это одно «секретное хранилище устройства», лежащее в `<app_data>/kd-secret/`.
//
// DEK добывается через `KeyProvider`. Дефолт — `OsKeyProvider`: DEK живёт в
// OS-keychain (Windows Credential Manager / macOS Keychain / Linux
// secret-service, крейт keyring), на диске рядом со стором его больше НЕТ
// If the secure keychain is unavailable, fail closed. Never replace a lost
// key or silently downgrade to an adjacent plaintext DEK file.
//
// Формат запечатанного файла: [12 байт nonce][AES-256-GCM ciphertext+tag].

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::{rngs::OsRng, RngCore, TryRngCore};

use crate::error::CmdError;

#[cfg(test)]
#[path = "sealed_tests.rs"]
mod security_tests;

/// Инфолибельный CSPRNG из rand 0.9 (как делает сам libsignal внутри).
pub fn os_rng() -> impl RngCore + rand::CryptoRng {
    OsRng.unwrap_err()
}

/// Каталог секретных данных устройства. Создаётся при первом обращении.
pub fn data_dir(app_data_dir: &Path) -> Result<PathBuf, CmdError> {
    let dir = app_data_dir.join("kd-secret");
    fs::create_dir_all(&dir)
        .map_err(|e| CmdError::internal("dir-create", &format!("cannot create store dir: {e}")))?;
    Ok(dir)
}

/// Источник 32-байтного DEK. На Android должен быть ключ, запечатанный Keystore
/// (StrongBox если доступен). `Send + Sync` — провайдер живёт в managed-state.
pub trait KeyProvider: Send + Sync {
    fn data_key(&self) -> Result<[u8; 32], CmdError>;
}

/// Имя записи DEK в OS-keychain: service = identifier приложения.
const KEYCHAIN_SERVICE: &str = "com.kakdela.polly";
const KEYCHAIN_DEK_ACCOUNT: &str = "kd-secret-dek";
/// Легаси-файл софтварного провайдера; мигрируется в keychain при первом чтении.
const LEGACY_DEK_FILE: &str = "dek.bin";

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_decode32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

/// DEK в OS-keychain. При первом чтении подхватывает легаси `dek.bin`
/// (миграция без потери истории/ratchet-состояния) и удаляет файл.
pub struct OsKeyProvider {
    entry: Option<keyring::Entry>,
    dir: PathBuf,
}

impl OsKeyProvider {
    pub fn new(dir: &Path) -> Self {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_DEK_ACCOUNT).ok();
        Self {
            entry,
            dir: dir.to_path_buf(),
        }
    }

    fn available(&self) -> bool {
        self.entry.is_some()
    }
}

impl KeyProvider for OsKeyProvider {
    fn data_key(&self) -> Result<[u8; 32], CmdError> {
        let Some(entry) = &self.entry else {
            return Err(CmdError::internal("no-keychain", "OS keychain unavailable"));
        };

        match entry.get_password() {
            Ok(pw) => return hex_decode32(&pw).ok_or_else(|| CmdError::new("key-recovery-required", "invalid keychain key; refusing to overwrite")),
            Err(keyring::Error::NoEntry) => {},
            Err(_) => return Err(CmdError::new("keychain-unavailable", "unlock the OS keychain and retry")),
        }

        // 2. Миграция легаси dek.bin (прошлые версии держали DEK рядом со стором).
        let legacy_path = self.dir.join(LEGACY_DEK_FILE);
        if let Some(b) = read_legacy_key(&legacy_path)? {
            if b.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&b);
                entry
                    .set_password(&hex_encode(&k))
                    .map_err(|e| CmdError::internal("keychain-write", &format!("cannot store DEK: {e}")))?;
                // Файл больше не нужен — ключ теперь в keychain.
                let _ = fs::remove_file(&legacy_path);
                return Ok(k);
            }
        }

        require_empty_store(&self.dir)?;
        // 3. Generate only for a genuinely new empty store.
        let mut k = [0u8; 32];
        os_rng().fill_bytes(&mut k);
        entry
            .set_password(&hex_encode(&k))
            .map_err(|e| CmdError::internal("keychain-write", &format!("cannot store DEK: {e}")))?;
        Ok(k)
    }
}

/// СОФТВАРНЫЙ провайдер: DEK лежит файлом `dek.bin` в каталоге секретов. Это
/// explicit provider for isolated tests and legacy tooling, NOT a runtime fallback.
/// Защищает лишь от «прочитал файл», не от рутового доступа.
pub struct SoftwareKeyProvider {
    path: PathBuf,
}

impl SoftwareKeyProvider {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(LEGACY_DEK_FILE),
        }
    }
}

impl KeyProvider for SoftwareKeyProvider {
    fn data_key(&self) -> Result<[u8; 32], CmdError> {
        if let Some(b) = read_legacy_key(&self.path)? {
            if b.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&b);
                return Ok(k);
            }
        }
        let mut k = [0u8; 32];
        os_rng().fill_bytes(&mut k);
        require_empty_store(self.path.parent().ok_or_else(|| CmdError::new("bad-path", "missing store directory"))?)?;
        fs::write(&self.path, k)
            .map_err(|e| CmdError::internal("dek-write", &format!("cannot persist DEK: {e}")))?;
        Ok(k)
    }
}

/// Фабрика провайдера для всех сторов (crypto, local history): OS-keychain
/// required in production. A file provider is used only by unit tests so
/// крипто-стор и история гарантированно жили на ОДНОМ DEK.
#[cfg(not(test))]
pub fn default_key_provider(app_data_dir: &Path) -> Result<Box<dyn KeyProvider>, CmdError> {
    if cfg!(target_os = "android") { return Err(CmdError::new("keychain-unavailable", "Android Keystore support is required")); }
    let dir = data_dir(app_data_dir)?;
    let os = OsKeyProvider::new(&dir);
    if os.available() {
        Ok(Box::new(os))
    } else {
        Err(CmdError::new("keychain-unavailable", "secure key storage is required; software fallback is disabled"))
    }
}

fn read_legacy_key(path: &Path) -> Result<Option<Vec<u8>>, CmdError> {
    match fs::read(path) {
        Ok(b) if b.len() == 32 => Ok(Some(b)),
        Ok(_) => Err(CmdError::new("key-recovery-required", "invalid legacy key; refusing to overwrite")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(CmdError::new("key-recovery-required", "legacy key is not readable")),
    }
}

fn require_empty_store(dir: &Path) -> Result<(), CmdError> {
    let entries = fs::read_dir(dir).map_err(|_| CmdError::new("key-recovery-required", "store is not readable"))?;
    for entry in entries {
        let entry = entry.map_err(|_| CmdError::new("key-recovery-required", "store entry is not readable"))?;
        if entry.file_name() != LEGACY_DEK_FILE {
            return Err(CmdError::new("key-recovery-required", "encrypted data exists but its key is missing; restore the key, not a new identity"));
        }
    }
    Ok(())
}

fn cipher(dek: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(dek))
}

/// Запечатать произвольный plaintext: [nonce][ciphertext+tag].
pub fn seal(dek: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, CmdError> {
    let mut nonce = [0u8; 12];
    os_rng().fill_bytes(&mut nonce);
    let ct = cipher(dek)
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| CmdError::internal("encrypt", "sealing failed"))?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Распечатать [nonce][ciphertext+tag] обратно в plaintext.
pub fn unseal(dek: &[u8; 32], raw: &[u8]) -> Result<Vec<u8>, CmdError> {
    if raw.len() < 12 {
        return Err(CmdError::internal("store-corrupt", "sealed blob truncated"));
    }
    let (nonce, ct) = raw.split_at(12);
    cipher(dek)
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| CmdError::internal("decrypt", "unsealing failed"))
}

/// Записать запечатанный снапшот атомарно (tmp + rename). Обрыв на записи иначе
/// оставил бы битый стор и нерасшифровываемую историю/ratchet-состояние.
pub fn write_sealed(
    path: &Path,
    key_provider: &dyn KeyProvider,
    plaintext: &[u8],
) -> Result<(), CmdError> {
    let dek = key_provider.data_key()?;
    let sealed = seal(&dek, plaintext)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &sealed)
        .map_err(|e| CmdError::internal("store-write", &format!("cannot write store: {e}")))?;
    let mut committed = fs::OpenOptions::new().write(true).open(&tmp)
        .map_err(|e| CmdError::internal("store-open", &e.to_string()))?;
    committed.flush().and_then(|_| committed.sync_all())
        .map_err(|e| CmdError::internal("store-sync", &e.to_string()))?;
    drop(committed);
    fs::rename(&tmp, path)
        .map_err(|e| CmdError::internal("store-rename", &format!("cannot commit store: {e}")))?;
    Ok(())
}

/// Прочитать и распечатать снапшот. None — если файла ещё нет.
pub fn read_sealed(
    path: &Path,
    key_provider: &dyn KeyProvider,
) -> Result<Option<Vec<u8>>, CmdError> {
    let raw = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(CmdError::internal("store-read", &format!("cannot read store: {e}")))
        }
    };
    let dek = key_provider.data_key()?;
    Ok(Some(unseal(&dek, &raw)?))
}

// Test-only: never access the real user keychain from a test process.
#[cfg(test)]
pub fn default_key_provider(app_data_dir: &Path) -> Result<Box<dyn KeyProvider>, CmdError> {
    Ok(Box::new(SoftwareKeyProvider::new(&data_dir(app_data_dir)?)))
}
