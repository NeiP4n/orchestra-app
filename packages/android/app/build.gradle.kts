plugins {
    id("com.android.application")
}

// The web bundle is a build input, not a committed artifact: about 35 MB spread over ~1600 files, and it has to be
// built with this app's server mode. `-PwebBundleDir=<path>` points the build at an already built bundle instead.
val webBundleOverride = providers.gradleProperty("webBundleDir").orNull
val webBundle = webBundleOverride?.let(rootProject::file) ?: rootProject.file("../app/dist")
val bundleAssets = layout.buildDirectory.dir("generated/webAssets")
val releaseKeystore = providers.environmentVariable("ORCHESTRA_ANDROID_KEYSTORE")

// The version has to come from the source tree it was built from, so the About screen in the app and the APK agree.
val repositoryVersion =
    Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(rootProject.file("../package.json").readText())?.groupValues?.get(1)
        ?: error("No \"version\" field in ${rootProject.file("../package.json")}")

val buildWebApp by tasks.registering(Exec::class) {
    group = "build"
    description = "Builds the packages/app production bundle that the APK embeds."
    workingDir(rootProject.projectDirectory.dir("../app").asFile)
    commandLine("bun", "run", "build")
    // No preset server: the app has to open on its own connection form, which takes an address, a password, a pasted
    // pair link or a scanned QR code.
    environment("VITE_ORCHESTRA_SERVER_MODE", "none")
    // Same channel as the launcher icons copied from packages/desktop/icons/beta/android.
    environment("ORCHESTRA_CHANNEL", "beta")
    outputs.dir(webBundle)
}

val syncWebBundle by tasks.registering(Sync::class) {
    group = "build"
    description = "Copies the web bundle into the APK assets as assets/app."
    from(webBundle)
    into(bundleAssets)
    doFirst {
        if (!webBundle.asFile.resolve("index.html").isFile) {
            throw GradleException(
                "No web bundle in ${webBundle.asFile}. Run `bun run --cwd packages/app build`, " +
                    "or pass -PwebBundleDir=<path> to use a bundle built elsewhere.",
            )
        }
    }
    if (webBundleOverride == null) dependsOn(buildWebApp)
}

android {
    namespace = "com.nei4pn.opencodepp"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.nei4pn.opencodepp"
        minSdk = 26
        targetSdk = 36
        // 2.0.24 -> 20024, monotonic and readable. -PversionCode=N rebuilds one release without bumping the name.
        versionCode = providers.gradleProperty("versionCode").orNull?.toInt() ?: versionCodeOf(repositoryVersion)
        versionName = repositoryVersion
    }

    signingConfigs {
        // No keystore and no password lives in the tree. Without these variables the release stays unsigned.
        if (releaseKeystore.isPresent) {
            create("release") {
                storeFile = rootProject.file(releaseKeystore.get())
                storePassword = providers.environmentVariable("ORCHESTRA_ANDROID_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("ORCHESTRA_ANDROID_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("ORCHESTRA_ANDROID_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        // The debug build is signed by AGP with its own debug keystore, which is what internal installs want.
        release {
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    sourceSets.getByName("main") {
        assets.srcDir(bundleAssets)
    }
}

tasks.named("preBuild").configure {
    dependsOn(syncWebBundle)
}

/** Turns a semver name into the integer the store requires: 2.0.24 becomes 20024. */
fun versionCodeOf(version: String): Int {
    val parts = version.split(".")
    val major = parts.getOrElse(0) { "0" }.toIntOrNull() ?: 0
    val minor = parts.getOrElse(1) { "0" }.toIntOrNull() ?: 0
    val patch = parts.getOrElse(2) { "0" }.toIntOrNull() ?: 0
    return major * 10_000 + minor * 100 + patch
}
