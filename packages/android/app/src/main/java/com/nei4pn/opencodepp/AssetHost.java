package com.nei4pn.opencodepp;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLConnection;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Answers requests for the embedded web bundle out of {@code assets/app}.
 *
 * <p>The page is served from a real https origin instead of {@code file://} because a file document is not a secure
 * context: {@code window.isSecureContext} is false there and the QR scanner of the web app stays switched off. Nothing
 * leaves the APK, the origin only exists inside the WebView.
 */
final class AssetHost {

  static final String SCHEME = "https";
  static final String HOST = "appassets.androidplatform.net";
  static final String ORIGIN = SCHEME + "://" + HOST;
  static final String ENTRY_DOCUMENT = "index.html";

  private static final String DIRECTORY = "app";

  /**
   * Types the platform's {@code URLConnection} table does not know. {@code .wasm} matters most: the Office preview
   * engines are loaded with {@code WebAssembly.instantiateStreaming}, which rejects any other type.
   */
  private static final Map<String, String> TYPES = new HashMap<>();

  static {
    TYPES.put("css", "text/css");
    TYPES.put("html", "text/html");
    TYPES.put("js", "text/javascript");
    TYPES.put("json", "application/json");
    TYPES.put("mjs", "text/javascript");
    TYPES.put("svg", "image/svg+xml");
    TYPES.put("ttf", "font/ttf");
    TYPES.put("wasm", "application/wasm");
    TYPES.put("webmanifest", "application/manifest+json");
    TYPES.put("woff2", "font/woff2");
  }

  private final AssetManager assets;

  AssetHost(AssetManager assets) {
    this.assets = assets;
  }

  /** Whether the request belongs to the embedded app rather than to the server the user connected to. */
  static boolean serves(WebResourceRequest request) {
    Uri url = request.getUrl();
    return SCHEME.equals(url.getScheme()) && HOST.equals(url.getHost());
  }

  /** Resolves a bundle URL, or answers 404 when the bundle holds no such file. */
  WebResourceResponse open(String rawPath) {
    String path = resolve(rawPath);
    if (path == null) return notFound();
    try (InputStream stream = assets.open(DIRECTORY + "/" + path)) {
      return new WebResourceResponse(type(path), encoding(path), 200, "OK", headers(path), stream);
    } catch (IOException missing) {
      return notFound();
    }
  }

  /**
   * Maps a URL path onto a file of the bundle. Client-side routes carry no extension and no file of their own, so they
   * fall back to the entry document the same way the service worker's navigateFallback does.
   */
  private String resolve(String rawPath) {
    String path = Uri.decode(rawPath);
    if (path.startsWith("/")) path = path.substring(1);
    if (path.isEmpty() || path.endsWith("/")) path = path + ENTRY_DOCUMENT;
    // The bundle is read-only content, so a traversal attempt has to stay inside it.
    if (path.contains("..")) return null;
    if (exists(path)) return path;
    if (!hasExtension(path) && exists(path + "/" + ENTRY_DOCUMENT)) return path + "/" + ENTRY_DOCUMENT;
    return null;
  }

  private boolean exists(String path) {
    try (InputStream stream = assets.open(DIRECTORY + "/" + path)) {
      return true;
    } catch (IOException missing) {
      return false;
    }
  }

  private static boolean hasExtension(String path) {
    return path.substring(path.lastIndexOf('/') + 1).indexOf('.') >= 0;
  }

  private static Map<String, String> headers(String path) {
    Map<String, String> headers = new HashMap<>();
    // A cached worker script or entry document would keep an upgraded APK on the previous build.
    if (path.equals("sw.js") || path.equals(ENTRY_DOCUMENT)) headers.put("Cache-Control", "no-cache");
    return headers;
  }

  private static String type(String path) {
    int dot = path.lastIndexOf('.');
    String known = TYPES.get(dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT));
    if (known != null) return known;
    String guessed = URLConnection.guessContentTypeFromName(path);
    return guessed == null ? "application/octet-stream" : guessed;
  }

  /** Only text carries a charset, so binary assets answer without one. */
  private static String encoding(String path) {
    String mime = type(path);
    if (mime.startsWith("text/")) return "utf-8";
    if (mime.equals("application/json") || mime.equals("application/manifest+json")) return "utf-8";
    return null;
  }

  private static WebResourceResponse notFound() {
    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
  }
}
