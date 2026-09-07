// T-102 — зашифрованная локальная история секретных чатов.
//
// Источник истины истории секретных переписок. Только plaintext-сообщения,
// которые УЖЕ расшифрованы крипто-ядром (T-101) — здесь крипты нет, только
// хранение. Весь снапшот шифруется AES-256-GCM (crate::sealed) тем же DEK, что и
// крипто-стор: одно «секретное хранилище устройства». Wipe данных = потеря
// истории (device-bound).
//
// Модель хранения: единый зашифрованный снапшот (а не SQLite/SQLCipher). Причина:
// сохранить чистую pure-Rust кросс-компиляцию под Android (SQLCipher тянет C/
// boringssl — ровно ту проблему, ради которой выбрана эта связка). Масштаб
// (15-20 друзей, только текст) делает полный rewrite снапшота дешёвым. Карточка
// T-102 это допускает («либо app-private storage»).
//
// control-конверты (read/typing) НЕ хранятся как сообщения: 'read' двигает
// статус исходящих (галочки), 'typing' эфемерен. В историю попадает только текст.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CmdError;
use crate::sealed::{self, KeyProvider};

const HISTORY_FILE: &str = "secret-history.bin";

/// Статус доставки исходящего сообщения (для галочек в UI, T-103).
/// 'sent' — отдано на релей; 'read' — пришёл встречный read-конверт.
/// Входящие всегда 'delivered'.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Sent,
    Delivered,
    Read,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    In,
    Out,
}

/// Одно сохранённое текстовое сообщение секретного чата.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    /// Монотонный локальный id (он же ключ порядка). Уникален в пределах устройства.
    pub id: u64,
    pub peer_user_id: String,
    pub direction: Direction,
    /// Расшифрованный текст. На диске — только внутри зашифрованного снапшота.
    pub body: String,
    /// Время отправки (epoch ms), как указал отправитель в control-frame.
    pub sent_at_ms: u64,
    /// Когда сообщение прочитано (epoch ms). Для исходящих — по входящему read-конверту.
    pub read_at_ms: Option<u64>,
    pub status: Status,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Snapshot {
    next_id: u64,
    messages: Vec<StoredMessage>,
    // Аудит 2026-08 M-10: watermark обработанных конвертов (peer → последний
    // envelope id). Id конвертов — uuidv7 (лексикографически = хронологически),
    // релей отдаёт inbox по возрастанию, поэтому сравнения строк достаточно.
    // Служит дедупом «decrypt → показать → ack»: креш между показом и ack
    // приводит к повторной доставке, и без watermark повторный decrypt упал бы
    // (ratchet уже продвинулся), а конверт завис до retention-чистки.
    #[serde(default)]
    envelope_watermarks: std::collections::HashMap<String, String>,
    // Exact IDs: pagination may skip poison envelopes; an ordering watermark
    // must never implicitly mark an unprocessed earlier envelope as seen.
    #[serde(default)]
    seen_envelope_ids: std::collections::HashMap<String, std::collections::HashSet<String>>,
}

pub struct HistoryStore {
    path: PathBuf,
    key_provider: Box<dyn KeyProvider>,
    snap: Snapshot,
}

/// Открыть (или создать пустую) локальную историю в `<app_data>/kd-secret/`.
/// В отличие от крипто-ядра здесь нет «инициализации»: пустой снапшот валиден.
pub fn open(app_data_dir: &Path) -> Result<HistoryStore, CmdError> {
    let key_provider = sealed::default_key_provider(app_data_dir)?;
    open_with_provider(app_data_dir, key_provider)
}

/// Явный провайдер — для юнит-тестов (SoftwareKeyProvider): реальный OS-keychain
/// между тестами общий, параллельные прогоны затирали бы DEK друг друга.
pub fn open_with_provider(
    app_data_dir: &Path,
    key_provider: Box<dyn KeyProvider>,
) -> Result<HistoryStore, CmdError> {
    let dir = sealed::data_dir(app_data_dir)?;
    let path = dir.join(HISTORY_FILE);
    let mut snap: Snapshot = match sealed::read_sealed(&path, key_provider.as_ref())? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| CmdError::internal("deserialize", &format!("history deserialize: {e}")))?,
        None => Snapshot::default(),
    };
    // Only the exact legacy watermark is known to have been processed.
    for (peer, id) in snap.envelope_watermarks.drain() {
        snap.seen_envelope_ids.entry(peer).or_default().insert(id);
    }
    Ok(HistoryStore {
        path,
        key_provider,
        snap,
    })
}

