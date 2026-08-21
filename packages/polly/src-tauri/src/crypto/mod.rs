// T-101 — крипто-ядро секретных чатов (device-bound, мобайл-онли).
//
// Здесь НЕТ собственной криптографии: identity / prekeys / установка сессии
// (PQXDH) / Double Ratchet — всё через session-API libsignal как есть. Наша
// задача — сгенерировать ключи, сложить приватные части в зашифрованный
// локальный стор (store.rs) и прокинуть публичные части в слепой каталог сервера.
//
// Протокол (libsignal v0.96.4): PQXDH = X3DH (X25519) + Kyber1024 для установки
// сессии, дальше Double Ratchet. Это сильнее классического X3DH; см. карточку
// T-101 (решение Path A).

mod store;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use pollster::block_on;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use libsignal_protocol::{
    kem, message_decrypt_prekey, message_decrypt_signal, message_encrypt, process_prekey_bundle,
    CiphertextMessageType, DeviceId, Fingerprint, GenericSignedPreKey, IdentityKey, IdentityKeyPair,
    KeyPair, KyberPreKeyId, KyberPreKeyRecord, PreKeyBundle, PreKeyId, PreKeyRecord,
    PreKeySignalMessage, ProtocolAddress, PublicKey, SignalMessage, SignedPreKeyId,
    SignedPreKeyRecord, Timestamp,
};
// Трейты стора должны быть в scope, чтобы вызывать их методы на суб-сторах.
use libsignal_protocol::{KyberPreKeyStore, PreKeyStore, SignedPreKeyStore};

use crate::error::CmdError;
use crate::sealed::{self, KeyProvider};
use store::KdProtocolStore;

// safety number: и итерации, и id, и ключи должны совпадать у обеих сторон —
// DisplayableFingerprint сам сортирует половинки, поэтому результат симметричен.
const SAFETY_NUMBER_VERSION: u32 = 2;
const SAFETY_NUMBER_ITERATIONS: u32 = 5200;

// Устройство одно (device-bound) — device_id всегда 1.
fn device() -> DeviceId {
    DeviceId::new(1).expect("device id 1 is in range")
}

fn addr(user_id: &str) -> ProtocolAddress {
    ProtocolAddress::new(user_id.to_string(), device())
}

