// Логика окна входящего звонка (T-087, desktop). Вынесена из call-popup.html
// в отдельный файл: CSP приложения — script-src 'self' без 'unsafe-inline',
// поэтому inline-<script> в HTML был бы заблокирован. Данные звонка берёт
// через get_call_popup_data (invoke), кнопки шлют глобальный tauri-event
// `call-popup-action` главному окну (его ловит IncomingCall) и закрывают окно.
// Использует window.__TAURI__ (withGlobalTauri: true).
(function () {
  // Та же палитра и djb2-хэш, что в app (components/palette.ts) — чтобы
  // цвет аватара в попапе совпадал с аватаром в самом клиенте 1:1.
  var AVATAR_COLORS = ['#c96442', '#d68b6c', '#a87b56', '#7d9268', '#b88c4e', '#8d6e4d', '#c98870', '#9c7f5e']
  function djb2(seed) {
    var h = 5381
    for (var i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0
    return h
  }
  function colorFor(name) {
    return AVATAR_COLORS[djb2(name) % AVATAR_COLORS.length]
  }
  function initials(name) {
    var parts = name.trim().split(/\s+/).filter(Boolean)
    return ((parts[0] ? parts[0][0] : '?') + (parts[1] ? parts[1][0] : '')).toUpperCase()
  }
  function resolveTheme() {
    try {
      var raw = localStorage.getItem('kd:theme:mode')
      var mode = 'system'
      if (raw) { var p = JSON.parse(raw); mode = (p && p.state && p.state.mode) || 'system' }
      if (mode === 'light' || mode === 'dark') return mode
    } catch (_e) {}
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  function T() { return window.__TAURI__ }

  var hideTimer = null
  function armAutoHide() {
    if (hideTimer) clearTimeout(hideTimer)
    // Чуть позже авто-сброса инвайта (32с) в IncomingCall.
    hideTimer = setTimeout(hidePopup, 34000)
  }
  function hidePopup() {
    var t = T()
    try { if (t && t.core && t.core.invoke) t.core.invoke('close_call_popup') } catch (_e) {}
  }
  function respond(action, channelId) {
    var t = T()
    try { if (t && t.event && t.event.emit) t.event.emit('call-popup-action', { action: action, channelId: channelId }) } catch (_e) {}
    hidePopup()
  }
  function render(data) {
    var name = typeof data.fromName === 'string' && data.fromName ? data.fromName : 'входящий звонок'
    document.getElementById('name').textContent = name
    var ava = document.getElementById('ava')
    ava.innerHTML = '' // сброс предыдущего звонка (окно переиспользуется)
    if (data.fromAvatarUrl) {
      var img = document.createElement('img')
      img.src = data.fromAvatarUrl
      img.alt = ''
      ava.appendChild(img)
      ava.style.background = ''
      ava.textContent = ''
    } else {
      ava.style.background = colorFor(name)
      ava.textContent = initials(name)
    }
    // Иконка-телефон в бейдже статуса.
    ava.insertAdjacentHTML('beforeend',
      '<span class="badge"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></span>')
    document.getElementById('accept').onclick = function () { respond('accept', data.channelId) }
    document.getElementById('decline').onclick = function () { respond('decline', data.channelId) }
    armAutoHide()
  }

  function loadAndRender() {
    var t = T()
    if (!t || !t.core || !t.core.invoke) return
    t.core.invoke('get_call_popup_data').then(function (raw) {
      var data = null
      try { data = raw ? JSON.parse(raw) : null } catch (_e) {}
      if (data && typeof data.channelId === 'string') render(data)
    }).catch(function () {})
  }

  function waitTauri(cb, attempt) {
    if (window.__TAURI__ && window.__TAURI__.core) { cb(); return }
    if (attempt < 80) setTimeout(function () { waitTauri(cb, attempt + 1) }, 25)
  }

  document.documentElement.setAttribute('data-theme', resolveTheme())
  // Окно живёт всё время приложения (объявлено в tauri.conf, visible:false).
  // Главное окно дёргает `call-popup-show` на каждый новый звонок — тогда
  // перечитываем данные и перерисовываемся. НЕ закрываем себя на «нет
  // данных»: окно переиспользуется, прячет его Rust (close_call_popup).
  waitTauri(function () {
    var t = window.__TAURI__
    try {
      if (t.event && t.event.listen) t.event.listen('call-popup-show', function () { loadAndRender() })
    } catch (_e) {}
    loadAndRender() // на случай гонки show-до-listen — данные уже в state
  }, 0)
})()
