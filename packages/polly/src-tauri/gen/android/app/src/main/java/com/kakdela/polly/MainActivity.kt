package com.kakdela.polly

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  // Последний вычисленный JS с инсетами — переинжектим отложенно, т.к. первый
  // проход insets-листенера может случиться до коммита документа (инлайн-стили
  // на documentElement теряются при навигации).
  private var insetsJs: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // env(safe-area-inset-*) в Android WebView всегда 0, поэтому системные
  // инсеты (статус-бар с вырезом камеры, жестовая навигация) прокидываем в
  // CSS-переменные --kd-safe-* (см. tokens.css) вручную.
  override fun onWebViewCreate(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val d = view.resources.displayMetrics.density
      val js = listOf(
        "top" to bars.top,
        "bottom" to bars.bottom,
        "left" to bars.left,
        "right" to bars.right,
      ).joinToString("") { (side, px) ->
        "document.documentElement.style.setProperty('--kd-safe-$side','${(px / d).roundToInt()}px');"
      }
      insetsJs = js
      (view as WebView).evaluateJavascript(js, null)
      insets
    }
    for (delayMs in longArrayOf(500, 1500, 3500)) {
      webView.postDelayed({ insetsJs?.let { webView.evaluateJavascript(it, null) } }, delayMs)
    }
  }
}
