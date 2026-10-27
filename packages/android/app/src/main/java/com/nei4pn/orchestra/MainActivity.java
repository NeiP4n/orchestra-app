package com.nei4pn.orchestra;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.ArrayList;
import java.util.List;

/**
 * The whole app: one WebView showing the web client that ships inside the APK.
 *
 * <p>There is no native UI. The user adds their server on the app's own full-screen connection form, so every string a
 * user reads comes from the bundle; the only literal here is the launcher label in the manifest.
 */
public final class MainActivity extends Activity {

  private static final int MEDIA_PERMISSION_REQUEST = 1;

  private AssetHost assets;
  private WebView web;
  private PermissionRequest awaitingPermission;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    assets = new AssetHost(getAssets());
    // The production bundle registers a service worker, and the worker fetches the precache itself. Without a client
    // to answer those fetches from assets, registration fails and nothing is cached.
    ServiceWorkerController.getInstance()
        .setServiceWorkerClient(new ServiceWorkerClient() {
          @Override
          public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
            // The worker also fetches from the server the user connected to; those requests go to the network.
            if (!AssetHost.serves(request)) return null;
            return assets.open(request.getUrl().getPath());
          }
        });

    web = new WebView(this);
    configure(web);
    setContentView(web, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    // Restoring keeps the session across a process death, loading gives a first run its own fresh document.
    if (savedInstanceState == null) web.loadUrl(AssetHost.ORIGIN + "/" + AssetHost.ENTRY_DOCUMENT);
    else web.restoreState(savedInstanceState);
  }

  private void configure(WebView target) {
    WebSettings settings = target.getSettings();
    settings.setJavaScriptEnabled(true);
    // The connected servers and their credentials live in localStorage.
    settings.setDomStorageEnabled(true);
    // The bundle arrives through the interceptor, so the WebView never needs the file or content bridges.
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    // The page itself is an https document while the user's own `orchestra serve` is usually plain http on the LAN.
    // Without this every request to that server is refused as mixed content and the app cannot connect at all.
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

    target.setWebViewClient(new BundleClient());
    target.setWebChromeClient(new MediaClient());
    // A pair link is redeemed against the user's own server, so that server has to be able to set its session cookie.
    CookieManager.getInstance().setAcceptThirdPartyCookies(target, true);

    if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      WebView.setWebContentsDebuggingEnabled(true);
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle outState) {
    super.onSaveInstanceState(outState);
    web.saveState(outState);
  }

  @Override
  protected void onResume() {
    super.onResume();
    web.onResume();
  }

  @Override
  protected void onPause() {
    super.onPause();
    web.onPause();
  }

  @Override
  protected void onDestroy() {
    web.destroy();
    super.onDestroy();
  }

  /**
   * Back walks the web history and only leaves the app from the first page. The app never opts into predictive back,
   * so the platform still routes the gesture and the navigation bar button here.
   */
  @Override
  @SuppressWarnings("deprecation")
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  private void openExternally(Uri url) {
    Intent intent = new Intent(Intent.ACTION_VIEW, url);
    if (getPackageManager().resolveActivity(intent, 0) == null) return;
    startActivity(intent);
  }

  /** Serves the bundle and sends every other navigation to the browser. */
  private final class BundleClient extends WebViewClient {

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
      // The app's own requests to the user's server are ordinary network calls.
      if (!AssetHost.serves(request)) return null;
      return assets.open(request.getUrl().getPath());
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      if (AssetHost.serves(request)) return false;
      openExternally(request.getUrl());
      return true;
    }
  }

  /**
   * Hands getUserMedia the camera the QR scanner needs, and routes the link target of {@code window.open} to the
   * browser, because a WebView has no second window to open it in.
   */
  private final class MediaClient extends WebChromeClient {

    @Override
    public void onPermissionRequest(PermissionRequest request) {
      List<String> missing = new ArrayList<>();
      for (String resource : request.getResources()) {
        String permission = mediaPermission(resource);
        // Anything the app does not declare in the manifest stays refused; granting it would throw.
        if (permission == null) {
          request.deny();
          return;
        }
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED && !missing.contains(permission)) {
          missing.add(permission);
        }
      }
      if (missing.isEmpty()) {
        request.grant(request.getResources());
        return;
      }
      // The user is asked here, at the moment the app actually asks, not at install time.
      awaitingPermission = request;
      requestPermissions(missing.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
      if (awaitingPermission == request) awaitingPermission = null;
    }

    @Override
    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
      WebView capture = new WebView(view.getContext());
      capture.setWebViewClient(new WebViewClient() {
        @Override
        public boolean shouldOverrideUrlLoading(WebView probe, WebResourceRequest request) {
          openExternally(request.getUrl());
          return true;
        }
      });
      ((WebView.WebViewTransport) resultMsg.obj).setWebView(capture);
      resultMsg.sendToTarget();
      return true;
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode != MEDIA_PERMISSION_REQUEST) return;
    PermissionRequest request = awaitingPermission;
    awaitingPermission = null;
    if (request == null) return;
    for (int result : grantResults) {
      if (result != PackageManager.PERMISSION_GRANTED) {
        request.deny();
        return;
      }
    }
    request.grant(request.getResources());
  }

  private static String mediaPermission(String resource) {
    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
    return null;
  }
}
