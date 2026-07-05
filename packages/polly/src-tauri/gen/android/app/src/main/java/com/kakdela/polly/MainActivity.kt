package com.kakdela.polly

import android.Manifest
import android.content.ContentUris
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

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
    this.webView = webView
    // Галерея внутри приложения (композер, «+»): lib/host/media.ts дёргает
    // этот мост вместо системного пикера.
    webView.addJavascriptInterface(KdMediaBridge(), "KdMedia")
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

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != MEDIA_PERMISSION_REQUEST) return
    // На Android 14+ «частичный доступ» даёт VISUAL_USER_SELECTED при отказе в
    // полных READ_MEDIA_* — любой granted означает «галерея доступна».
    val granted = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
    webView?.post {
      webView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('kd-media-permission',{detail:{granted:$granted}}))",
        null,
      )
    }
  }

  private fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= 34 -> arrayOf(
      Manifest.permission.READ_MEDIA_IMAGES,
      Manifest.permission.READ_MEDIA_VIDEO,
      Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
    )
    Build.VERSION.SDK_INT >= 33 -> arrayOf(
      Manifest.permission.READ_MEDIA_IMAGES,
      Manifest.permission.READ_MEDIA_VIDEO,
    )
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
  }

  /**
   * Мост к MediaStore для галереи внутри приложения. Методы зовутся с
   * JS-bridge-потока (не UI) — ContentResolver там безопасен. Формат ответов —
   * JSON-строки, парсит lib/host/media.ts.
   */
  inner class KdMediaBridge {
    @JavascriptInterface
    fun hasPermission(): Boolean = mediaPermissions().any {
      ContextCompat.checkSelfPermission(this@MainActivity, it) == PackageManager.PERMISSION_GRANTED
    }

    @JavascriptInterface
    fun requestPermission() {
      runOnUiThread {
        ActivityCompat.requestPermissions(this@MainActivity, mediaPermissions(), MEDIA_PERMISSION_REQUEST)
      }
    }

    /** Последние фото и видео, новые сверху: [{uri,mime,video,durationMs,name,size}]. */
    @JavascriptInterface
    fun list(offset: Int, limit: Int): String {
      val items = JSONArray()
      val collection = MediaStore.Files.getContentUri("external")
      val hasDuration = Build.VERSION.SDK_INT >= 29
      val projection = buildList {
        add(MediaStore.Files.FileColumns._ID)
        add(MediaStore.Files.FileColumns.MEDIA_TYPE)
        add(MediaStore.Files.FileColumns.MIME_TYPE)
        add(MediaStore.Files.FileColumns.DISPLAY_NAME)
        add(MediaStore.Files.FileColumns.SIZE)
        if (hasDuration) add(MediaStore.Files.FileColumns.DURATION)
      }.toTypedArray()
      val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (?,?)"
      val selectionArgs = arrayOf(
        MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(),
        MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString(),
      )
      try {
        contentResolver.query(
          collection, projection, selection, selectionArgs,
          "${MediaStore.Files.FileColumns.DATE_ADDED} DESC",
        )?.use { c ->
          var skipped = 0
          while (c.moveToNext()) {
            if (skipped < offset) { skipped++; continue }
            if (items.length() >= limit) break
            val id = c.getLong(0)
            val isVideo = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
            items.put(
              JSONObject()
                .put("uri", ContentUris.withAppendedId(collection, id).toString())
                .put("mime", c.getString(2) ?: "")
                .put("video", isVideo)
                .put("name", c.getString(3) ?: "media")
                .put("size", c.getLong(4))
                .put("durationMs", if (hasDuration && isVideo) c.getLong(5) else 0L),
            )
          }
        }
      } catch (e: Exception) {
        return JSONArray().toString()
      }
      return items.toString()
    }

    /** Квадратная миниатюра как data-URL (JPEG); "" — если не вышло. */
    @JavascriptInterface
    fun thumb(uriStr: String, px: Int): String {
      if (Build.VERSION.SDK_INT < 29) return ""
      return try {
        val bmp = contentResolver.loadThumbnail(Uri.parse(uriStr), Size(px, px), null)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 78, out)
        bmp.recycle()
        "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
      } catch (e: Exception) {
        ""
      }
    }

    /** Полное содержимое файла: {ok,b64}|{ok:false,error}. Кап — лимит вложений. */
    @JavascriptInterface
    fun read(uriStr: String): String {
      val res = JSONObject()
      return try {
        val bytes = contentResolver.openInputStream(Uri.parse(uriStr))?.use { it.readBytes() }
          ?: return res.put("ok", false).put("error", "не удалось открыть файл").toString()
        if (bytes.size > MAX_READ_BYTES) {
          return res.put("ok", false).put("error", "файл больше 25 МБ").toString()
        }
        res.put("ok", true).put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString()
      } catch (e: Exception) {
        res.put("ok", false).put("error", e.message ?: "read failed").toString()
      }
    }
  }

  companion object {
    private const val MEDIA_PERMISSION_REQUEST = 48123

    /** = MAX_ATTACHMENT_SIZE в ginzu (25 МБ) — больше сервер всё равно не примет. */
    private const val MAX_READ_BYTES = 25 * 1024 * 1024
  }
}
