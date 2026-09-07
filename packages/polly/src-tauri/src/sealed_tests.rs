use super::*;
fn temp_dir(tag: &str) -> PathBuf {
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("kd-audit-{tag}-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}
#[test]
fn corrupt_key_is_not_replaced() {
    let dir = temp_dir("corrupt");
    let key = dir.join(LEGACY_DEK_FILE);
    fs::write(&key, b"corrupt").unwrap();
    let result = SoftwareKeyProvider::new(&dir).data_key();
    assert_eq!(result.unwrap_err().code, "key-recovery-required");
    assert_eq!(fs::read(&key).unwrap(), b"corrupt");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn missing_key_with_ciphertext_fails_closed() {
    let dir = temp_dir("missing");
    fs::write(dir.join("secret-history.bin"), b"old encrypted snapshot").unwrap();
    assert_eq!(SoftwareKeyProvider::new(&dir).data_key().unwrap_err().code, "key-recovery-required");
    assert!(!dir.join(LEGACY_DEK_FILE).exists());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn key_and_authenticated_snapshot_survive_reopen() {
    let dir = temp_dir("reopen");
    let path = dir.join("history.bin");
    write_sealed(&path, &SoftwareKeyProvider::new(&dir), b"private plaintext").unwrap();
    let reopened = SoftwareKeyProvider::new(&dir);
    assert_eq!(read_sealed(&path, &reopened).unwrap().unwrap(), b"private plaintext");
    let mut bytes = fs::read(&path).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    fs::write(&path, bytes).unwrap();
    assert!(read_sealed(&path, &reopened).is_err());
    fs::remove_dir_all(dir).unwrap();
}