fn now() -> SystemTime {
    SystemTime::now()
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn b64e(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn b64d(s: &str) -> Result<Vec<u8>, CmdError> {
    STANDARD
        .decode(s)
        .map_err(|_| CmdError::new("bad-input", "invalid base64"))
}

// CmdError живёт в crate::error (общий для crypto и store/local_db).

// ───────── публичные DTO (camelCase для JS / совпадают с ginzu) ─────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPrekeyOut {
    pub key_id: u32,
    pub pub_key: String,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KyberPrekeyOut {
    pub key_id: u32,
    pub pub_key: String,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneTimePrekeyOut {
    pub key_id: u32,
    pub pub_key: String,
}

/// Публичный бандл для POST /api/keys/bundle. Только ПУБЛИЧНЫЕ ключи.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicBundle {
    pub identity_key: String,
    pub registration_id: u32,
    pub signed_prekey: SignedPrekeyOut,
    pub kyber_prekey: KyberPrekeyOut,
    pub one_time_prekeys: Vec<OneTimePrekeyOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptOut {
    pub ciphertext: String,
    /// "prekey" (первое сообщение, X3DH/PQXDH) или "message" (Double Ratchet).
    pub msg_type: String,
}

// ───────── входной бандл (из GET /api/keys/:userId/bundle) ─────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPrekeyIn {
    pub key_id: u32,
    pub pub_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KyberPrekeyIn {
    pub key_id: u32,
    pub pub_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneTimePrekeyIn {
    pub key_id: u32,
    pub pub_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleIn {
    pub identity_key: String,
    pub registration_id: u32,
    pub signed_prekey: SignedPrekeyIn,
    pub kyber_prekey: KyberPrekeyIn,
    pub one_time_prekey: Option<OneTimePrekeyIn>,
}

// ───────── ядро ─────────

pub struct CryptoCore {
    dir: PathBuf,
    key_provider: Box<dyn KeyProvider>,
    store: KdProtocolStore,
}

/// Открыть существующий стор. None — если устройство ещё не инициализировано.
pub fn open(app_data_dir: &Path) -> Result<Option<CryptoCore>, CmdError> {
    let dir = sealed::data_dir(app_data_dir)?;
    let key_provider = sealed::default_key_provider(app_data_dir)?;
    match store::load(&dir, key_provider.as_ref())? {
        Some(store) => Ok(Some(CryptoCore {
            dir,
            key_provider,
            store,
        })),
        None => Ok(None),
    }
}

/// Создать identity + registrationId при первом запуске (идемпотентность —
/// на стороне команды crypto_init: создаём только если open() вернул None).
pub fn create(app_data_dir: &Path, self_user_id: &str) -> Result<CryptoCore, CmdError> {
    let dir = sealed::data_dir(app_data_dir)?;
    let key_provider = sealed::default_key_provider(app_data_dir)?;
    let mut rng = sealed::os_rng();
    let identity = IdentityKeyPair::generate(&mut rng);
    // 14-битный ненулевой registrationId — как у Signal.
    let registration_id = (rng.next_u32() % 16380) + 1;
    let store = KdProtocolStore::new(&identity, registration_id, self_user_id.to_string());
    let core = CryptoCore {
        dir,
        key_provider,
        store,
    };
    core.persist()?;
    Ok(core)
}

impl CryptoCore {
    fn persist(&self) -> Result<(), CmdError> {
        store::persist(&self.dir, self.key_provider.as_ref(), &self.store)
    }

    /// Сгенерировать пачку одноразовых prekey'ев, сложить приватные части в стор,
    /// вернуть публичные. keyId монотонный (уникальность).
    fn generate_one_time<R: RngCore + rand::CryptoRng>(
        &mut self,
        count: u32,
        rng: &mut R,
    ) -> Result<Vec<OneTimePrekeyOut>, CmdError> {
        let mut out = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let id = self.store.next_one_time_id;
            let kp = KeyPair::generate(rng);
            let pub_key = b64e(&kp.public_key.serialize());
            let rec = PreKeyRecord::new(PreKeyId::from(id), &kp);
            block_on(self.store.pre_keys.save_pre_key(PreKeyId::from(id), &rec))?;
            out.push(OneTimePrekeyOut { key_id: id, pub_key });
            self.store.next_one_time_id = self.store.next_one_time_id.wrapping_add(1);
        }
        Ok(out)
    }

    /// Сформировать публичный бандл из текущих signed/kyber/identity + одноразовых.
    fn public_bundle(&self, one_time: Vec<OneTimePrekeyOut>) -> Result<PublicBundle, CmdError> {
        let identity = self.store.identity_key_pair()?;
        let signed_id = self
            .store
            .signed_prekey_id
            .ok_or_else(|| CmdError::new("no-signed-prekey", "signed prekey not generated"))?;
        let kyber_id = self
            .store
            .kyber_prekey_id
            .ok_or_else(|| CmdError::new("no-kyber-prekey", "kyber prekey not generated"))?;
        let spk = block_on(
            self.store
                .signed_pre_keys
                .get_signed_pre_key(SignedPreKeyId::from(signed_id)),
        )?;
        let kpk = block_on(
            self.store
                .kyber_pre_keys
                .get_kyber_pre_key(KyberPreKeyId::from(kyber_id)),
        )?;
        Ok(PublicBundle {
            identity_key: b64e(&identity.identity_key().serialize()),
            registration_id: self.store.registration_id(),
            signed_prekey: SignedPrekeyOut {
                key_id: signed_id,
                pub_key: b64e(&spk.public_key()?.serialize()),
                signature: b64e(&spk.signature()?),
            },
            kyber_prekey: KyberPrekeyOut {
                key_id: kyber_id,
                pub_key: b64e(&kpk.public_key()?.serialize()),
                signature: b64e(&kpk.signature()?),
            },
            one_time_prekeys: one_time,
        })
    }

    /// Сгенерировать signed + kyber (по разу) + пачку одноразовых; вернуть бандл.
    pub fn publish_keys(&mut self, count: u32) -> Result<PublicBundle, CmdError> {
        let identity = self.store.identity_key_pair()?;
        let mut rng = sealed::os_rng();

        if self.store.signed_prekey_id.is_none() {
            let id = 1u32;
            let kp = KeyPair::generate(&mut rng);
            let pub_ser = kp.public_key.serialize();
            let sig = identity
                .private_key()
                .calculate_signature(&pub_ser, &mut rng)
                .map_err(|_| CmdError::new("crypto-failure", "signed prekey signing failed"))?;
            let rec = SignedPreKeyRecord::new(
                SignedPreKeyId::from(id),
                Timestamp::from_epoch_millis(epoch_ms()),
                &kp,
                &sig,
            );
            block_on(
                self.store
                    .signed_pre_keys
                    .save_signed_pre_key(SignedPreKeyId::from(id), &rec),
            )?;
            self.store.signed_prekey_id = Some(id);
        }

        if self.store.kyber_prekey_id.is_none() {
            let id = 1u32;
            let rec = KyberPreKeyRecord::generate(
                kem::KeyType::Kyber1024,
                KyberPreKeyId::from(id),
                identity.private_key(),
            )?;
            block_on(
                self.store
                    .kyber_pre_keys
                    .save_kyber_pre_key(KyberPreKeyId::from(id), &rec),
            )?;
            self.store.kyber_prekey_id = Some(id);
        }

        let one_time = self.generate_one_time(count, &mut rng)?;
        self.persist()?;
        self.public_bundle(one_time)
    }

    /// Долить одноразовые prekey'и (для POST /api/keys/topup).
    pub fn topup(&mut self, count: u32) -> Result<Vec<OneTimePrekeyOut>, CmdError> {
        let mut rng = sealed::os_rng();
        let out = self.generate_one_time(count, &mut rng)?;
        self.persist()?;
        Ok(out)
    }

    /// Установить сессию из бандла собеседника (PQXDH). После этого можно encrypt.
    pub fn process_bundle(&mut self, user_id: &str, b: BundleIn) -> Result<(), CmdError> {
        let identity_key = IdentityKey::decode(&b64d(&b.identity_key)?)?;
        let signed_pub = PublicKey::deserialize(&b64d(&b.signed_prekey.pub_key)?)
            .map_err(|_| CmdError::new("bad-input", "invalid signed prekey"))?;
        let kyber_pub = kem::PublicKey::deserialize(&b64d(&b.kyber_prekey.pub_key)?)
            .map_err(|_| CmdError::new("bad-input", "invalid kyber prekey"))?;
        let pre_key = match b.one_time_prekey {
            Some(otp) => {
                let pk = PublicKey::deserialize(&b64d(&otp.pub_key)?)
                    .map_err(|_| CmdError::new("bad-input", "invalid one-time prekey"))?;
                Some((PreKeyId::from(otp.key_id), pk))
            }
            None => None,
        };

        let bundle = PreKeyBundle::new(
            b.registration_id,
            device(),
            pre_key,
            SignedPreKeyId::from(b.signed_prekey.key_id),
            signed_pub,
            b64d(&b.signed_prekey.signature)?,
            KyberPreKeyId::from(b.kyber_prekey.key_id),
            kyber_pub,
            b64d(&b.kyber_prekey.signature)?,
            identity_key,
        )?;

        let remote = addr(user_id);
        let local = addr(self.store.self_user_id());
        let mut rng = sealed::os_rng();
        // session_store и identity_store — РАЗНЫЕ поля self.store ⇒ непересекающиеся &mut.
        block_on(process_prekey_bundle(
            &remote,
            &local,
            &mut self.store.sessions,
            &mut self.store.identity,
            &bundle,
            now(),
            &mut rng,
        ))?;
        self.persist()?;
        Ok(())
    }

    /// Зашифровать. Если сессии ещё нет — нужен бандл (X3DH/PQXDH на первом
    /// сообщении), иначе Double Ratchet. Без сессии и без бандла — ошибка.
    pub fn encrypt(
        &mut self,
        to_user_id: &str,
        plaintext: &str,
        bundle: Option<BundleIn>,
    ) -> Result<EncryptOut, CmdError> {
        if !self.store.has_session(to_user_id) {
            match bundle {
                Some(b) => self.process_bundle(to_user_id, b)?,
                None => {
                    return Err(CmdError::new(
                        "no-session",
                        "no session; fetch and pass a prekey bundle first",
                    ))
                }
            }
        }

        let remote = addr(to_user_id);
        let local = addr(self.store.self_user_id());
        let mut rng = sealed::os_rng();
        let msg = block_on(message_encrypt(
            plaintext.as_bytes(),
            &remote,
            &local,
            &mut self.store.sessions,
            &mut self.store.identity,
            now(),
            &mut rng,
        ))?;

        let msg_type = match msg.message_type() {
            CiphertextMessageType::PreKey => "prekey",
            CiphertextMessageType::Whisper => "message",
            other => {
                return Err(CmdError::new(
                    "unexpected-type",
                    &format!("unexpected ciphertext type {other:?}"),
                ))
            }
        };
        self.persist()?;
        Ok(EncryptOut {
            ciphertext: b64e(msg.serialize()),
            msg_type: msg_type.to_string(),
        })
    }

    /// Расшифровать. msg_type: "prekey" (устанавливает сессию) или "message".
    pub fn decrypt(
        &mut self,
        from_user_id: &str,
        ciphertext_b64: &str,
        msg_type: &str,
    ) -> Result<String, CmdError> {
        let bytes = b64d(ciphertext_b64)?;
        let remote = addr(from_user_id);
        let local = addr(self.store.self_user_id());
        let mut rng = sealed::os_rng();

        let plaintext = match msg_type {
            "prekey" => {
                let m = PreKeySignalMessage::try_from(bytes.as_slice())?;
                block_on(message_decrypt_prekey(
                    &m,
                    &remote,
                    &local,
                    &mut self.store.sessions,
                    &mut self.store.identity,
                    &mut self.store.pre_keys,
                    &self.store.signed_pre_keys,
                    &mut self.store.kyber_pre_keys,
                    &mut rng,
                ))?
            }
            "message" => {
                let m = SignalMessage::try_from(bytes.as_slice())?;
                block_on(message_decrypt_signal(
                    &m,
                    &remote,
                    &local,
                    &mut self.store.sessions,
                    &mut self.store.identity,
                    &mut rng,
                ))?
            }
            other => {
                return Err(CmdError::new(
                    "bad-input",
                    &format!("unknown msg type: {other}"),
                ))
            }
        };
        self.persist()?;
        String::from_utf8(plaintext)
            .map_err(|_| CmdError::new("bad-utf8", "decrypted payload is not valid UTF-8"))
    }

    pub fn session_exists(&self, user_id: &str) -> bool {
        self.store.has_session(user_id)
    }

    /// Забыть сессию и сохранённый identity собеседника (после смены его ключа).
    /// Следующая отправка возьмёт свежий бандл и поднимет новую сессию.
    pub fn clear_session(&mut self, user_id: &str) -> Result<(), CmdError> {
        if self.store.clear_session(user_id) {
            self.persist()?;
        }
        Ok(())
    }

    /// Детерминированный симметричный safety number (одинаков у обеих сторон).
    /// Требует уже известного identity собеседника (после process_bundle/decrypt).
    pub fn safety_number(&self, peer_user_id: &str) -> Result<String, CmdError> {
        let identity = self.store.identity_key_pair()?;
        let local_key = identity.identity_key();
        let remote_key = self
            .store
            .known_identity(peer_user_id)
            .ok_or_else(|| CmdError::new("no-identity", "peer identity unknown; start a session"))?;
        let fp = Fingerprint::new(
            SAFETY_NUMBER_VERSION,
            SAFETY_NUMBER_ITERATIONS,
            self.store.self_user_id().as_bytes(),
            local_key,
            peer_user_id.as_bytes(),
            &remote_key,
        )
        .map_err(|e| CmdError::new("fingerprint", &e.to_string()))?;
        fp.display_string()
            .map_err(|e| CmdError::new("fingerprint", &e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Уникальный временный каталог под одного «пользователя» в тесте.
    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kd-crypto-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    // Имитация того, что делает сервер: из опубликованного бандла собрать
    // BundleIn для инициатора, выдав ОДИН одноразовый prekey.
    fn bundle_for_session(b: &PublicBundle) -> BundleIn {
        BundleIn {
            identity_key: b.identity_key.clone(),
            registration_id: b.registration_id,
            signed_prekey: SignedPrekeyIn {
                key_id: b.signed_prekey.key_id,
                pub_key: b.signed_prekey.pub_key.clone(),
                signature: b.signed_prekey.signature.clone(),
            },
            kyber_prekey: KyberPrekeyIn {
                key_id: b.kyber_prekey.key_id,
                pub_key: b.kyber_prekey.pub_key.clone(),
                signature: b.kyber_prekey.signature.clone(),
            },
            one_time_prekey: b.one_time_prekeys.first().map(|otp| OneTimePrekeyIn {
                key_id: otp.key_id,
                pub_key: otp.pub_key.clone(),
            }),
        }
    }

    // Полный сценарий PQXDH + Double Ratchet между двумя «устройствами».
    #[test]
    fn pqxdh_roundtrip_and_safety_number() {
        let alice_dir = tmp_dir("alice");
        let bob_dir = tmp_dir("bob");
        let alice_id = "11111111-1111-1111-1111-111111111111";
        let bob_id = "22222222-2222-2222-2222-222222222222";

        let mut alice = create(&alice_dir, alice_id).expect("alice init");
        let mut bob = create(&bob_dir, bob_id).expect("bob init");

        // Боб публикует ключи; «сервер» отдаёт Алисе бандл с одним OTP.
        let bob_bundle = bob.publish_keys(5).expect("bob publish");
        let in_bundle = bundle_for_session(&bob_bundle);

        // Первое сообщение Алисы → prekey (устанавливает сессию через PQXDH).
        let m1 = alice
            .encrypt(bob_id, "привет, боб", Some(in_bundle))
            .expect("alice encrypt 1");
        assert_eq!(m1.msg_type, "prekey");
        assert!(alice.session_exists(bob_id));

        let p1 = bob
            .decrypt(alice_id, &m1.ciphertext, &m1.msg_type)
            .expect("bob decrypt 1");
        assert_eq!(p1, "привет, боб");
        assert!(bob.session_exists(alice_id));

        // Ответ Боба → message (Double Ratchet, сессия уже есть).
        let m2 = bob.encrypt(alice_id, "привет, алиса", None).expect("bob encrypt 2");
        assert_eq!(m2.msg_type, "message");
        let p2 = alice
            .decrypt(bob_id, &m2.ciphertext, &m2.msg_type)
            .expect("alice decrypt 2");
        assert_eq!(p2, "привет, алиса");

        // Второе сообщение Алисы тоже уже Double Ratchet.
        let m3 = alice.encrypt(bob_id, "как дела?", None).expect("alice encrypt 3");
        assert_eq!(m3.msg_type, "message");
        let p3 = bob
            .decrypt(alice_id, &m3.ciphertext, &m3.msg_type)
            .expect("bob decrypt 3");
        assert_eq!(p3, "как дела?");

        // Safety number симметричен у обеих сторон.
        let sn_alice = alice.safety_number(bob_id).expect("alice safety number");
        let sn_bob = bob.safety_number(alice_id).expect("bob safety number");
        assert_eq!(sn_alice, sn_bob, "safety numbers must match on both sides");
        // 6 чисел по 5 цифр на каждую половину = 60 цифр.
        assert_eq!(sn_alice.len(), 60);

        let _ = fs::remove_dir_all(&alice_dir);
        let _ = fs::remove_dir_all(&bob_dir);
    }

    // Стор переживает «перезапуск»: open() читает зашифрованный снапшот и
    // расшифровывает уже установленную сессию.
    #[test]
    fn store_survives_reopen() {
        let alice_dir = tmp_dir("alice-reopen");
        let bob_dir = tmp_dir("bob-reopen");
        let alice_id = "33333333-3333-3333-3333-333333333333";
        let bob_id = "44444444-4444-4444-4444-444444444444";

        let mut bob = create(&bob_dir, bob_id).expect("bob init");
        let bob_bundle = bob.publish_keys(5).expect("bob publish");

        {
            let mut alice = create(&alice_dir, alice_id).expect("alice init");
            let m1 = alice
                .encrypt(bob_id, "первое", Some(bundle_for_session(&bob_bundle)))
                .expect("alice encrypt");
            bob.decrypt(alice_id, &m1.ciphertext, &m1.msg_type)
                .expect("bob decrypt");
            // Боб отвечает → Алиса принимает: сессия Алисы становится
            // «подтверждённой» (дальше она шлёт уже Whisper, не prekey).
            let reply = bob.encrypt(alice_id, "ответ", None).expect("bob reply");
            let got = alice
                .decrypt(bob_id, &reply.ciphertext, &reply.msg_type)
                .expect("alice decrypt reply");
            assert_eq!(got, "ответ");
        } // alice сбрасывается из памяти

        // Перечитываем стор с диска — подтверждённая ratchet-сессия должна сохраниться.
        let mut alice2 = open(&alice_dir).expect("reopen ok").expect("store present");
        assert!(alice2.session_exists(bob_id), "session must persist across reopen");
        let m2 = alice2.encrypt(bob_id, "второе", None).expect("encrypt after reopen");
        assert_eq!(m2.msg_type, "message");
        let p2 = bob.decrypt(alice_id, &m2.ciphertext, &m2.msg_type).expect("bob decrypt 2");
        assert_eq!(p2, "второе");

        let _ = fs::remove_dir_all(&alice_dir);
        let _ = fs::remove_dir_all(&bob_dir);
    }
}
