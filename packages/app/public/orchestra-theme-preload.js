;(function () {
  var key = "opencode-theme-id"
  // Desktop runs under Electron (window.electron is exposed by the
  // Electron preload before page scripts), web does not. Only desktop
  // defaults to sculk; a stored theme always wins on both. The served web UI
  // opts in to the same default with <meta name="orchestra-default-theme">
  // in index.html; a page without that tag keeps the legacy oc-2 default.
  var isDesktop = typeof window !== "undefined" && typeof window.electron !== "undefined"
  var metaDefault = document.querySelector('meta[name="orchestra-default-theme"]')
  var webDefault = (metaDefault && metaDefault.getAttribute("content")) || "oc-2"
  var themeId = localStorage.getItem(key) || (isDesktop ? "sculk" : webDefault)

  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"
  // Explicit text color: before ThemeProvider mounts, inherited text would
  // fall back to the browser default (black) on a dark v2 background —
  // black text on a black background. The v2 tokens switch on
  // [data-color-scheme] immediately, the non-v2 ones do not, so set the
  // color here too.
  document.documentElement.style.color = isDark ? "#eeeeee" : "#171717"

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#080808" : "#fafafa")

  if (themeId === "oc-2") return

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "orchestra-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
