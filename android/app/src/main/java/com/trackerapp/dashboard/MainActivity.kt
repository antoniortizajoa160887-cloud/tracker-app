package com.trackerapp.dashboard

import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Wraps the same index.html the desktop app uses. Fetches the latest copy
 * from GitHub on every launch (mirroring main.js's resolveAppHtmlPath),
 * falling back to the last successfully fetched copy, then to the bundled
 * asset if neither is available. Unlike Electron, Android's WebChromeClient
 * has real, built-in support for alert()/confirm()/prompt() dialogs, so none
 * of the workarounds the desktop build needed apply here.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    private data class FetchResult(val loadUrl: String, val source: String, val error: String?)

    companion object {
        private const val REMOTE_HTML_URL =
            "https://api.github.com/repos/antoniortizajoa160887-cloud/tracker-app/contents/index.html?ref=main"
        private const val FETCH_TIMEOUT_MS = 8000
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(
                view: WebView?, url: String?, message: String?, result: JsResult?
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle(deriveDialogTitle(message))
                    .setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .setCancelable(true)
                    .show()
                return true
            }

            override fun onJsConfirm(
                view: WebView?, url: String?, message: String?, result: JsResult?
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle(deriveDialogTitle(message))
                    .setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result?.confirm() }
                    .setNegativeButton("Cancel") { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .setCancelable(true)
                    .show()
                return true
            }

            override fun onJsPrompt(
                view: WebView?,
                url: String?,
                message: String?,
                defaultValue: String?,
                result: JsPromptResult?
            ): Boolean {
                val input = android.widget.EditText(this@MainActivity).apply {
                    inputType = InputType.TYPE_CLASS_TEXT
                    setText(defaultValue ?: "")
                    setSelection(text.length)
                }
                val padding = (16 * resources.displayMetrics.density).toInt()
                val container = android.widget.FrameLayout(this@MainActivity).apply {
                    setPadding(padding, padding / 2, padding, 0)
                    addView(input)
                }
                val dialog = AlertDialog.Builder(this@MainActivity)
                    .setTitle(deriveDialogTitle(message))
                    .setMessage(message)
                    .setView(container)
                    .setPositiveButton("OK") { _, _ -> result?.confirm(input.text.toString()) }
                    .setNegativeButton("Cancel") { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .setCancelable(true)
                    .create()
                input.setOnEditorActionListener { _, _, event ->
                    if (event == null || event.keyCode == KeyEvent.KEYCODE_ENTER) {
                        result?.confirm(input.text.toString())
                        dialog.dismiss()
                        true
                    } else {
                        false
                    }
                }
                dialog.show()
                return true
            }
        }

        CoroutineScope(Dispatchers.Main).launch {
            val fetch = withContext(Dispatchers.IO) { resolveHtmlToLoad() }
            webView.loadUrl(fetch.loadUrl)
            if (fetch.source != "live") {
                webView.postDelayed({ injectStatusBanner(fetch.source, fetch.error) }, 800)
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun cacheFile(): File = File(filesDir, "index.html")
    private fun cacheFileUrl(): String = "file://${cacheFile().absolutePath}"

    // Pulls the latest index.html from the repo on every launch, caching the
    // last successful fetch so the app still opens offline. Falls back to
    // the copy bundled at build time (as a raw asset, loadable directly via
    // the file:///android_asset/ scheme) if nothing has ever been cached.
    private fun resolveHtmlToLoad(): FetchResult {
        try {
            val conn = URL(REMOTE_HTML_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = FETCH_TIMEOUT_MS
            conn.readTimeout = FETCH_TIMEOUT_MS
            conn.setRequestProperty("Accept", "application/vnd.github.raw")
            conn.setRequestProperty("User-Agent", "unified-logistics-hr-dashboard-android")
            conn.connect()

            if (conn.responseCode == HttpURLConnection.HTTP_OK) {
                val html = conn.inputStream.bufferedReader().use { it.readText() }
                if (html.length >= 1000) {
                    cacheFile().writeText(html)
                    return FetchResult(cacheFileUrl(), "live", null)
                }
                return fallbackAfterFailure("Fetched content looks too small, ignoring")
            }
            return fallbackAfterFailure("Unexpected status ${conn.responseCode}")
        } catch (e: Exception) {
            return fallbackAfterFailure(e.message ?: e.toString())
        }
    }

    private fun fallbackAfterFailure(error: String): FetchResult {
        return if (cacheFile().exists()) {
            FetchResult(cacheFileUrl(), "cached", error)
        } else {
            FetchResult("file:///android_asset/index.html", "bundled", error)
        }
    }

    private fun injectStatusBanner(source: String, error: String?) {
        val label = if (source == "cached")
            "Showing last downloaded version — could not reach GitHub just now"
        else
            "Showing the version bundled with the app — could not reach GitHub"
        val detail = if (error != null) " ($error)" else ""
        val message = (label + detail).replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")
        val js = """
            (function(){
              var b = document.createElement('div');
              b.textContent = '$message';
              b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b45309;color:#fff;font:12px/1.4 sans-serif;padding:6px 12px;text-align:center;';
              document.body.appendChild(b);
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun deriveDialogTitle(message: String?): String {
        val m = message ?: ""
        val patterns = listOf(
            Regex("delete all routes", RegexOption.IGNORE_CASE) to "Delete All Routes",
            Regex("delete all claims", RegexOption.IGNORE_CASE) to "Delete All Claims",
            Regex("delete all charges", RegexOption.IGNORE_CASE) to "Delete All Charges",
            Regex("delete all users", RegexOption.IGNORE_CASE) to "Delete All Users",
            Regex("reset all data", RegexOption.IGNORE_CASE) to "Reset All Data",
            Regex("reset system", RegexOption.IGNORE_CASE) to "System Reset",
            Regex("new password", RegexOption.IGNORE_CASE) to "Reset Password"
        )
        for ((re, title) in patterns) {
            if (re.containsMatchIn(m)) return title
        }
        val firstLine = m.substringBefore("\n").trimEnd(':', '?', ' ').trim()
        return if (firstLine.isNotEmpty() && firstLine.length <= 60) firstLine
        else getString(R.string.app_name)
    }
}