impl HistoryStore {
    fn persist(&self) -> Result<(), CmdError> {
        let bytes = serde_json::to_vec(&self.snap)
            .map_err(|e| CmdError::internal("serialize", &format!("history serialize: {e}")))?;
        sealed::write_sealed(&self.path, self.key_provider.as_ref(), &bytes)
    }

    fn push(
        &mut self,
        peer_user_id: &str,
        direction: Direction,
        body: String,
        sent_at_ms: u64,
        status: Status,
    ) -> Result<StoredMessage, CmdError> {
        let before = self.snap.clone();
        let id = self.snap.next_id;
        self.snap.next_id = self.snap.next_id.wrapping_add(1);
        let msg = StoredMessage {
            id,
            peer_user_id: peer_user_id.to_string(),
            direction,
            body,
            sent_at_ms,
            read_at_ms: None,
            status,
        };
        self.snap.messages.push(msg.clone());
        if let Err(err) = self.persist() { self.snap = before; return Err(err); }
        Ok(msg)
    }

    /// Записать своё исходящее сообщение (после успешной отправки на релей).
    pub fn append_outgoing(
        &mut self,
        peer_user_id: &str,
        body: String,
        sent_at_ms: u64,
    ) -> Result<StoredMessage, CmdError> {
        self.push(peer_user_id, Direction::Out, body, sent_at_ms, Status::Sent)
    }

    /// Обработан ли уже этот конверт (дедуп повторной доставки, M-10).
    pub fn is_envelope_seen(&self, peer_user_id: &str, envelope_id: &str) -> bool {
        self.snap
            .seen_envelope_ids
            .get(peer_user_id)
            .is_some_and(|ids| ids.contains(envelope_id))
    }

    /// Запомнить конверт обработанным БЕЗ записи в историю (контрол-конверты
    /// read/typing — они в историю не попадают).
    pub fn mark_envelope_seen(
        &mut self,
        peer_user_id: &str,
        envelope_id: &str,
    ) -> Result<(), CmdError> {
        let before = self.snap.clone();
        if self.snap.seen_envelope_ids.entry(peer_user_id.to_string()).or_default().insert(envelope_id.to_string()) {
            if let Err(err) = self.persist() { self.snap = before; return Err(err); }
        }
        Ok(())
    }

    /// Записать входящее сообщение (после расшифровки) и запомнить его конверт.
    /// None — конверт уже был обработан (повторная доставка): дубликат НЕ пишем.
    pub fn append_incoming(
        &mut self,
        peer_user_id: &str,
        body: String,
        sent_at_ms: u64,
        envelope_id: &str,
    ) -> Result<Option<StoredMessage>, CmdError> {
        if self.is_envelope_seen(peer_user_id, envelope_id) {
            return Ok(None);
        }
        let before = self.snap.clone();
        self.snap.seen_envelope_ids.entry(peer_user_id.to_string()).or_default().insert(envelope_id.to_string());
        // Message and exact processed ID are committed in ONE encrypted snapshot.
        let msg = match self.push(peer_user_id, Direction::In, body, sent_at_ms, Status::Delivered) {
            Ok(msg) => msg,
            Err(err) => { self.snap = before; return Err(err); }
        };
        Ok(Some(msg))
    }

    /// Пометить исходящие сообщения собеседнику прочитанными (по входящему
    /// read-конверту): все ИСХОДЯЩИЕ с sent_at_ms <= before_ms → status=read.
    /// Возвращает, сколько строк изменилось.
    pub fn mark_outgoing_read(&mut self, peer_user_id: &str, before_ms: u64) -> Result<u32, CmdError> {
        let mut changed = 0u32;
        for m in &mut self.snap.messages {
            if m.peer_user_id == peer_user_id
                && m.direction == Direction::Out
                && m.status != Status::Read
                && m.sent_at_ms <= before_ms
            {
                m.status = Status::Read;
                m.read_at_ms = Some(before_ms);
                changed += 1;
            }
        }
        if changed > 0 {
            self.persist()?;
        }
        Ok(changed)
    }

