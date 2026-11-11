;(function () {
  var key = "opencode-theme-id"
  // A saved theme wins. Fresh web and desktop installs share the Sculk default.
  var savedTheme = localStorage.getItem(key)
  var themeId = savedTheme || "sculk"

  var scheme = localStorage.getItem("opencode-color-scheme") || "dark"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  // Generated from TUI Sculk by script/sculk-web-theme.ts.
  var sculkBoot = JSON.parse(
    '{"light":{"background":"#f0fafa","color":"#0c2a30"},"dark":{"background":"#050f15","color":"#bff7f2"}}',
  )
  var boot =
    themeId === "sculk"
      ? sculkBoot[mode]
      : { background: isDark ? "#080808" : "#fafafa", color: isDark ? "#eeeeee" : "#171717" }

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = boot.background
  // Explicit text color: before ThemeProvider mounts, inherited text would
  // fall back to the browser default (black) on a dark v2 background —
  // black text on a black background. The v2 tokens switch on
  // [data-color-scheme] immediately, the non-v2 ones do not, so set the
  // color here too.
  document.documentElement.style.color = boot.color

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", boot.background)

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
