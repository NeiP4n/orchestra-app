// Boot watchdog for the Orchestra web shell.
//
// The app bundle is a set of hashed files: when the shell references chunks
// the server does not have (stale dist, interrupted rebuild, stale cache),
// the entry script never runs and the page stays an empty #root — a white
// screen with no words. This file is a plain, unhashed script that runs
// before the entry module: it keeps the loading state, and if the app has
// not mounted shortly after load — or a script chunk fails to load — it
// replaces the empty page with an error that says what happened and what to
// do.
//
// It must not depend on anything else: no bundle, no CSS file, no i18n
// runtime. Inline styles only. The copy is English: the error strings the
// app itself shows (`error.page.*`) have no Chinese translation either, so
// a Chinese browser sees the same English here as it would after mount.
(function () {
  var root = document.getElementById("root")
  if (!root) return

  var TIMEOUT_MS = 10000
  var failed = []

  function mounted() {
    return root.dataset.opencodeRendered !== undefined
  }

  function entryRan() {
    return root.dataset.opencodeMounted !== undefined
  }

  function showError() {
    if (mounted() || root.dataset.bootErrorShown !== undefined) return
    root.dataset.bootErrorShown = ""
    var detail = entryRan()
      ? "Orchestra started, but the app did not finish loading."
      : "Orchestra did not load: the app files failed to load."
    var failedList = failed.length
      ? "Failed to load:\n" + failed.slice(0, 5).join("\n") + (failed.length > 5 ? "\n…" : "")
      : ""
    root.textContent = ""
    var page = document.createElement("div")
    page.style.cssText =
      "font-family:var(--font-family-mono,monospace);max-width:560px;margin:15vh auto;padding:0 16px;color:#222"
    var heading = document.createElement("h1")
    heading.style.cssText = "font-size:20px;line-height:1.3;margin:0 0 8px"
    heading.textContent = "Orchestra did not load"
    var text = document.createElement("p")
    text.style.cssText = "line-height:1.5;margin:0 0 8px"
    text.textContent = detail
    var hint = document.createElement("p")
    hint.style.cssText = "line-height:1.5;margin:0 0 16px"
    hint.textContent =
      "Reload the page. If that does not help, clear the browser cache for this site (or open it in a private window) and restart the server — after a git pull, rebuild the app first with `bun run build` in packages/app. If the app itself is broken, open the recovery chat."
    var reload = document.createElement("button")
    reload.textContent = "Reload"
    reload.style.cssText = "font:inherit;padding:8px 16px;cursor:pointer;margin-right:12px"
    reload.addEventListener("click", function () {
      location.reload()
    })
    var recovery = document.createElement("a")
    recovery.textContent = "Open recovery chat"
    recovery.href = "/recovery"
    recovery.style.cssText = "font:inherit;color:#2563eb"
    page.append(heading, text)
    if (failedList) {
      var failedNode = document.createElement("p")
      failedNode.style.cssText =
        "line-height:1.5;margin:0 0 16px;white-space:pre-wrap;word-break:break-all;font-size:13px;color:#555"
      failedNode.textContent = failedList
      page.append(failedNode)
    }
    page.append(hint, reload, recovery)
    root.append(page)
  }

  function isAppChunk(url) {
    return (
      /(?:\.m?js|\.css)(?:[?#]|$)/.test(url) || url.indexOf("/_assets/") !== -1 || url.indexOf("/assets/") !== -1
    )
  }

  // Resource errors do not bubble, so listen in the capture phase. A failed
  // script chunk before mount is fatal — show the error at once instead of
  // waiting for the timeout. A failed stylesheet is recorded and only
  // matters if the app never mounts.
  window.addEventListener(
    "error",
    function (event) {
      var target = event.target
      if (!target || target === window || (target.tagName !== "SCRIPT" && target.tagName !== "LINK")) return
      var url = target.src || target.href || ""
      if (!url || !isAppChunk(url)) return
      failed.push(url)
      if (target.tagName === "SCRIPT" && !mounted()) showError()
    },
    true,
  )

  // A chunk that fails as a dynamic import rejects instead of erroring.
  window.addEventListener("unhandledrejection", function (event) {
    if (mounted()) return
    var reason = event.reason && event.reason.message ? String(event.reason.message) : ""
    if (reason) failed.push(reason)
    showError()
  })

  setTimeout(function () {
    if (!mounted()) showError()
  }, TIMEOUT_MS)
})()