    /// Все сообщения с собеседником в порядке id (= порядок добавления).
    pub fn list(&self, peer_user_id: &str) -> Vec<StoredMessage> {
        let mut out: Vec<StoredMessage> = self
            .snap
            .messages
            .iter()
            .filter(|m| m.peer_user_id == peer_user_id)
            .cloned()
            .collect();
        out.sort_by_key(|m| m.id);
        out
    }

    /// userId'ы всех собеседников, с кем есть история (для списка чатов, T-103).
    pub fn peers(&self) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for m in &self.snap.messages {
            if !seen.iter().any(|p| p == &m.peer_user_id) {
                seen.push(m.peer_user_id.clone());
            }
        }
        seen
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kd-history-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    /// Тестовый стор на софтварном DEK-файле: реальный OS-keychain между
    /// тестами общий, параллельные прогоны затирали бы DEK друг друга.
    fn open_test(dir: &Path) -> HistoryStore {
        open_with_provider(dir, Box::new(sealed::SoftwareKeyProvider::new(&sealed::data_dir(dir).expect("secret dir"))))
            .expect("open test store")
    }

    #[test]
    fn append_list_and_read_receipt() {
        let dir = tmp_dir("basic");
        let peer = "aaaaaaaa-0000-0000-0000-000000000001";
        let mut h = open_test(&dir);

        h.append_outgoing(peer, "привет".into(), 1000).expect("out1");
        h.append_incoming(peer, "о, привет".into(), 1100, "env-test-1").expect("in1");
        h.append_outgoing(peer, "как сам?".into(), 1200).expect("out2");

        let msgs = h.list(peer);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].body, "привет");
        assert!(matches!(msgs[0].direction, Direction::Out));
        assert!(matches!(msgs[1].direction, Direction::In));
        // Исходящие пока 'sent'.
        assert!(matches!(msgs[0].status, Status::Sent));

        // Пришёл read-конверт «прочитано до 1200» → оба исходящих становятся read.
        let changed = h.mark_outgoing_read(peer, 1200).expect("mark read");
        assert_eq!(changed, 2);
        let msgs = h.list(peer);
        assert!(matches!(msgs[0].status, Status::Read));
        assert!(matches!(msgs[2].status, Status::Read));
        // Входящее не трогаем.
        assert!(matches!(msgs[1].status, Status::Delivered));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_survives_reopen() {
        let dir = tmp_dir("reopen");
        let peer = "bbbbbbbb-0000-0000-0000-000000000002";
        {
            let mut h = open_test(&dir);
            h.append_outgoing(peer, "до перезапуска".into(), 5).expect("out");
        }
        // Перечитываем зашифрованный снапшот с диска.
        let h2 = open_test(&dir);
        let msgs = h2.list(peer);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].body, "до перезапуска");
        assert_eq!(h2.peers(), vec![peer.to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn envelope_watermark_dedups_redelivery() {
        let dir = tmp_dir("watermark");
        let peer = "cccccccc-0000-0000-0000-000000000003";
        let mut h = open_test(&dir);

        assert!(!h.is_envelope_seen(peer, "env-0001"));
        let added = h
            .append_incoming(peer, "привет".into(), 1000, "env-0001")
            .expect("append");
        assert!(added.is_some());
        assert!(h.is_envelope_seen(peer, "env-0001"));
        // An earlier poison envelope was never processed and must not disappear.
        assert!(!h.is_envelope_seen(peer, "env-0000"));
        assert!(!h.is_envelope_seen(peer, "env-0002"));

        // Повторная доставка того же конверта (креш до ack) не дублирует.
        let dup = h
            .append_incoming(peer, "привет".into(), 1000, "env-0001")
            .expect("append dup");
        assert!(dup.is_none());
        assert_eq!(h.list(peer).len(), 1);

        // Контрол-конверт: seen без записи в историю.
        h.mark_envelope_seen(peer, "env-0002").expect("mark");
        assert!(h.is_envelope_seen(peer, "env-0002"));
        assert_eq!(h.list(peer).len(), 1);

        // Watermark переживает переоткрытие снапшота.
        let h2 = open_test(&dir);
        assert!(h2.is_envelope_seen(peer, "env-0002"));

        let _ = fs::remove_dir_all(&dir);
    }
}
