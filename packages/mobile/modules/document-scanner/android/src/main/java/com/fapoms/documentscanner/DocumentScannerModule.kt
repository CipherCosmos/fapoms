package com.fapoms.documentscanner

import android.app.Activity
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.atomic.AtomicInteger

class ScanOptions : Record {
  /** Max pages the user may capture. ML Kit's own default is unbounded. */
  @Field val pageLimit: Int? = null

  /** "full" | "base_with_filter" | "base" — controls how much of ML Kit's editor UI is offered. */
  @Field val scannerMode: String = "full"

  /** Lets the user pull an existing photo in from the gallery, like Drive does. */
  @Field val galleryImportAllowed: Boolean = true

  /** "pdf" | "jpeg" | "both" — which artifacts ML Kit should produce. */
  @Field val resultFormat: String = "both"
}

private class MissingActivityException :
  CodedException("ERR_NO_ACTIVITY", "No foreground Activity to launch the scanner from.", null)

private class ScannerLaunchException(cause: String?) :
  CodedException("ERR_SCANNER_LAUNCH", cause ?: "The document scanner could not be started.", null)

class DocumentScannerModule : Module() {
  /**
   * Every launch registers its own ActivityResult key.
   *
   * The upstream plugin reused the literal key "document-scanner" on every call and never
   * unregistered it, so scanning twice in one session registered a duplicate key against the
   * same registry. Field assayers scan several packets per branch visit, so this was hit
   * routinely rather than as an edge case.
   */
  private val launchCounter = AtomicInteger(0)

  override fun definition() = ModuleDefinition {
    Name("FapomsDocumentScanner")

    AsyncFunction("scanDocument") { options: ScanOptions, promise: Promise ->
      val activity = appContext.currentActivity as? ComponentActivity
        ?: throw MissingActivityException()

      val formats = when (options.resultFormat) {
        "pdf" -> intArrayOf(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
        "jpeg" -> intArrayOf(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
        else -> intArrayOf(
          GmsDocumentScannerOptions.RESULT_FORMAT_JPEG,
          GmsDocumentScannerOptions.RESULT_FORMAT_PDF,
        )
      }

      val scannerMode = when (options.scannerMode) {
        "base" -> GmsDocumentScannerOptions.SCANNER_MODE_BASE
        "base_with_filter" -> GmsDocumentScannerOptions.SCANNER_MODE_BASE_WITH_FILTER
        else -> GmsDocumentScannerOptions.SCANNER_MODE_FULL
      }

      val builder = GmsDocumentScannerOptions.Builder()
        .setResultFormats(formats.first(), *formats.drop(1).toIntArray())
        .setScannerMode(scannerMode)
        .setGalleryImportAllowed(options.galleryImportAllowed)

      options.pageLimit?.let { builder.setPageLimit(it) }

      val key = "fapoms-document-scanner-${launchCounter.incrementAndGet()}"
      var launcher: ActivityResultLauncher<IntentSenderRequest>? = null
      // Guards against the registry firing more than once for a single launch, which would
      // reject an already-resolved promise and crash in dev.
      var settled = false

      launcher = activity.activityResultRegistry.register(key, StartIntentSenderForResult()) { result ->
        if (settled) return@register
        settled = true
        launcher?.unregister()

        when (result.resultCode) {
          Activity.RESULT_OK -> {
            val scan = GmsDocumentScanningResult.fromActivityResultIntent(result.data)
            promise.resolve(serialize(scan))
          }
          Activity.RESULT_CANCELED -> promise.resolve(cancelled())
          /**
           * Any other result code also resolves.
           *
           * Upstream only handled OK and CANCELED, so an unexpected code left the promise
           * pending forever — the JS caller sat on a spinner with no timeout and no way back.
           */
          else -> promise.resolve(cancelled())
        }
      }

      GmsDocumentScanning.getClient(builder.build())
        .getStartScanIntent(activity)
        .addOnSuccessListener { intentSender ->
          launcher.launch(IntentSenderRequest.Builder(intentSender).build())
        }
        .addOnFailureListener { error ->
          if (settled) return@addOnFailureListener
          settled = true
          launcher.unregister()
          promise.reject(ScannerLaunchException(error.message))
        }
    }
  }

  private fun cancelled(): Map<String, Any?> = mapOf(
    "status" to "cancel",
    "pages" to emptyList<Map<String, Any?>>(),
    "pdf" to null,
  )

  /**
   * Returns file:// URIs rather than base64.
   *
   * The upstream module decoded every page into a Bitmap and re-encoded it to a base64 string
   * across the bridge. A 6-page scan at full quality is tens of megabytes of JS string, which
   * is both an OOM risk on low-end field devices and pointless work when the PDF is what gets
   * uploaded. Callers that genuinely need bytes can read the URI on demand.
   */
  private fun serialize(scan: GmsDocumentScanningResult?): Map<String, Any?> {
    if (scan == null) return cancelled()

    val pages = scan.pages.orEmpty().mapIndexed { index, page ->
      mapOf(
        "uri" to localize(page.imageUri, "page_${index + 1}", "jpg"),
        "pageNumber" to index + 1,
      )
    }

    val pdf = scan.pdf?.let {
      mapOf(
        "uri" to localize(it.uri, "scan", "pdf"),
        "pageCount" to it.pageCount,
      )
    }

    return mapOf(
      "status" to "success",
      "pages" to pages,
      "pdf" to pdf,
    )
  }

  /**
   * Copies an ML Kit result into our own cache dir and hands back a `file://` URI.
   *
   * ML Kit hands back URIs it owns, and depending on the Play Services build those can be
   * `content://`. `FileSystem.uploadAsync` streams from `file://` paths only, so passing the
   * raw URI through would fail to upload on some devices and not others — the worst kind of
   * field bug to diagnose. Copying once here makes the JS contract uniform.
   */
  private fun localize(uri: android.net.Uri, prefix: String, extension: String): String {
    if (uri.scheme == "file") return uri.toString()

    val context = appContext.reactContext ?: return uri.toString()
    val target = java.io.File(
      context.cacheDir,
      "mlkit_scan_${System.currentTimeMillis()}_${prefix}.$extension",
    )

    return try {
      context.contentResolver.openInputStream(uri).use { input ->
        if (input == null) return uri.toString()
        target.outputStream().use { output -> input.copyTo(output) }
      }
      android.net.Uri.fromFile(target).toString()
    } catch (error: Exception) {
      // Fall back to the original URI — a possibly-unreadable URI still beats losing the scan.
      uri.toString()
    }
  }
}
