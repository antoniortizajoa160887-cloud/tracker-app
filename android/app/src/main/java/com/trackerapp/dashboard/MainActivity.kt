package com.trackerapp.dashboard

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

/**
 * Wraps the same index.html the desktop app uses. Fetches the latest copy
 * from GitHub on every launch (mirroring main.js's resolveAppHtmlPath),
 * falling back to the last successfully fetched copy, then to the bundled
 * asset if neither is available. Unlike Electron, Android's WebChromeClient
 * has real, built-in support for alert()/confirm()/prompt() dialogs, so none
 * of the workarounds the desktop build needed apply here.
 *
 * Also checks for a newer build of the app itself (see checkForAppUpdate) —
 * unlike the desktop auto-updater, Android does not allow a sideloaded app
 * to install itself silently; the closest available equivalent is
 * download-in-background + hand it to the system installer, which still
 * requires one tap from the user.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    private data class FetchResult(val loadUrl: String, val source: String, val error: String?)
    private data class UpdateManifest(
        val versionCode: Int,
        val versionName: String,
        val apkFileName: String,
        val sha256: String
    )

    companion object {
        private const val REPO_CONTENTS_BASE =
            "https://api.github.com/repos/antoniortizajoa160887-cloud/tracker-app/contents"
        private const val REMOTE_HTML_URL = "$REPO_CONTENTS_BASE/index.html?ref=main"
        private const val REMOTE_MANIFEST_URL = "$REPO_CONTENTS_BASE/installer/android/latest.json?ref=main"
        private const val FETCH_TIMEOUT_MS = 8000
        private const val DOWNLOAD_TIMEOUT_MS = 30000
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
                webView.postDelayed({ injectBanner(contentStatusMessage(fetch.source, fetch.error), "#b45309") }, 800)
            }
        }

        checkForAppUpdate()
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

    private fun contentStatusMessage(source: String, error: String?): String {
        val label = if (source == "cached")
            "Showing last downloaded version — could not reach GitHub just now"
        else
            "Showing the version bundled with the app — could not reach GitHub"
        return label + (if (error != null) " ($error)" else "")
    }

    private fun injectBanner(message: String, background: String) {
        val escaped = message.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")
        val js = """
            (function(){
              var old = document.getElementById('__update_banner__');
              if (old) old.remove();
              var b = document.createElement('div');
              b.id = '__update_banner__';
              b.textContent = '$escaped';
              b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:$background;color:#fff;font:12px/1.4 sans-serif;padding:6px 12px;text-align:center;';
              document.body.appendChild(b);
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    // Checks installer/android/latest.json on the repo for a newer
    // versionCode than this build's. If found, downloads that APK in the
    // background and hands it to the system package installer. Android does
    // not allow a non-Play-Store app to install itself without the user
    // tapping through the OS's own confirmation screen — this automates
    // everything up to that one tap, it can't remove it.
    private fun checkForAppUpdate() {
        CoroutineScope(Dispatchers.Main).launch {
            val manifest = withContext(Dispatchers.IO) { fetchUpdateManifest() } ?: return@launch
            if (manifest.versionCode <= BuildConfig.VERSION_CODE) return@launch

            injectBanner("Downloading update v${manifest.versionName}...", "#0e7490")
            val apkFile = withContext(Dispatchers.IO) { downloadUpdateApk(manifest) }
            if (apkFile == null) {
                injectBanner("Could not download update v${manifest.versionName} — will retry next launch", "#b45309")
                return@launch
            }

            injectBanner("Update v${manifest.versionName} ready — opening installer...", "#15803d")
            promptInstall(apkFile)
        }
    }

    private fun fetchUpdateManifest(): UpdateManifest? {
        return try {
            val conn = URL(REMOTE_MANIFEST_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = FETCH_TIMEOUT_MS
            conn.readTimeout = FETCH_TIMEOUT_MS
            conn.setRequestProperty("Accept", "application/vnd.github.raw")
            conn.setRequestProperty("User-Agent", "unified-logistics-hr-dashboard-android")
            conn.connect()
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            UpdateManifest(
                versionCode = json.getInt("versionCode"),
                versionName = json.getString("versionName"),
                apkFileName = json.getString("apkFileName"),
                sha256 = json.getString("sha256")
            )
        } catch (e: Exception) {
            null
        }
    }

    private fun downloadUpdateApk(manifest: UpdateManifest): File? {
        return try {
            val encodedName = URLEncoder.encode(manifest.apkFileName, "UTF-8").replace("+", "%20")
            val url = "$REPO_CONTENTS_BASE/installer/android/$encodedName?ref=main"
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = DOWNLOAD_TIMEOUT_MS
            conn.readTimeout = DOWNLOAD_TIMEOUT_MS
            conn.setRequestProperty("Accept", "application/vnd.github.raw")
            conn.setRequestProperty("User-Agent", "unified-logistics-hr-dashboard-android")
            conn.connect()
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return null

            val updatesDir = File(cacheDir, "apk_updates").apply { mkdirs() }
            val outFile = File(updatesDir, "update.apk")
            val digest = MessageDigest.getInstance("SHA-256")
            outFile.outputStream().use { out ->
                conn.inputStream.use { input ->
                    val buffer = ByteArray(8192)
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        out.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                    }
                }
            }
            val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actualSha256.equals(manifest.sha256, ignoreCase = true)) {
                outFile.delete()
                return null
            }
            outFile
        } catch (e: Exception) {
            null
        }
    }

    private fun promptInstall(apkFile: File) {
        val uri: Uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(intent)
        } catch (e: Exception) {
            injectBanner("Update downloaded, but couldn't open the installer automatically", "#b45309")
        }
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
