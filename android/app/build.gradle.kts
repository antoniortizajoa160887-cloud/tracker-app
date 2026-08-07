plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.trackerapp.dashboard"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.trackerapp.dashboard"
        minSdk = 24
        targetSdk = 34
        versionCode = 6
        versionName = "1.0.5"
    }

    signingConfigs {
        create("release") {
            // Committed on purpose: this is a self-signed key for sideload
            // distribution only (same trust model as the unsigned Windows
            // installer), not a Play Store production key. What matters is
            // that it's the SAME key on every build — Gradle's auto-generated
            // debug keystore is regenerated randomly on every fresh CI
            // runner, which silently made every prior release un-installable
            // as an "update" over the last one (Android refuses to install
            // an update whose signature doesn't match what's already there).
            storeFile = file("../keystore/release.keystore")
            storePassword = "trackerapp-sideload-2026"
            keyAlias = "unified-dashboard"
            keyPassword = "trackerapp-sideload-2026"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
