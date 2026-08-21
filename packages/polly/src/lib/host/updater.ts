// Проверка и установка обновлений десктоп-клиента (аудит 2026-08, M-5).
// Rust: tauri-plugin-updater зарегистрирован в lib.rs (desktop). Пока в
// tauri.conf.json НЕТ plugins.updater { endpoints, pubkey }, check() вернёт
// ошибку — трактуем как «обновления не сконфигурированы» и возвращаем null
// (см. docs/DEPLOY.md §9 — как включить).

export interface UpdateInfo {
  version: string
  notes: string | null
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

/**
 * Проверить наличие обновления. null — обновлений нет либо updater
 * не сконфигурирован/недоступен (web-dev, ошибка сети/конфига).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null
  try {
    const mod = await import('@tauri-apps/plugin-updater')
    const update = await mod.check()
    if (!update) return null
    return { version: update.version, notes: update.body ?? null }
  } catch (err) {
    console.warn('[host/updater] check failed — updater not provisioned or offline', err)
    return null
  }
}

/**
 * Скачать и установить обновление, затем перезапустить приложение.
 * Бросает при ошибке сети/подписи — вызывающий код показывает UI ошибки.
 */
export async function installUpdateAndRelaunch(): Promise<void> {
  const mod = await import('@tauri-apps/plugin-updater')
  const update = await mod.check()
  if (!update) return
  await update.downloadAndInstall()
  // relaunch_app — rust-команда (app.restart()), процесс завершается.
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('relaunch_app')
}
