plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.raven.mobilenative.plugin"
    compileSdk = 36
    defaultConfig { minSdk = 26; consumerProguardFiles("consumer-rules.pro") }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}

// The WebRTC native libraries staged by the Rust build. Added through the variant API:
// with AGP 9, android.sourceSets in a library hands back a type its Kotlin DSL cannot cast.
val ravenNativeLibs = providers.gradleProperty("ravenNativeLibs").get()
androidComponents {
    onVariants { variant -> variant.sources.jniLibs?.addStaticSourceDirectory(ravenNativeLibs) }
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation(files(providers.gradleProperty("ravenWebrtcJar").get()))
}
