function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

/** Open an external URL. In Tauri the OS default browser is used (so the link
 *  does not load inside the desktop window). In web-only dev mode we fall
 *  back to a noopener window.open. */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/plugin-shell')
      await mod.open(url)
      return
    } catch (err) {
      // Фолбэк на window.open сознательно убран: он загрузил бы ссылку
      // внутри webview доверенного окна приложения. Лучше не открыть вовсе,
      // чем открыть удалённый контент в trusted-контексте.
      console.warn('[host/shell] cannot open external link in Tauri:', url, err)
      return
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
